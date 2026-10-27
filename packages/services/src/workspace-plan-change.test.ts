import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { createBillingCatalog, createInMemoryWorkspaceBillingStore, createWorkspaceBillingModule, type WorkspaceBillingProvider } from "./workspace-billing.service";
import type { PlanChangeSubscription } from "./workspace-plan-change";
import { createStripePlanChangeProvider, normalizeStripePlanChange } from "./workspace-plan-change-stripe";

const catalog = createBillingCatalog({
  basePrices: (["creator", "pro", "business"] as const).flatMap((tier) => (["monthly", "annual"] as const).map((interval) => ({ tier, interval, priceId: `${tier}_${interval}` }))),
  seatPrices: (["monthly", "annual"] as const).map((interval) => ({ interval, priceId: `seat_${interval}` })),
  worker: { batchSize: 25, concurrency: 4, leaseMs: 60_000, providerDeadlineMs: 10_000, providerCallBudget: 4 },
});

function fixture(price = "pro_monthly", desiredAdditionalSeats = 0) {
  const workspaceId = randomUUID();
  const actorUserId = randomUUID();
  const now = { value: new Date("2026-10-27T12:00:00.000Z") };
  const source: PlanChangeSubscription = { id: "sub_current", customerId: "cus_workspace", status: "active", items: [{ id: "si_base", priceId: price, quantity: 1 }], periodStart: Date.parse("2026-10-01T00:00:00Z") / 1000, periodEnd: Date.parse("2026-11-01T00:00:00Z") / 1000, cancelAtPeriodEnd: false, pending: null, schedule: null };
  const store = createInMemoryWorkspaceBillingStore([{ workspaceId, ownerUserId: actorUserId, personal: true, hasNonOwnerMembers: desiredAdditionalSeats > 0, providerCustomerId: source.customerId, pricingTier: catalog.basePrice(price)!.tier, status: "active", desiredAdditionalSeats }]);
  let mutations = 0;
  let ownership: "verified" | "missing_metadata" = "verified";
  const provider: WorkspaceBillingProvider = {
    verifyDelivery: () => { throw new Error("unused"); },
    retrieveCurrentState: async () => ({ customerId: source.customerId, ownership: ownership === "verified" ? { kind: "verified", workspaceId } : { kind: "missing_metadata" }, subscriptions: [{ id: source.id, status: source.status, items: source.items, createdAt: new Date(0), effectiveAt: now.value, currentPeriodEnd: new Date(source.periodEnd * 1000), trialEnd: null, cancelAtPeriodEnd: source.cancelAtPeriodEnd, planChange: source.pending ? { state: "pending_payment", tier: "business", interval: "monthly", effectiveAt: null } : null }] }),
    retrievePlanChangeSubscription: async () => structuredClone(source),
    previewPlanChange: async () => ({ amountDue: 745, currency: "usd" }),
    applyPlanChange: async (input) => {
      mutations++;
      if (input.kind === "scheduled") {
        source.schedule = { id: "sched_owned", owned: true, quoteId: input.quoteId, items: input.items, effectiveAt: source.periodEnd };
        return { kind: "scheduled", effectiveAt: new Date(source.periodEnd * 1000).toISOString() };
      }
      source.pending = { items: input.items, paymentUrl: "https://invoice.stripe.com/i/test" };
      return { kind: "pending_payment", paymentUrl: source.pending.paymentUrl!, effectiveAt: null };
    },
    cancelScheduledPlanChange: async () => { source.schedule = null; },
    cancelPendingPlanChange: async () => { source.pending = null; },
  };
  const module = () => createWorkspaceBillingModule({ catalog, store, provider, clock: { now: () => now.value }, diagnostics: { record: () => undefined } });
  const billing = module();
  const input = { workspaceId, actorUserId, clientIdempotencyKey: randomUUID(), targetTier: "business" as const, interval: "monthly" as const };
  return { workspaceId, actorUserId, now, source, store, provider, billing, module, input, mutations: () => mutations, loseOwnership: () => { ownership = "missing_metadata"; } };
}

