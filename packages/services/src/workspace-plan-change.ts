import { PRICING_TIER_ORDER, type BillingInterval, type BillingPlanChange, type PaidPricingTier, type PlanChangeQuote, type PlanChangeResult } from "@narriflow/validators";
import { randomUUID } from "node:crypto";
import { WorkspaceBillingAttemptLost, WorkspaceBillingError, type BillingCatalog, type WorkspaceBillingStore, type WorkspaceBillingProvider } from "./workspace-billing.service";

export interface PlanChangeItem { id?: string; priceId: string; quantity: number }
export interface PlanChangeSubscription {
  id: string;
  customerId: string;
  status: string;
  items: PlanChangeItem[];
  periodStart: number;
  periodEnd: number;
  cancelAtPeriodEnd: boolean;
  pending: { items: PlanChangeItem[]; paymentUrl: string | null } | null;
  schedule: { id: string; owned: boolean; quoteId?: string | null; items: PlanChangeItem[]; effectiveAt: number } | null;
}
export interface StoredPlanChangeQuote {
  public: PlanChangeQuote;
  workspaceId: string;
  actorUserId: string;
  clientIdempotencyKey: string;
  source: PlanChangeSubscription;
  targetItems: PlanChangeItem[];
  prorationDate: number;
  phase: "quoted" | "confirming" | "submitted" | "expired";
}
export interface WorkspacePlanChangeStore {
  readPlanChangeQuote(input: { workspaceId: string; id?: string; clientIdempotencyKey?: string }): Promise<StoredPlanChangeQuote | null>;
  readConfirmingPlanChangeQuote(workspaceId: string): Promise<StoredPlanChangeQuote | null>;
  savePlanChangeQuote(quote: StoredPlanChangeQuote): Promise<void>;
  markPlanChangeQuote(input: { workspaceId: string; id: string; phase: "confirming" | "submitted" | "expired" }): Promise<void>;
  releasePlanChangeClaim(input: { workspaceId: string; attemptId: string; now: Date; wake: boolean }): Promise<void>;
}
export interface WorkspacePlanChangeProvider {
  retrievePlanChangeSubscription?(subscriptionId: string): Promise<PlanChangeSubscription>;
  previewPlanChange?(input: { subscriptionId: string; customerId: string; items: PlanChangeItem[]; prorationDate: number }): Promise<{ amountDue: number; currency: string }>;
  applyPlanChange?(input: { workspaceId: string; subscription: PlanChangeSubscription; items: PlanChangeItem[]; kind: "immediate" | "scheduled"; prorationDate: number; quoteId: string; recovering?: boolean }): Promise<PlanChangeResult>;
  cancelScheduledPlanChange?(input: { workspaceId: string; subscription: PlanChangeSubscription }): Promise<void>;
  /** Abandon an upgrade still awaiting payment by voiding its invoice; Stripe then discards the pending update. */
  cancelPendingPlanChange?(input: { workspaceId: string; subscription: PlanChangeSubscription }): Promise<void>;
  synchronizeScheduledSeats?(input: { workspaceId: string; subscriptionId: string; desired: number; revision: number }): Promise<void>;
  finalizeCompletedPlanChangeSchedule?(input: { workspaceId: string; subscriptionId: string }): Promise<void>;
}

export type { BillingInterval, BillingPlanChange, PaidPricingTier, PlanChangeQuote, PlanChangeResult };

const itemPrices = (items: PlanChangeItem[]) => JSON.stringify(items.map(({ priceId, quantity }) => ({ priceId, quantity })).sort((a, b) => a.priceId.localeCompare(b.priceId)));
const sourceIdentity = (value: PlanChangeSubscription) => JSON.stringify({ id: value.id, customerId: value.customerId, items: value.items.map(({ id, priceId, quantity }) => ({ id, priceId, quantity })).sort((a, b) => a.priceId.localeCompare(b.priceId)), periodStart: value.periodStart, periodEnd: value.periodEnd });

