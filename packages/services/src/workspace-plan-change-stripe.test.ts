import { describe, expect, test } from "bun:test";
import type Stripe from "stripe";
import { createBillingCatalog } from "./workspace-billing.service";
import { createStripePlanChangeProvider, normalizeStripePlanChange } from "./workspace-plan-change-stripe";
import type { PlanChangeItem } from "./workspace-plan-change";

const catalog = createBillingCatalog({
  basePrices: ["creator", "pro", "business"].flatMap((tier) => ["monthly", "annual"].map((interval) => ({ priceId: `${tier}_${interval}`, tier, interval }))) as Parameters<typeof createBillingCatalog>[0]["basePrices"],
  seatPrices: [{ priceId: "seat_monthly", interval: "monthly" }, { priceId: "seat_annual", interval: "annual" }],
  worker: { batchSize: 1, concurrency: 1, leaseMs: 60_000, providerDeadlineMs: 10_000, providerCallBudget: 10 },
});
const workspaceId = "workspace";
const start = 1_790_000_000;
const end = start + 30 * 24 * 60 * 60;
const sourceItems: PlanChangeItem[] = [{ id: "base_item", priceId: "pro_monthly", quantity: 1 }];

function phase(items = sourceItems, startAt = start, endAt = end): Stripe.SubscriptionSchedule.Phase {
  return {
    start_date: startAt, end_date: endAt,
    items: items.map((item) => ({ price: item.priceId, plan: item.priceId, quantity: item.quantity, metadata: { purpose: item.id ?? "seat" }, discounts: [], tax_rates: [], billing_thresholds: null })),
    add_invoice_items: [], application_fee_percent: null, automatic_tax: { enabled: false, liability: null, disabled_reason: null },
    billing_cycle_anchor: "automatic", billing_thresholds: null, collection_method: "charge_automatically", currency: "usd",
    default_payment_method: "pm_saved", default_tax_rates: [], description: "Current paid term", discounts: [], invoice_settings: null,
    metadata: { phase: "original" }, on_behalf_of: null, proration_behavior: "create_prorations", transfer_data: null, trial_end: null,
  } as Stripe.SubscriptionSchedule.Phase;
}

function raw(items = sourceItems): Stripe.Subscription {
  return {
    id: "subscription", customer: "customer", metadata: { workspaceId }, status: "active", collection_method: "charge_automatically",
    cancel_at_period_end: false, pending_update: null, schedule: null,
    items: { has_more: false, data: items.map((item) => ({ id: item.id, price: { id: item.priceId }, quantity: item.quantity, current_period_start: start, current_period_end: end })) },
    latest_invoice: { id: "invoice", status: "paid", paid: true, hosted_invoice_url: "https://invoice.stripe.com/recovery" },
  } as unknown as Stripe.Subscription;
}

function schedule(items = sourceItems, quoteId = "old_quote"): Stripe.SubscriptionSchedule {
  return {
    id: "schedule_original", subscription: "subscription", metadata: { app: "narriflow", workspaceId, quoteId }, status: "active",
    current_phase: { start_date: start, end_date: end }, phases: [phase(items), phase([{ priceId: "creator_monthly", quantity: 1 }], end, end + 30 * 86400)],
    default_settings: { collection_method: "charge_automatically", default_payment_method: "pm_saved" }, end_behavior: "release",
  } as unknown as Stripe.SubscriptionSchedule;
}