function scheduleRecoveryFixture() {
  const f = fixture();
  const raw = {
    id: f.source.id, customer: f.source.customerId, metadata: { workspaceId: f.workspaceId }, status: "active", collection_method: "charge_automatically", cancel_at_period_end: false, pending_update: null, schedule: null,
    items: { has_more: false, data: f.source.items.map((item) => ({ id: item.id, price: { id: item.priceId }, quantity: item.quantity, current_period_start: f.source.periodStart, current_period_end: f.source.periodEnd })) },
    latest_invoice: { id: "invoice_paid", status: "paid", hosted_invoice_url: "https://invoice.stripe.com/i/paid" },
  } as unknown as Stripe.Subscription;
  const phase = {
    start_date: f.source.periodStart, end_date: f.source.periodEnd,
    items: [{ price: "pro_monthly", quantity: 1, metadata: {}, billing_thresholds: null, discounts: [], tax_rates: [] }],
    add_invoice_items: [], automatic_tax: { enabled: false, liability: null }, billing_cycle_anchor: "automatic", billing_thresholds: null, collection_method: "charge_automatically", currency: "usd", default_payment_method: "pm_paid", default_tax_rates: [], description: null, discounts: [], invoice_settings: null, metadata: {}, application_fee_percent: null, on_behalf_of: null, proration_behavior: "create_prorations", transfer_data: null, trial_end: null,
  } as unknown as Stripe.SubscriptionSchedule.Phase;
  const creates = new Map<string, Stripe.SubscriptionSchedule>();
  const createKeys: string[] = [];
  let updateCalls = 0;
  let failFirstBind = true;
  const stripe = {
    subscriptions: { retrieve: async () => structuredClone(raw) },
    subscriptionSchedules: {
      create: async (_input: unknown, options: Stripe.RequestOptions) => {
        const key = options.idempotencyKey!;
        createKeys.push(key);
        const previous = creates.get(key);
        if (previous) return structuredClone(previous);
        if (raw.schedule) throw Object.assign(new Error("Subscription already has another schedule"), { type: "StripeInvalidRequestError" });
        const schedule = { id: "schedule_created_once", metadata: {}, status: "active", current_phase: { start_date: phase.start_date, end_date: phase.end_date }, phases: [structuredClone(phase)] } as unknown as Stripe.SubscriptionSchedule;
        raw.schedule = schedule;
        creates.set(key, structuredClone(schedule));
        return structuredClone(schedule);
      },
      update: async (_id: string, input: Stripe.SubscriptionScheduleUpdateParams) => {
        updateCalls++;
        if (failFirstBind) { failFirstBind = false; throw new Error("Response lost before binding the schedule"); }
        const schedule = raw.schedule as Stripe.SubscriptionSchedule;
        schedule.metadata = input.metadata as Stripe.Metadata;
        schedule.phases = input.phases!.map((value) => ({ ...structuredClone(phase), ...value, end_date: value.end_date ?? Number(value.start_date) + 30 * 86400 })) as unknown as Stripe.SubscriptionSchedule.Phase[];
        return structuredClone(schedule);
      },
      release: async () => { throw new Error("Recovery must not release the attached schedule"); },
    },
  } as unknown as Stripe;
  Object.assign(f.provider, createStripePlanChangeProvider(stripe, catalog));
  f.provider.retrieveCurrentState = async () => ({ customerId: f.source.customerId, ownership: { kind: "verified", workspaceId: f.workspaceId }, subscriptions: [{ id: raw.id, status: raw.status, items: raw.items.data.map((item) => ({ id: item.id, priceId: item.price.id, quantity: item.quantity ?? 1 })), createdAt: new Date(0), effectiveAt: f.now.value, currentPeriodEnd: new Date(f.source.periodEnd * 1000), trialEnd: null, cancelAtPeriodEnd: false, planChange: normalizeStripePlanChange(raw, catalog) }] });
  return { ...f, raw, creates, createKeys, updateCalls: () => updateCalls };
}