/** Payment and timing policy; provider state remains the only entitlement authority. */
export function createWorkspacePlanChanges(dependencies: {
  catalog: BillingCatalog;
  store: WorkspaceBillingStore;
  provider: WorkspaceBillingProvider;
  clock: { now(): Date };
}) {
  const { catalog, store, provider, clock } = dependencies;
  async function exclusive<T>(input: { workspaceId: string; actorUserId: string }, wake: boolean, run: (renew: () => Promise<void>) => Promise<T>): Promise<T> {
    if ((await store.readBillingActor(input))?.role !== "owner") throw new WorkspaceBillingError("billing_forbidden");
    const claim = await store.claimAccount({ workspaceId: input.workspaceId, now: clock.now(), leaseMs: Math.max(catalog.worker.leaseMs, 120_000) });
    if (!claim) throw new WorkspaceBillingError("plan_change_busy");
    try {
      return await run(async () => {
        if (!(await store.renewClaim({ workspaceId: input.workspaceId, attemptId: claim.attemptId, now: clock.now(), leaseMs: Math.max(catalog.worker.leaseMs, 120_000) }))) throw new WorkspaceBillingError("plan_change_busy");
      });
    } finally {
      await store.releasePlanChangeClaim({ workspaceId: input.workspaceId, attemptId: claim.attemptId, now: clock.now(), wake });
    }
  }
  async function current(workspaceId: string, allowUnboundSchedule = false, recovering = false) {
    const projection = await store.readProjection(workspaceId);
    if (!projection?.providerCustomerId) throw new WorkspaceBillingError("billing_customer_missing");
    if (!recovering && projection.health === "attention_required") throw new WorkspaceBillingError("plan_change_recovery_required");
    if (!provider.retrievePlanChangeSubscription) throw new WorkspaceBillingError("plan_change_not_configured");
    const state = await provider.retrieveCurrentState(projection.providerCustomerId);
    if (state.customerId !== projection.providerCustomerId || state.ownership.kind !== "verified" || state.ownership.workspaceId !== workspaceId) throw new WorkspaceBillingError("customer_identity_conflict");
    const billable = state.subscriptions.filter((subscription) => !["canceled", "incomplete_expired"].includes(subscription.status));
    if (billable.length !== 1) throw new WorkspaceBillingError("plan_change_conflict");
    const subscription = await provider.retrievePlanChangeSubscription(billable[0]!.id);
    if (subscription.customerId !== projection.providerCustomerId || subscription.status !== "active" || subscription.cancelAtPeriodEnd) throw new WorkspaceBillingError("plan_change_recovery_required");
    if (subscription.schedule && !subscription.schedule.owned && !allowUnboundSchedule) throw new WorkspaceBillingError("plan_change_schedule_conflict");
    const bases = subscription.items.filter((item) => catalog.basePrice(item.priceId));
    const seats = subscription.items.filter((item) => catalog.seatPrice(item.priceId));
    if (bases.length !== 1 || bases[0]?.quantity !== 1 || !bases[0]?.id || seats.length > 1 || bases.length + seats.length !== subscription.items.length) throw new WorkspaceBillingError("plan_change_conflict");
    const base = catalog.basePrice(bases[0]!.priceId)!;
    if ((seats.length && base.tier !== "business") || seats.some((item) => !item.id || catalog.seatPrice(item.priceId)?.interval !== base.interval)) throw new WorkspaceBillingError("plan_change_conflict");
    return { subscription, base, baseItem: bases[0]!, seatItem: seats[0] };
  }
  function observedResult(quote: StoredPlanChangeQuote, subscription: PlanChangeSubscription): PlanChangeResult | null {
    if (subscription.pending && itemPrices(subscription.pending.items) === itemPrices(quote.targetItems)) {
      return { kind: "pending_payment", ...(subscription.pending.paymentUrl ? { paymentUrl: subscription.pending.paymentUrl } : {}), effectiveAt: null };
    }
    if (subscription.schedule?.owned && itemPrices(subscription.schedule.items) === itemPrices(quote.targetItems)) return { kind: "scheduled", effectiveAt: new Date(subscription.schedule.effectiveAt * 1000).toISOString() };
    const base = subscription.items.find((item) => catalog.basePrice(item.priceId));
    const mapping = base && catalog.basePrice(base.priceId);
    if (mapping?.tier === quote.public.tier && mapping.interval === quote.public.interval) return { kind: "applied", effectiveAt: null };
    return null;
  }
  async function confirmQuote(quote: StoredPlanChangeQuote, renew: () => Promise<void>, recovering = false): Promise<PlanChangeResult> {
    if (quote.phase === "expired") throw new WorkspaceBillingError("plan_change_quote_expired");
    const { subscription } = await current(quote.workspaceId, quote.phase === "confirming", recovering);
    const observed = observedResult(quote, subscription);
    if (observed || quote.phase === "submitted") {
      await store.markPlanChangeQuote({ workspaceId: quote.workspaceId, id: quote.public.id, phase: "submitted" });
      return observed ?? { kind: "unchanged", effectiveAt: null };
    }
    if ((quote.phase === "quoted" || quote.public.kind === "immediate") && new Date(quote.public.expiresAt).getTime() <= clock.now().getTime()) {
      await store.markPlanChangeQuote({ workspaceId: quote.workspaceId, id: quote.public.id, phase: "expired" });
      throw new WorkspaceBillingError("plan_change_quote_expired");
    }
    if (subscription.pending || sourceIdentity(subscription) !== sourceIdentity(quote.source)) throw new WorkspaceBillingError("plan_change_conflict");
    const scheduleChanged = subscription.schedule?.id !== quote.source.schedule?.id;
    if (scheduleChanged && !(quote.phase === "confirming" && (!subscription.schedule || !subscription.schedule.owned || subscription.schedule.quoteId === quote.public.id))) throw new WorkspaceBillingError("plan_change_conflict");
    if (quote.public.tier === "business") {
      const desired = await store.readDesiredSeatState(quote.workspaceId);
      const quotedSeats = quote.targetItems.find((item) => catalog.seatPrice(item.priceId))?.quantity ?? 0;
      if (desired.desired !== quotedSeats) throw new WorkspaceBillingError("plan_change_conflict");
    }
    if (!provider.applyPlanChange) throw new WorkspaceBillingError("plan_change_not_configured");
    if (quote.public.kind === "immediate") {
      if (!provider.previewPlanChange) throw new WorkspaceBillingError("plan_change_not_configured");
      const latest = await provider.previewPlanChange({ subscriptionId: subscription.id, customerId: subscription.customerId, items: quote.targetItems, prorationDate: quote.prorationDate });
      if (latest.amountDue !== quote.public.amountDue || latest.currency !== quote.public.currency) throw new WorkspaceBillingError("plan_change_conflict");
    }
    await renew();
    const wasConfirming = quote.phase === "confirming";
    await store.markPlanChangeQuote({ workspaceId: quote.workspaceId, id: quote.public.id, phase: "confirming" });
    const result = await provider.applyPlanChange({ workspaceId: quote.workspaceId, subscription, items: quote.targetItems, kind: quote.public.kind, prorationDate: quote.prorationDate, quoteId: quote.public.id, recovering: wasConfirming });
    await store.markPlanChangeQuote({ workspaceId: quote.workspaceId, id: quote.public.id, phase: "submitted" });
    return result;
  }
  return {
    async previewPlanChange(input: { workspaceId: string; actorUserId: string; clientIdempotencyKey: string; targetTier: PaidPricingTier; interval: BillingInterval }) {
      return exclusive(input, false, async () => {
        const existing = await store.readPlanChangeQuote({ workspaceId: input.workspaceId, clientIdempotencyKey: input.clientIdempotencyKey });
        if (existing) {
          if (existing.actorUserId !== input.actorUserId || existing.public.tier !== input.targetTier || existing.public.interval !== input.interval) throw new WorkspaceBillingError("plan_change_conflict");
          if (existing.phase === "confirming") throw new WorkspaceBillingError("plan_change_busy");
          if (existing.phase === "expired") throw new WorkspaceBillingError("plan_change_quote_expired");
          if (await store.readConfirmingPlanChangeQuote(input.workspaceId)) throw new WorkspaceBillingError("plan_change_busy");
          if (new Date(existing.public.expiresAt).getTime() <= clock.now().getTime()) throw new WorkspaceBillingError("plan_change_quote_expired");
          return { quote: existing.public };
        }
        if (await store.readConfirmingPlanChangeQuote(input.workspaceId)) throw new WorkspaceBillingError("plan_change_busy");
        const { subscription, base, baseItem, seatItem } = await current(input.workspaceId);
        if (subscription.pending) throw new WorkspaceBillingError("plan_change_recovery_required");
        if (base.tier === input.targetTier && base.interval === input.interval) throw new WorkspaceBillingError("plan_change_invalid");
        const targetPrice = catalog.basePrices.find((price) => price.tier === input.targetTier && price.interval === input.interval);
        if (!targetPrice || !provider.previewPlanChange) throw new WorkspaceBillingError("plan_change_not_configured");
        const targetItems: PlanChangeItem[] = [{ id: baseItem.id, priceId: targetPrice.priceId, quantity: 1 }];
        if (input.targetTier === "business") {
          const desired = await store.readDesiredSeatState(input.workspaceId);
          const price = catalog.seatPrices.find((entry) => entry.interval === input.interval);
          if (!price) throw new WorkspaceBillingError("price_not_configured");
          if (desired.desired > 0) targetItems.push({ ...(seatItem?.id ? { id: seatItem.id } : {}), priceId: price.priceId, quantity: desired.desired });
        }
        const kind = PRICING_TIER_ORDER.indexOf(input.targetTier) < PRICING_TIER_ORDER.indexOf(base.tier) || (input.targetTier === base.tier && base.interval === "annual" && input.interval === "monthly") ? "scheduled" : "immediate";
        const now = clock.now();
        const prorationDate = Math.floor(now.getTime() / 1000);
        if (subscription.periodEnd <= prorationDate) throw new WorkspaceBillingError("plan_change_conflict");
        const amount = kind === "immediate" ? await provider.previewPlanChange({ subscriptionId: subscription.id, customerId: subscription.customerId, items: targetItems, prorationDate }) : { amountDue: 0, currency: "usd" };
        if (amount.currency !== "usd" || !Number.isSafeInteger(amount.amountDue)) throw new WorkspaceBillingError("plan_change_conflict");
        const quote: StoredPlanChangeQuote = {
          public: { id: randomUUID(), tier: input.targetTier, interval: input.interval, kind, amountDue: amount.amountDue, currency: "usd", effectiveAt: new Date((kind === "scheduled" ? subscription.periodEnd : prorationDate) * 1000).toISOString(), expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString() },
          workspaceId: input.workspaceId, actorUserId: input.actorUserId, clientIdempotencyKey: input.clientIdempotencyKey, source: subscription, targetItems, prorationDate, phase: "quoted",
        };
        await store.savePlanChangeQuote(quote);
        return { quote: quote.public };
      });
    },
    async confirmPlanChange(input: { workspaceId: string; actorUserId: string; quoteId: string }): Promise<PlanChangeResult> {
      return exclusive(input, true, async (renew) => {
        const quote = await store.readPlanChangeQuote({ workspaceId: input.workspaceId, id: input.quoteId });
        if (!quote || quote.actorUserId !== input.actorUserId) throw new WorkspaceBillingError("plan_change_quote_missing");
        const confirming = await store.readConfirmingPlanChangeQuote(input.workspaceId);
        if (confirming && confirming.public.id !== quote.public.id) throw new WorkspaceBillingError("plan_change_busy");
        return confirmQuote(quote, renew);
      });
    },
    /** Resume an owner-confirmed intent under reconciliation's existing account claim. */
    async recoverConfirmingPlanChange(input: { workspaceId: string; attemptId: string }): Promise<"none" | "recovered" | "expired"> {
      const quote = await store.readConfirmingPlanChangeQuote(input.workspaceId);
      if (!quote) return "none";
      const renew = async () => {
        if (!(await store.renewClaim({ workspaceId: input.workspaceId, attemptId: input.attemptId, now: clock.now(), leaseMs: Math.max(catalog.worker.leaseMs, 120_000) }))) throw new WorkspaceBillingAttemptLost();
      };
      await renew();
      try {
        if ((await store.readBillingActor({ workspaceId: input.workspaceId, actorUserId: quote.actorUserId }))?.role !== "owner") throw new WorkspaceBillingError("billing_forbidden");
        await confirmQuote(quote, renew, true);
        return "recovered";
      } catch (error) {
        // A confirmed change that can no longer be completed safely (expired quote,
        // changed source, cancelling or past-due subscription, new owner) ends here,
        // so reconciliation always goes on to apply the provider's current state.
        // Outages and lost claims propagate to the usual retry.
        if (!(error instanceof WorkspaceBillingError)) throw error;
        await store.markPlanChangeQuote({ workspaceId: input.workspaceId, id: quote.public.id, phase: "expired" });
        return "expired";
      }
    },
    /**
     * "Keep current plan": undo a scheduled downgrade, or abandon an upgrade that
     * is still awaiting payment. Either way the owner stays on the plan they pay for.
     */
    async cancelScheduledPlanChange(input: { workspaceId: string; actorUserId: string }): Promise<PlanChangeResult> {
      return exclusive(input, true, async (renew) => {
        if (await store.readConfirmingPlanChangeQuote(input.workspaceId)) throw new WorkspaceBillingError("plan_change_busy");
        const { subscription } = await current(input.workspaceId);
        if (subscription.pending) {
          if (!provider.cancelPendingPlanChange) throw new WorkspaceBillingError("plan_change_not_configured");
          await renew();
          await provider.cancelPendingPlanChange({ workspaceId: input.workspaceId, subscription });
          return { kind: "unchanged", effectiveAt: null };
        }
        if (!subscription.schedule) return { kind: "unchanged", effectiveAt: null };
        if (!provider.cancelScheduledPlanChange) throw new WorkspaceBillingError("plan_change_not_configured");
        await renew();
        await provider.cancelScheduledPlanChange({ workspaceId: input.workspaceId, subscription });
        return { kind: "unchanged", effectiveAt: null };
      });
    },
    /** The owner's link to finish paying for an upgrade that is awaiting payment, or null when none is. */
    async readPendingPlanChangePayment(input: { workspaceId: string; actorUserId: string }): Promise<{ url: string | null }> {
      if ((await store.readBillingActor(input))?.role !== "owner") throw new WorkspaceBillingError("billing_forbidden");
      const { subscription } = await current(input.workspaceId);
      return { url: subscription.pending?.paymentUrl ?? null };
    },
  };
}