function fixture(initial = raw()) {
  const state = { subscription: structuredClone(initial), decline: false, throwAfterPending: false, failScheduleUpdate: false };
  const calls: Array<{ method: string; params?: unknown; options?: unknown; id?: string }> = [];
  const created = new Map<string, Stripe.SubscriptionSchedule>();
  let sequence = 0;
  const stripe = {
    subscriptions: {
      retrieve: async (id: string, params: unknown) => { calls.push({ method: "retrieve", id, params }); return structuredClone(state.subscription); },
      update: async (id: string, params: Stripe.SubscriptionUpdateParams, options: Stripe.RequestOptions) => {
        calls.push({ method: "update", id, params, options });
        const current = state.subscription.items.data;
        const target = (params.items ?? []).filter((item) => !item.deleted).map((item) => ({
          id: item.id ?? `new_item_${sequence++}`, price: { id: item.price }, quantity: item.quantity,
          current_period_start: start, current_period_end: end,
        }));
        if (state.decline) {
          state.subscription.pending_update = { subscription_items: target } as unknown as Stripe.Subscription.PendingUpdate;
          state.subscription.latest_invoice = { id: "invoice", status: "open", hosted_invoice_url: "https://invoice.stripe.com/recovery" } as Stripe.Invoice;
          state.subscription.items.data = current;
        } else state.subscription.items.data = target as Stripe.SubscriptionItem[];
        if (state.throwAfterPending) throw new Error("Provider authentication failure containing private details");
        return structuredClone(state.subscription);
      },
    },
    invoices: { createPreview: async (params: unknown) => { calls.push({ method: "preview", params }); return { amount_due: 2399, currency: "usd" }; } },
    subscriptionSchedules: {
      create: async (params: { from_subscription: string }, options: Stripe.RequestOptions) => {
        calls.push({ method: "schedule_create", params, options });
        const cached = created.get(options.idempotencyKey!);
        if (cached) return structuredClone(cached);
        if (state.subscription.schedule) throw new Error("Already scheduled");
        const value = schedule(state.subscription.items.data.map((item) => ({ id: item.id, priceId: item.price.id, quantity: item.quantity ?? 1 })));
        value.id = `schedule_${++sequence}`;
        value.phases = value.phases.slice(0, 1);
        value.metadata = {};
        state.subscription.schedule = value;
        created.set(options.idempotencyKey!, structuredClone(value));
        return structuredClone(value);
      },
      update: async (id: string, params: Stripe.SubscriptionScheduleUpdateParams, options: Stripe.RequestOptions) => {
        calls.push({ method: "schedule_update", id, params, options });
        if (state.failScheduleUpdate) { state.failScheduleUpdate = false; throw new Error("Transient provider timeout"); }
        const value = state.subscription.schedule as Stripe.SubscriptionSchedule;
        if (params.metadata && typeof params.metadata !== "string") value.metadata = params.metadata;
        if (params.phases) value.phases = params.phases.map((item) => ({ ...phase([], Number(item.start_date), Number(item.end_date ?? Number(item.start_date) + 30 * 86400)), ...item })) as unknown as Stripe.SubscriptionSchedule.Phase[];
        return structuredClone(value);
      },
      release: async (id: string, params: unknown, options: Stripe.RequestOptions) => {
        calls.push({ method: "schedule_release", id, params, options });
        state.subscription.schedule = null;
        return { id, status: "released" };
      },
    },
  } as unknown as Stripe;
  const provider = createStripePlanChangeProvider(stripe, catalog);
  return { state, calls, provider };
}

async function applyInput(value: ReturnType<typeof fixture>, items: PlanChangeItem[], kind: "immediate" | "scheduled" = "immediate") {
  return { workspaceId, subscription: await value.provider.retrievePlanChangeSubscription!("subscription"), items, kind, prorationDate: start + 60, quoteId: "quote" };
}