describe("Workspace plan changes", () => {
  test("a quote cannot charge or grant access; failed or unfinished payment keeps the verified plan", async () => {
    const f = fixture();
    const { quote } = await f.billing.previewPlanChange(f.input);
    expect(quote).toMatchObject({ kind: "immediate", amountDue: 745, tier: "business" });
    expect(f.mutations()).toBe(0);
    expect((await f.billing.readBillingState(f.workspaceId)).plan).toBe("pro");
    const result = await f.billing.confirmPlanChange({ ...f.input, quoteId: quote.id });
    expect(result.kind).toBe("pending_payment");
    await f.billing.reconcileCurrentState(f.workspaceId);
    expect((await f.billing.readBillingState(f.workspaceId)).plan).toBe("pro");
    expect((await f.billing.readBillingState(f.workspaceId)).planChange?.state).toBe("pending_payment");
    f.source.items = f.source.pending!.items;
    f.source.pending = null;
    await f.billing.reconcileCurrentState(f.workspaceId);
    expect((await f.billing.readBillingState(f.workspaceId)).plan).toBe("business");
  });

  test("downgrades preserve current access until the paid period ends", async () => {
    const f = fixture();
    const { quote } = await f.billing.previewPlanChange({ ...f.input, targetTier: "creator" });
    expect(quote).toMatchObject({ kind: "scheduled", amountDue: 0, effectiveAt: "2026-11-01T00:00:00.000Z" });
    await f.billing.confirmPlanChange({ ...f.input, quoteId: quote.id });
    expect((await f.billing.readBillingState(f.workspaceId)).plan).toBe("pro");
    expect(f.source.items[0]?.priceId).toBe("pro_monthly");
    expect(f.source.schedule?.items[0]?.priceId).toBe("creator_monthly");
  });

  test.each([ ["pro_annual", "pro", "monthly", "scheduled"], ["pro_monthly", "pro", "annual", "immediate"], ["creator_annual", "pro", "monthly", "immediate"], ["business_monthly", "pro", "annual", "scheduled"] ] as const)("%s to %s/%s is %s", async (source, tier, interval, kind) => {
    const f = fixture(source);
    expect((await f.billing.previewPlanChange({ ...f.input, targetTier: tier, interval })).quote.kind).toBe(kind);
  });

  test("repeated previews and confirms reuse their durable operation", async () => {
    const f = fixture();
    const first = await f.billing.previewPlanChange(f.input);
    expect(await f.billing.previewPlanChange(f.input)).toEqual(first);
    await f.billing.confirmPlanChange({ ...f.input, quoteId: first.quote.id });
    expect((await f.billing.confirmPlanChange({ ...f.input, quoteId: first.quote.id })).kind).toBe("pending_payment");
    expect(f.mutations()).toBe(1);
    await expect(f.billing.previewPlanChange({ ...f.input, targetTier: "creator" })).rejects.toMatchObject({ code: "plan_change_conflict" });
  });

  test("a lost response after Stripe accepts the upgrade is recovered without charging twice", async () => {
    const f = fixture();
    const apply = f.provider.applyPlanChange!;
    f.provider.applyPlanChange = async (input) => { await apply(input); throw new Error("response lost"); };
    const { quote } = await f.billing.previewPlanChange(f.input);
    await expect(f.billing.confirmPlanChange({ ...f.input, quoteId: quote.id })).rejects.toThrow("response lost");
    expect((await f.billing.confirmPlanChange({ ...f.input, quoteId: quote.id })).kind).toBe("pending_payment");
    expect(f.mutations()).toBe(1);
  });

  test("source changes and expired quotes require a fresh review", async () => {
    const f = fixture();
    const { quote } = await f.billing.previewPlanChange(f.input);
    f.source.items[0]!.priceId = "creator_monthly";
    await expect(f.billing.confirmPlanChange({ ...f.input, quoteId: quote.id })).rejects.toMatchObject({ code: "plan_change_conflict" });
    f.source.items[0]!.priceId = "pro_monthly";
    f.now.value = new Date("2026-10-27T12:11:00Z");
    await expect(f.billing.confirmPlanChange({ ...f.input, quoteId: quote.id })).rejects.toMatchObject({ code: "plan_change_quote_expired" });
    expect(f.mutations()).toBe(0);
  });

  test("a changed payable amount requires another owner review before any charge", async () => {
    const f = fixture();
    const { quote } = await f.billing.previewPlanChange(f.input);
    f.provider.previewPlanChange = async () => ({ amountDue: 1400, currency: "usd" });
    await expect(f.billing.confirmPlanChange({ ...f.input, quoteId: quote.id })).rejects.toMatchObject({ code: "plan_change_conflict" });
    expect(f.mutations()).toBe(0);
  });

  test("another owner, unknown customer ownership, and a foreign schedule cannot mutate billing", async () => {
    const f = fixture();
    await expect(f.billing.previewPlanChange({ ...f.input, actorUserId: randomUUID() })).rejects.toMatchObject({ code: "billing_forbidden" });
    f.source.schedule = { id: "sched_external", owned: false, items: [], effectiveAt: f.source.periodEnd };
    await expect(f.billing.previewPlanChange(f.input)).rejects.toMatchObject({ code: "plan_change_schedule_conflict" });
    f.source.schedule = null;
    f.loseOwnership();
    await expect(f.billing.previewPlanChange(f.input)).rejects.toMatchObject({ code: "customer_identity_conflict" });
    expect(f.mutations()).toBe(0);
  });

  test("Business quotes include committed seats with the selected interval", async () => {
    const f = fixture("pro_monthly", 2);
    const { quote } = await f.billing.previewPlanChange({ ...f.input, interval: "annual" });
    const stored = await f.store.readPlanChangeQuote({ workspaceId: f.workspaceId, id: quote.id });
    expect(stored?.targetItems).toEqual([{ id: "si_base", priceId: "business_annual", quantity: 1 }, { priceId: "seat_annual", quantity: 2 }]);
  });

  test("a concurrent confirmation is refused while the first provider mutation is in flight", async () => {
    const f = fixture();
    const first = await f.billing.previewPlanChange(f.input);
    const second = await f.billing.previewPlanChange({ ...f.input, clientIdempotencyKey: randomUUID(), targetTier: "creator" });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const apply = f.provider.applyPlanChange!;
    f.provider.applyPlanChange = async (input) => { entered(); await held; return apply(input); };
    const confirmation = f.billing.confirmPlanChange({ ...f.input, quoteId: first.quote.id });
    await started;
    await expect(f.billing.confirmPlanChange({ ...f.input, quoteId: second.quote.id })).rejects.toMatchObject({ code: "plan_change_busy" });
    release();
    await confirmation;
    expect(f.mutations()).toBe(1);
  });

  test("keeping the current plan releases only the scheduled change", async () => {
    const f = fixture();
    f.source.schedule = { id: "sched_owned", owned: true, items: [{ priceId: "creator_monthly", quantity: 1 }], effectiveAt: f.source.periodEnd };
    await f.billing.cancelScheduledPlanChange(f.input);
    expect(f.source.schedule).toBeNull();
    expect(f.source.items[0]?.priceId).toBe("pro_monthly");
    expect(f.mutations()).toBe(0);
  });

  test("a new worker finishes an unbound schedule after the browser forgets its quote", async () => {
    const f = scheduleRecoveryFixture();
    const { quote } = await f.billing.previewPlanChange({ ...f.input, targetTier: "creator" });
    // A lost response is transient: the owner sees a retryable failure and the worker finishes it.
    await expect(f.billing.confirmPlanChange({ ...f.input, quoteId: quote.id })).rejects.toThrow("Response lost before binding the schedule");
    expect((f.raw.schedule as Stripe.SubscriptionSchedule).metadata).toEqual({});
    await expect(f.billing.previewPlanChange({ ...f.input, clientIdempotencyKey: randomUUID(), targetTier: "creator" })).rejects.toMatchObject({ code: "plan_change_busy" });
    let nestedClaims = 0;
    let claimReleases = 0;
    const claim = f.store.claimAccount;
    const release = f.store.releasePlanChangeClaim;
    f.store.claimAccount = async (input) => { nestedClaims++; return claim(input); };
    f.store.releasePlanChangeClaim = async (input) => { claimReleases++; return release(input); };
    const worker = f.module();
    expect(await worker.reconcileDueAccounts()).toMatchObject({ claimed: 1, reconciled: 1, unresolved: 0 });
    expect(f.creates.size).toBe(1);
    expect(f.createKeys).toEqual([`narriflow_plan_schedule_${quote.id}`, `narriflow_plan_schedule_${quote.id}`]);
    expect(f.updateCalls()).toBe(2);
    expect(nestedClaims).toBe(0);
    expect(claimReleases).toBe(0);
    expect((f.raw.schedule as Stripe.SubscriptionSchedule).metadata).toMatchObject({ app: "narriflow", workspaceId: f.workspaceId, quoteId: quote.id });
    expect((await f.store.readPlanChangeQuote({ workspaceId: f.workspaceId, id: quote.id }))?.phase).toBe("submitted");
    expect(await f.store.readConfirmingPlanChangeQuote(f.workspaceId)).toBeNull();
    expect(await worker.readBillingState(f.workspaceId)).toMatchObject({ plan: "pro", planChange: { state: "scheduled", tier: "creator" } });
  });

  test("worker recovery cannot adopt an unrelated schedule with a different provider identity", async () => {
    const f = scheduleRecoveryFixture();
    const { quote } = await f.billing.previewPlanChange({ ...f.input, targetTier: "creator" });
    await expect(f.billing.confirmPlanChange({ ...f.input, quoteId: quote.id })).rejects.toThrow("Response lost before binding the schedule");
    const foreign = { ...(f.raw.schedule as Stripe.SubscriptionSchedule), id: "schedule_foreign", metadata: { app: "another_app", workspaceId: f.workspaceId } };
    f.raw.schedule = foreign;
    const worker = f.module();
    // The confirmed change ends without touching the foreign schedule, and entitlements still reconcile.
    expect(await worker.reconcileDueAccounts()).toMatchObject({ claimed: 1, reconciled: 1, unresolved: 0 });
    expect((f.raw.schedule as Stripe.SubscriptionSchedule).id).toBe("schedule_foreign");
    expect((f.raw.schedule as Stripe.SubscriptionSchedule).metadata).toEqual(foreign.metadata);
    expect(f.updateCalls()).toBe(1);
    expect((await f.store.readPlanChangeQuote({ workspaceId: f.workspaceId, id: quote.id }))?.phase).toBe("expired");
    expect(await worker.readBillingState(f.workspaceId)).toMatchObject({ plan: "pro", health: "current" });
  });

  test("a worker expires an unapplied immediate attempt instead of charging an old quote", async () => {
    const f = fixture();
    let applyCalls = 0;
    f.provider.applyPlanChange = async () => { applyCalls++; throw new Error("Provider unavailable before update"); };
    const { quote } = await f.billing.previewPlanChange(f.input);
    await expect(f.billing.confirmPlanChange({ ...f.input, quoteId: quote.id })).rejects.toThrow("Provider unavailable");
    f.now.value = new Date("2026-10-27T12:11:00Z");
    const worker = f.module();
    expect(await worker.reconcileDueAccounts()).toMatchObject({ claimed: 1, reconciled: 1 });
    expect(applyCalls).toBe(1);
    expect((await f.store.readPlanChangeQuote({ workspaceId: f.workspaceId, id: quote.id }))?.phase).toBe("expired");
    expect(await f.store.readConfirmingPlanChangeQuote(f.workspaceId)).toBeNull();
    expect((await worker.readBillingState(f.workspaceId)).plan).toBe("pro");
    expect((await worker.previewPlanChange({ ...f.input, clientIdempotencyKey: randomUUID() })).quote.id).not.toBe(quote.id);
  });

  test("a worker revalidates the payable amount before retrying a confirmed upgrade", async () => {
    const f = fixture();
    let applyCalls = 0;
    f.provider.applyPlanChange = async () => { applyCalls++; throw new Error("Provider unavailable before update"); };
    const { quote } = await f.billing.previewPlanChange(f.input);
    await expect(f.billing.confirmPlanChange({ ...f.input, quoteId: quote.id })).rejects.toThrow("Provider unavailable");
    f.provider.previewPlanChange = async () => ({ amountDue: 1400, currency: "usd" });
    // The owner reviewed a different amount, so the change ends instead of charging it.
    expect(await f.module().reconcileDueAccounts()).toMatchObject({ claimed: 1, reconciled: 1, unresolved: 0 });
    expect(applyCalls).toBe(1);
    expect((await f.store.readPlanChangeQuote({ workspaceId: f.workspaceId, id: quote.id }))?.phase).toBe("expired");
    expect((await f.store.readProjection(f.workspaceId))?.health).toBe("current");
  });

  test("a worker ends an unfinished attempt whose source period changed and keeps the provider's plan", async () => {
    const f = fixture();
    f.provider.applyPlanChange = async () => { throw new Error("Provider unavailable before update"); };
    const { quote } = await f.billing.previewPlanChange({ ...f.input, targetTier: "creator" });
    await expect(f.billing.confirmPlanChange({ ...f.input, quoteId: quote.id })).rejects.toThrow("Provider unavailable");
    f.source.periodEnd += 30 * 86400;
    expect(await f.module().reconcileDueAccounts()).toMatchObject({ claimed: 1, reconciled: 1, unresolved: 0 });
    expect((await f.store.readPlanChangeQuote({ workspaceId: f.workspaceId, id: quote.id }))?.phase).toBe("expired");
    expect((await f.store.readProjection(f.workspaceId))?.pricingTier).toBe("pro");
    expect((await f.store.readProjection(f.workspaceId))?.health).toBe("current");
  });

  test("an owner can finish or abandon an upgrade that is awaiting payment", async () => {
    const f = fixture();
    const { quote } = await f.billing.previewPlanChange(f.input);
    expect((await f.billing.confirmPlanChange({ ...f.input, quoteId: quote.id })).kind).toBe("pending_payment");
    expect(await f.billing.readPendingPlanChangePayment(f.input)).toEqual({ url: "https://invoice.stripe.com/i/test" });
    await expect(f.billing.readPendingPlanChangePayment({ ...f.input, actorUserId: randomUUID() })).rejects.toMatchObject({ code: "billing_forbidden" });
    // "Keep current plan" voids the pending invoice; the subscription keeps its paid plan.
    expect(await f.billing.cancelScheduledPlanChange(f.input)).toEqual({ kind: "unchanged", effectiveAt: null });
    expect(f.source.pending).toBeNull();
    expect(f.source.items[0]?.priceId).toBe("pro_monthly");
    expect(await f.billing.readPendingPlanChangePayment(f.input)).toEqual({ url: null });
  });

  test("a stuck confirming attempt never blocks applying a provider cancellation", async () => {
    const f = fixture();
    f.provider.applyPlanChange = async () => { throw new Error("Provider unavailable before update"); };
    const { quote } = await f.billing.previewPlanChange({ ...f.input, targetTier: "creator" });
    await expect(f.billing.confirmPlanChange({ ...f.input, quoteId: quote.id })).rejects.toThrow("Provider unavailable");
    f.source.status = "canceled";
    f.now.value = new Date("2026-10-27T18:30:00Z");
    await f.module().reconcileDueAccounts();
    expect((await f.store.readProjection(f.workspaceId))?.pricingTier).toBe("free");
    expect(await f.store.readConfirmingPlanChangeQuote(f.workspaceId)).toBeNull();
  });

  test("a stuck immediate attempt expires even when the subscription is now cancelling", async () => {
    const f = fixture();
    f.provider.applyPlanChange = async () => { throw new Error("Provider unavailable before update"); };
    const { quote } = await f.billing.previewPlanChange(f.input);
    await expect(f.billing.confirmPlanChange({ ...f.input, quoteId: quote.id })).rejects.toThrow("Provider unavailable");
    f.source.cancelAtPeriodEnd = true;
    f.now.value = new Date("2026-10-27T12:11:00Z");
    expect(await f.module().reconcileDueAccounts()).toMatchObject({ claimed: 1, reconciled: 1 });
    expect((await f.store.readPlanChangeQuote({ workspaceId: f.workspaceId, id: quote.id }))?.phase).toBe("expired");
  });

  test("a worker observes an already pending payment without repeating the accepted upgrade", async () => {
    const f = fixture();
    const apply = f.provider.applyPlanChange!;
    f.provider.applyPlanChange = async (input) => { await apply(input); throw new Error("Response lost after creating the invoice"); };
    const { quote } = await f.billing.previewPlanChange(f.input);
    await expect(f.billing.confirmPlanChange({ ...f.input, quoteId: quote.id })).rejects.toThrow("Response lost");
    f.now.value = new Date("2026-10-27T12:11:00Z");
    expect(await f.module().reconcileDueAccounts()).toMatchObject({ claimed: 1, reconciled: 1 });
    expect(f.mutations()).toBe(1);
    expect((await f.store.readPlanChangeQuote({ workspaceId: f.workspaceId, id: quote.id }))?.phase).toBe("submitted");
    expect((await f.billing.readBillingState(f.workspaceId)).plan).toBe("pro");
  });
});