describe("Stripe plan change contracts", () => {
  test("preview names existing items and uses the same fixed proration date", async () => {
    const value = fixture(raw([{ id: "base_item", priceId: "business_monthly", quantity: 1 }, { id: "seat_item", priceId: "seat_monthly", quantity: 4 }]));
    const result = await value.provider.previewPlanChange!({ subscriptionId: "subscription", customerId: "customer", items: [{ id: "base_item", priceId: "pro_monthly", quantity: 1 }], prorationDate: start + 60 });
    expect(result).toEqual({ amountDue: 2399, currency: "usd" });
    expect(value.calls.find((call) => call.method === "preview")?.params).toEqual({ customer: "customer", subscription: "subscription", subscription_details: { items: [{ id: "base_item", price: "pro_monthly", quantity: 1 }, { id: "seat_item", deleted: true }], proration_date: start + 60, proration_behavior: "always_invoice" } });
  });

  test("failed payment keeps the old price and resumes one pending invoice", async () => {
    const value = fixture();
    value.state.decline = true;
    const input = await applyInput(value, [{ id: "base_item", priceId: "business_monthly", quantity: 1 }]);
    expect(await value.provider.applyPlanChange!(input)).toEqual({ kind: "pending_payment", paymentUrl: "https://invoice.stripe.com/recovery", effectiveAt: null });
    expect(value.state.subscription.items.data[0]?.price.id).toBe("pro_monthly");
    expect(value.calls.find((call) => call.method === "update")).toMatchObject({ params: { items: [{ id: "base_item", price: "business_monthly", quantity: 1 }], payment_behavior: "pending_if_incomplete", proration_behavior: "always_invoice", proration_date: start + 60 }, options: { idempotencyKey: "narriflow_plan_upgrade_quote" } });
    expect(await value.provider.applyPlanChange!(input)).toMatchObject({ kind: "pending_payment" });
    expect(value.calls.filter((call) => call.method === "update")).toHaveLength(1);
    expect(normalizeStripePlanChange(value.state.subscription, catalog)).toEqual({ state: "pending_payment", tier: "business", interval: "monthly", effectiveAt: null });
  });

  test("successful multi-item interval upgrade preserves every seat quantity", async () => {
    const value = fixture(raw([{ id: "base_item", priceId: "business_monthly", quantity: 1 }, { id: "seat_item", priceId: "seat_monthly", quantity: 4 }]));
    const items = [{ id: "base_item", priceId: "business_annual", quantity: 1 }, { id: "seat_item", priceId: "seat_annual", quantity: 4 }];
    expect(await value.provider.applyPlanChange!(await applyInput(value, items))).toEqual({ kind: "applied", effectiveAt: null });
    expect(value.calls.find((call) => call.method === "update")).toMatchObject({ params: { items: [{ id: "base_item", price: "business_annual", quantity: 1 }, { id: "seat_item", price: "seat_annual", quantity: 4 }] } });
  });

  test("a provider exception after creating a pending update becomes payment recovery", async () => {
    const value = fixture();
    value.state.decline = true;
    value.state.throwAfterPending = true;
    expect(await value.provider.applyPlanChange!(await applyInput(value, [{ id: "base_item", priceId: "business_monthly", quantity: 1 }]))).toMatchObject({ kind: "pending_payment" });
  });

  test("an unpaid current invoice cannot fund a new prorated upgrade", async () => {
    const value = fixture();
    const input = await applyInput(value, [{ id: "base_item", priceId: "business_monthly", quantity: 1 }]);
    value.state.subscription.latest_invoice = { id: "unpaid_invoice", status: "open" } as Stripe.Invoice;
    await expect(value.provider.previewPlanChange!({ subscriptionId: "subscription", customerId: "customer", items: [{ id: "base_item", priceId: "business_monthly", quantity: 1 }], prorationDate: start + 60 })).rejects.toMatchObject({ code: "plan_change_recovery_required" });
    expect(value.calls.some((call) => call.method === "preview")).toBe(false);
    await expect(value.provider.applyPlanChange!(input)).rejects.toMatchObject({ code: "plan_change_recovery_required" });
    expect(value.calls.some((call) => call.method === "update")).toBe(false);
  });

  test("downgrades preserve paid phase settings and start at its exact end", async () => {
    const value = fixture();
    const original = phase();
    original.discounts = [{ discount: "di_saved", coupon: null, promotion_code: null }];
    original.default_tax_rates = [{ id: "txr_saved" } as Stripe.TaxRate];
    const input = await applyInput(value, [{ id: "base_item", priceId: "creator_annual", quantity: 1 }], "scheduled");
    // A prior owned phase also exercises release plus a fresh schedule derived from it.
    value.state.subscription.schedule = { ...schedule(), phases: [original] };
    input.subscription.schedule = { id: "schedule_original", owned: true, items: [], effectiveAt: end };
    // Simulate settings the provider copies into a newly attached schedule.
    const stripeSchedule = value.state.subscription.schedule as Stripe.SubscriptionSchedule;
    stripeSchedule.metadata.quoteId = "quote";
    expect(await value.provider.applyPlanChange!(input)).toEqual({ kind: "scheduled", effectiveAt: new Date(end * 1000).toISOString() });
    const update = value.calls.find((call) => call.method === "schedule_update")?.params as Stripe.SubscriptionScheduleUpdateParams;
    expect(update).toMatchObject({ end_behavior: "release", proration_behavior: "none", metadata: { app: "narriflow", workspaceId, quoteId: "quote" } });
    expect(update.phases?.[0]).toMatchObject({ start_date: start, end_date: end, discounts: [{ discount: "di_saved" }], default_tax_rates: ["txr_saved"], default_payment_method: "pm_saved", metadata: { phase: "original" } });
    expect(update.phases?.[1]).toMatchObject({ start_date: end, duration: { interval: "year", interval_count: 1 }, proration_behavior: "none", items: [{ price: "creator_annual", quantity: 1 }], discounts: [{ discount: "di_saved" }] });
    expect(update.phases?.[1]?.end_date).toBeUndefined();
    expect(value.state.subscription.items.data[0]?.price.id).toBe("pro_monthly");
    expect(normalizeStripePlanChange(value.state.subscription, catalog)).toEqual({ state: "scheduled", tier: "creator", interval: "annual", effectiveAt: new Date(end * 1000).toISOString() });
  });

  test("schedule creation is recoverable before ownership metadata was bound", async () => {
    const value = fixture();
    const input = await applyInput(value, [{ id: "base_item", priceId: "creator_monthly", quantity: 1 }], "scheduled");
    value.state.failScheduleUpdate = true;
    await expect(value.provider.applyPlanChange!(input)).rejects.toMatchObject({ code: "plan_change_conflict" });
    expect((value.state.subscription.schedule as Stripe.SubscriptionSchedule).metadata).toEqual({});
    expect(await value.provider.applyPlanChange!({ ...input, recovering: true })).toMatchObject({ kind: "scheduled" });
    const creates = value.calls.filter((call) => call.method === "schedule_create");
    expect(creates).toHaveLength(2);
    expect(creates[0]?.options).toEqual(creates[1]?.options);
    expect(value.calls.filter((call) => call.method === "schedule_release")).toHaveLength(0);
  });

  test("replaces only an owned prior schedule and protects foreign schedules", async () => {
    const value = fixture();
    value.state.subscription.schedule = schedule();
    const input = await applyInput(value, [{ id: "base_item", priceId: "creator_monthly", quantity: 1 }], "scheduled");
    expect(await value.provider.applyPlanChange!(input)).toMatchObject({ kind: "scheduled" });
    expect(value.calls.filter((call) => call.method === "schedule_release")).toHaveLength(1);
    const foreign = fixture();
    foreign.state.subscription.schedule = { ...schedule(), metadata: { app: "another_app", workspaceId } };
    await expect(foreign.provider.applyPlanChange!(await applyInput(foreign, input.items, "scheduled"))).rejects.toMatchObject({ code: "plan_change_schedule_conflict" });
    expect(foreign.calls.some((call) => ["schedule_release", "schedule_create", "schedule_update"].includes(call.method))).toBe(false);
    expect(normalizeStripePlanChange(foreign.state.subscription, catalog)).toBeNull();
  });

  test("a completed target phase is released so portal cancellation is available", async () => {
    const value = fixture();
    const attached = schedule();
    value.state.subscription.schedule = attached;
    await value.provider.finalizeCompletedPlanChangeSchedule!({ workspaceId, subscriptionId: "subscription" });
    expect(value.calls.filter((call) => call.method === "schedule_release")).toHaveLength(0);
    attached.current_phase = { start_date: end, end_date: end + 30 * 86400 };
    await value.provider.finalizeCompletedPlanChangeSchedule!({ workspaceId, subscriptionId: "subscription" });
    expect(value.calls.filter((call) => call.method === "schedule_release")).toHaveLength(1);
    expect(value.state.subscription.schedule).toBeNull();
    expect(value.state.subscription.status).toBe("active");
  });

  test("undo releases the owned schedule without canceling its subscription", async () => {
    const value = fixture();
    value.state.subscription.schedule = schedule();
    const subscription = await value.provider.retrievePlanChangeSubscription!("subscription");
    await value.provider.cancelScheduledPlanChange!({ workspaceId, subscription });
    expect(value.state.subscription.schedule).toBeNull();
    expect(value.state.subscription.status).toBe("active");
    await value.provider.cancelScheduledPlanChange!({ workspaceId, subscription });
    expect(value.calls.filter((call) => call.method === "schedule_release")).toHaveLength(1);
  });

  test("seat sync updates current and future Business intervals without resurrecting removed seats", async () => {
    const seats = [{ id: "base_item", priceId: "business_monthly", quantity: 1 }, { id: "seat_item", priceId: "seat_monthly", quantity: 4 }];
    const value = fixture(raw(seats));
    value.state.subscription.schedule = { ...schedule(seats), phases: [phase(seats), phase([{ priceId: "business_annual", quantity: 1 }, { priceId: "seat_annual", quantity: 4 }], end, end + 365 * 86400)] };
    await value.provider.synchronizeScheduledSeats!({ workspaceId, subscriptionId: "subscription", desired: 2, revision: 7 });
    const update = value.calls.find((call) => call.method === "schedule_update")?.params as Stripe.SubscriptionScheduleUpdateParams;
    expect(update.phases?.map((item) => item.items.map((entry) => ({ price: entry.price, quantity: entry.quantity })))).toEqual([[{ price: "business_monthly", quantity: 1 }, { price: "seat_monthly", quantity: 2 }], [{ price: "business_annual", quantity: 1 }, { price: "seat_annual", quantity: 2 }]]);
    await value.provider.synchronizeScheduledSeats!({ workspaceId, subscriptionId: "subscription", desired: 0, revision: 8 });
    const updates = value.calls.filter((call) => call.method === "schedule_update");
    const removed = updates.at(-1)?.params as Stripe.SubscriptionScheduleUpdateParams;
    expect(removed.phases?.every((item) => item.items.length === 1)).toBe(true);
    expect(removed.proration_behavior).toBe("none");
  });

  test("seat sync removes seats from a future lower tier and rejects truncated items", async () => {
    const value = fixture(raw([{ id: "base_item", priceId: "business_monthly", quantity: 1 }, { id: "seat_item", priceId: "seat_monthly", quantity: 4 }]));
    value.state.subscription.schedule = { ...schedule(), phases: [phase([{ priceId: "business_monthly", quantity: 1 }, { priceId: "seat_monthly", quantity: 4 }]), phase([{ priceId: "creator_monthly", quantity: 1 }, { priceId: "seat_monthly", quantity: 4 }], end, end + 30 * 86400)] };
    await value.provider.synchronizeScheduledSeats!({ workspaceId, subscriptionId: "subscription", desired: 3, revision: 2 });
    const update = value.calls.find((call) => call.method === "schedule_update")?.params as Stripe.SubscriptionScheduleUpdateParams;
    expect(update.phases?.[1]?.items.map((item) => item.price)).toEqual(["creator_monthly"]);
    value.state.subscription.items.has_more = true;
    await expect(value.provider.retrievePlanChangeSubscription!("subscription")).rejects.toMatchObject({ code: "plan_change_conflict" });
  });
});
