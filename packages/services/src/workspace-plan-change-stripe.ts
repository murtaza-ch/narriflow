import { createHash } from "node:crypto";
import type Stripe from "stripe";
import type { BillingPlanChange } from "@narriflow/validators";
import { WorkspaceBillingError, type BillingCatalog } from "./workspace-billing.service";
import type { PlanChangeItem, PlanChangeSubscription, WorkspacePlanChangeProvider } from "./workspace-plan-change";

type Phase = Stripe.SubscriptionSchedule.Phase;
type PhaseUpdate = Stripe.SubscriptionScheduleUpdateParams.Phase;
type PhaseItem = PhaseUpdate["items"][number];

function objectId(value: string | { id: string } | null | undefined): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

function itemsEqual(left: PlanChangeItem[], right: PlanChangeItem[]): boolean {
  const values = (items: PlanChangeItem[]) => items.map((item) => `${item.priceId}:${item.quantity}`).sort().join("|");
  return values(left) === values(right);
}

function subscriptionItems(subscription: Stripe.Subscription): PlanChangeItem[] {
  if (subscription.items.has_more || subscription.items.data.length > 20) {
    throw new WorkspaceBillingError("plan_change_conflict");
  }
  return subscription.items.data.map((item) => ({
    id: item.id,
    priceId: objectId(item.price) ?? "",
    quantity: item.quantity ?? 1,
  }));
}

function pendingItems(subscription: Stripe.Subscription): PlanChangeItem[] | null {
  const items = subscription.pending_update?.subscription_items;
  if (!items) return null;
  if (items.length > 20) throw new WorkspaceBillingError("plan_change_conflict");
  return items.map((item) => ({
    ...(item.id ? { id: item.id } : {}),
    priceId: objectId(item.price) ?? "",
    quantity: item.quantity ?? 1,
  }));
}

function expandedSchedule(subscription: Stripe.Subscription): Stripe.SubscriptionSchedule | null {
  if (typeof subscription.schedule === "string") throw new WorkspaceBillingError("plan_change_conflict");
  return subscription.schedule;
}

function ownsSchedule(schedule: Stripe.SubscriptionSchedule, workspaceId: string): boolean {
  return Boolean(workspaceId) && schedule.metadata?.app === "narriflow" && schedule.metadata?.workspaceId === workspaceId;
}

function futurePhase(schedule: Stripe.SubscriptionSchedule): Phase | null {
  const currentEnd = schedule.current_phase?.end_date;
  if (currentEnd == null) return null;
  return schedule.phases.find((phase) => phase.start_date >= currentEnd) ?? null;
}

function phaseItems(phase: Phase): PlanChangeItem[] {
  if (phase.items.length > 20) throw new WorkspaceBillingError("plan_change_conflict");
  return phase.items.map((item) => ({ priceId: objectId(item.price) ?? "", quantity: item.quantity ?? 1 }));
}

function mappedBase(items: PlanChangeItem[], catalog: BillingCatalog) {
  const bases = items.flatMap((item) => {
    const mapped = catalog.basePrice(item.priceId);
    return mapped ? [{ ...mapped, quantity: item.quantity }] : [];
  });
  return bases.length === 1 && bases[0]?.quantity === 1 ? bases[0] : null;
}

function validateItems(items: PlanChangeItem[], catalog: BillingCatalog): void {
  const base = mappedBase(items, catalog);
  if (!base || items.length > 2 || items.some((item) => !Number.isSafeInteger(item.quantity) || item.quantity < 1)) {
    throw new WorkspaceBillingError("plan_change_conflict");
  }
  for (const item of items) {
    if (catalog.basePrice(item.priceId)) continue;
    const seat = catalog.seatPrice(item.priceId);
    if (!seat || base.tier !== "business" || seat.interval !== base.interval) {
      throw new WorkspaceBillingError("plan_change_conflict");
    }
  }
}

/** Snapshot only; pending and scheduled prices never grant entitlements. */
export function normalizeStripePlanChange(subscription: Stripe.Subscription, catalog: BillingCatalog): BillingPlanChange | null {
  const pending = pendingItems(subscription);
  if (pending) {
    const base = mappedBase(pending, catalog);
    return base ? { state: "pending_payment", tier: base.tier, interval: base.interval, effectiveAt: null } : null;
  }
  const schedule = expandedSchedule(subscription);
  if (!schedule || !ownsSchedule(schedule, subscription.metadata.workspaceId ?? "")) return null;
  const phase = futurePhase(schedule);
  const base = phase ? mappedBase(phaseItems(phase), catalog) : null;
  return base && phase ? { state: "scheduled", tier: base.tier, interval: base.interval, effectiveAt: new Date(phase.start_date * 1_000).toISOString() } : null;
}

function normalizeSubscription(subscription: Stripe.Subscription, catalog: BillingCatalog): PlanChangeSubscription {
  const items = subscriptionItems(subscription);
  validateItems(items, catalog);
  const periods = subscription.items.data;
  const starts = periods.map((item) => item.current_period_start);
  const ends = periods.map((item) => item.current_period_end);
  if (starts.some((value) => !Number.isSafeInteger(value)) || ends.some((value) => !Number.isSafeInteger(value))) {
    throw new WorkspaceBillingError("plan_change_conflict");
  }
  const schedule = expandedSchedule(subscription);
  const phase = schedule && futurePhase(schedule);
  const pending = pendingItems(subscription);
  return {
    id: subscription.id,
    customerId: objectId(subscription.customer) ?? "",
    status: subscription.status,
    items,
    periodStart: Math.min(...starts),
    periodEnd: Math.min(...ends),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    pending: subscription.pending_update ? { items: pending ?? [], paymentUrl: pendingUpdateInvoice(subscription)?.hosted_invoice_url ?? null } : null,
    schedule: schedule ? {
      id: schedule.id,
      owned: ownsSchedule(schedule, subscription.metadata.workspaceId ?? ""),
      items: phase ? phaseItems(phase) : [],
      effectiveAt: phase?.start_date ?? Math.min(...ends),
      ...(schedule.metadata?.quoteId ? { quoteId: schedule.metadata.quoteId } : {}),
    } : null,
  };
}

function discountParams(discounts: Phase["discounts"]): NonNullable<Exclude<PhaseUpdate["discounts"], string>> {
  return discounts.map((discount) => {
    const existing = objectId(discount.discount);
    if (existing) return { discount: existing };
    const promotion = objectId(discount.promotion_code);
    if (promotion) return { promotion_code: promotion };
    const coupon = objectId(discount.coupon);
    if (coupon) return { coupon };
    throw new WorkspaceBillingError("plan_change_conflict");
  });
}

function preserveItem(item: Phase["items"][number]): PhaseItem {
  return {
    price: objectId(item.price) ?? "",
    quantity: item.quantity ?? 1,
    ...(item.metadata ? { metadata: item.metadata } : {}),
    ...(item.billing_thresholds?.usage_gte != null ? { billing_thresholds: { usage_gte: item.billing_thresholds.usage_gte } } : {}),
    ...(item.discounts?.length ? { discounts: discountParams(item.discounts) } : { discounts: "" }),
    ...(item.tax_rates ? { tax_rates: item.tax_rates.length ? item.tax_rates.map((rate) => rate.id) : "" } : {}),
  };
}

/** Copy writable phase settings explicitly; response objects contain read-only fields. */
function preservePhase(phase: Phase): PhaseUpdate {
  const automaticTax = phase.automatic_tax;
  const invoice = phase.invoice_settings;
  return {
    start_date: phase.start_date,
    end_date: phase.end_date,
    items: phase.items.map(preserveItem),
    add_invoice_items: phase.add_invoice_items.map((item) => ({
      price: objectId(item.price)!,
      quantity: item.quantity ?? 1,
      ...(item.discountable !== null ? { discountable: item.discountable } : {}),
      ...(item.discounts?.length ? { discounts: discountParams(item.discounts) } : {}),
      ...(item.metadata ? { metadata: item.metadata } : {}),
      ...(item.period ? { period: item.period } : {}),
      ...(item.tax_rates ? { tax_rates: item.tax_rates.map((rate) => rate.id) } : {}),
    })),
    proration_behavior: phase.proration_behavior,
    currency: phase.currency,
    ...(phase.metadata ? { metadata: phase.metadata } : {}),
    ...(phase.description !== null ? { description: phase.description } : {}),
    ...(phase.application_fee_percent !== null ? { application_fee_percent: phase.application_fee_percent } : {}),
    ...(phase.billing_cycle_anchor ? { billing_cycle_anchor: phase.billing_cycle_anchor } : {}),
    ...(phase.billing_thresholds ? { billing_thresholds: {
      ...(phase.billing_thresholds.amount_gte !== null ? { amount_gte: phase.billing_thresholds.amount_gte } : {}),
      ...(phase.billing_thresholds.reset_billing_cycle_anchor !== null ? { reset_billing_cycle_anchor: phase.billing_thresholds.reset_billing_cycle_anchor } : {}),
    } } : {}),
    ...(phase.collection_method ? { collection_method: phase.collection_method } : {}),
    ...(phase.default_payment_method ? { default_payment_method: objectId(phase.default_payment_method)! } : {}),
    ...(phase.default_tax_rates ? { default_tax_rates: phase.default_tax_rates.length ? phase.default_tax_rates.map((rate) => rate.id) : "" } : {}),
    discounts: phase.discounts?.length ? discountParams(phase.discounts) : "",
    ...(automaticTax ? { automatic_tax: {
      enabled: automaticTax.enabled,
      ...(automaticTax.liability ? { liability: {
        type: automaticTax.liability.type,
        ...(automaticTax.liability.account ? { account: objectId(automaticTax.liability.account)! } : {}),
      } } : {}),
    } } : {}),
    ...(invoice ? { invoice_settings: {
      ...(invoice.account_tax_ids ? { account_tax_ids: invoice.account_tax_ids.map((taxId) => objectId(taxId)!) } : {}),
      ...(invoice.custom_fields ? { custom_fields: invoice.custom_fields } : {}),
      ...(invoice.days_until_due !== null ? { days_until_due: invoice.days_until_due } : {}),
      ...(invoice.description !== null ? { description: invoice.description } : {}),
      ...(invoice.footer !== null ? { footer: invoice.footer } : {}),
      ...(invoice.issuer ? { issuer: { type: invoice.issuer.type, ...(invoice.issuer.account ? { account: objectId(invoice.issuer.account)! } : {}) } } : {}),
    } } : {}),
    ...(phase.on_behalf_of ? { on_behalf_of: objectId(phase.on_behalf_of)! } : {}),
    ...(phase.transfer_data ? { transfer_data: {
      destination: objectId(phase.transfer_data.destination)!,
      ...(phase.transfer_data.amount_percent !== null ? { amount_percent: phase.transfer_data.amount_percent } : {}),
    } } : {}),
    ...(phase.trial_end !== null ? { trial_end: phase.trial_end } : {}),
    ...(phase.trial === undefined ? {} : { trial: phase.trial }),
  };
}

function updateItems(source: PlanChangeItem[], target: PlanChangeItem[], catalog: BillingCatalog): Stripe.SubscriptionUpdateParams.Item[] {
  const originalBase = source.find((item) => catalog.basePrice(item.priceId));
  const targetBase = target.find((item) => catalog.basePrice(item.priceId));
  const ids = target.flatMap((item) => item.id ? [item.id] : []);
  if (!originalBase?.id || targetBase?.id !== originalBase.id || new Set(ids).size !== ids.length || ids.some((id) => !source.some((item) => item.id === id))) {
    throw new WorkspaceBillingError("plan_change_conflict");
  }
  const result: Stripe.SubscriptionUpdateParams.Item[] = target.map((item) => ({ ...(item.id ? { id: item.id } : {}), price: item.priceId, quantity: item.quantity }));
  for (const item of source) {
    if (!item.id) throw new WorkspaceBillingError("plan_change_conflict");
    if (!target.some((candidate) => candidate.id === item.id)) result.push({ id: item.id, deleted: true });
  }
  return result;
}

/**
 * The invoice a pending upgrade created, or null. Only an update invoice
 * belongs to the upgrade; a renewal invoice is never paid or voided on its behalf.
 */
function pendingUpdateInvoice(subscription: Stripe.Subscription): Stripe.Invoice | null {
  const invoice = subscription.latest_invoice;
  return invoice && typeof invoice !== "string" && invoice.billing_reason === "subscription_update" ? invoice : null;
}

function pendingResult(subscription: Stripe.Subscription) {
  const invoice = pendingUpdateInvoice(subscription);
  return { kind: "pending_payment" as const, effectiveAt: null, ...(invoice?.hosted_invoice_url ? { paymentUrl: invoice.hosted_invoice_url } : {}) };
}

/**
 * Plan changes need an active subscription with nothing outstanding. Stripe
 * counts an invoice as outstanding once it is finalized and unpaid (`open` or
 * `uncollectible`). A renewal invoice spends about an hour as a `draft` before
 * Stripe finalizes and charges it; that is a normal part of every renewal, not
 * a payment problem, so it doesn't block a change.
 */
function requireReadySubscription(subscription: Stripe.Subscription): void {
  const invoice = subscription.latest_invoice;
  if (subscription.status !== "active" || subscription.cancel_at_period_end || subscription.collection_method !== "charge_automatically" ||
    typeof invoice === "string" || (invoice && ["open", "uncollectible"].includes(invoice.status ?? ""))) {
    throw new WorkspaceBillingError("plan_change_recovery_required");
  }
}

/**
 * Stripe refusing this request (invalid against the subscription, card, or a
 * reused key) means the plan change conflicts. Outages, rate limits and network
 * failures propagate instead, so reconciliation retries them shortly rather
 * than ending an owner's confirmed change.
 */
function planChangeFailure(error: unknown, code: "plan_change_conflict" | "plan_change_schedule_conflict" | "plan_change_recovery_required"): never {
  if (error instanceof WorkspaceBillingError) throw error;
  const type = (error as { type?: unknown } | null)?.type;
  if (type === "StripeInvalidRequestError" || type === "StripeCardError" || type === "StripeIdempotencyError") throw new WorkspaceBillingError(code);
  throw error;
}

export function createStripePlanChangeProvider(stripe: Stripe, catalog: BillingCatalog): WorkspacePlanChangeProvider {
  const retrieve = async (id: string) => {
    try {
      return await stripe.subscriptions.retrieve(id, { expand: ["latest_invoice", "schedule"] });
    } catch (error) {
      planChangeFailure(error, "plan_change_conflict");
    }
  };
  const release = async (schedule: Stripe.SubscriptionSchedule, workspaceId: string) => {
    if (!ownsSchedule(schedule, workspaceId)) throw new WorkspaceBillingError("plan_change_schedule_conflict");
    try {
      await stripe.subscriptionSchedules.release(schedule.id, { preserve_cancel_date: true }, { idempotencyKey: `narriflow_plan_release_${schedule.id}` });
    } catch (error) {
      planChangeFailure(error, "plan_change_conflict");
    }
  };

  return {
    async retrievePlanChangeSubscription(subscriptionId) {
      const subscription = await retrieve(subscriptionId);
      if (!subscription.pending_update) requireReadySubscription(subscription);
      return normalizeSubscription(subscription, catalog);
    },
    async previewPlanChange(input) {
      validateItems(input.items, catalog);
      const subscription = await retrieve(input.subscriptionId);
      if (objectId(subscription.customer) !== input.customerId) throw new WorkspaceBillingError("plan_change_conflict");
      requireReadySubscription(subscription);
      const invoice = await stripe.invoices.createPreview({
        customer: input.customerId,
        subscription: input.subscriptionId,
        subscription_details: {
          items: updateItems(subscriptionItems(subscription), input.items, catalog),
          proration_date: input.prorationDate,
          proration_behavior: "always_invoice",
        },
      }).catch((error) => planChangeFailure(error, "plan_change_conflict"));
      if (invoice.currency !== "usd" || !Number.isSafeInteger(invoice.amount_due)) throw new WorkspaceBillingError("plan_change_conflict");
      return { amountDue: invoice.amount_due, currency: invoice.currency };
    },
    async applyPlanChange(input) {
      validateItems(input.items, catalog);
      let subscription = await retrieve(input.subscription.id);
      const actual = normalizeSubscription(subscription, catalog);
      if (actual.customerId !== input.subscription.customerId || subscription.metadata.workspaceId !== input.workspaceId) throw new WorkspaceBillingError("plan_change_conflict");
      if (actual.pending) {
        if (input.kind === "immediate" && itemsEqual(actual.pending.items, input.items)) return pendingResult(subscription);
        throw new WorkspaceBillingError("plan_change_conflict");
      }
      if (itemsEqual(actual.items, input.items)) return { kind: "unchanged", effectiveAt: null };
      requireReadySubscription(subscription);
      if (!itemsEqual(actual.items, input.subscription.items) || actual.periodEnd !== input.subscription.periodEnd) throw new WorkspaceBillingError("plan_change_conflict");

      let schedule = expandedSchedule(subscription);
      if (input.kind === "immediate") {
        if (schedule) {
          await release(schedule, input.workspaceId);
          subscription = await retrieve(subscription.id);
        }
        try {
          const updated = await stripe.subscriptions.update(subscription.id, {
            items: updateItems(subscriptionItems(subscription), input.items, catalog),
            payment_behavior: "pending_if_incomplete",
            proration_behavior: "always_invoice",
            proration_date: input.prorationDate,
            expand: ["latest_invoice", "schedule"],
          }, { idempotencyKey: `narriflow_plan_upgrade_${input.quoteId}` });
          if (updated.pending_update) return pendingResult(updated);
          if (!itemsEqual(subscriptionItems(updated), input.items)) throw new WorkspaceBillingError("plan_change_conflict");
          return { kind: "applied", effectiveAt: null };
        } catch (error) {
          if (error instanceof WorkspaceBillingError) throw error;
          const current = await retrieve(subscription.id);
          if (current.pending_update && itemsEqual(pendingItems(current) ?? [], input.items)) return pendingResult(current);
          if (itemsEqual(subscriptionItems(current), input.items)) return { kind: "applied", effectiveAt: null };
          // Not applied: an outage is retried under the same idempotency key; a refusal ends the attempt.
          planChangeFailure(error, "plan_change_recovery_required");
        }
      }

      if (schedule && ownsSchedule(schedule, input.workspaceId) && schedule.metadata?.quoteId !== input.quoteId) {
        await release(schedule, input.workspaceId);
        schedule = null;
      }
      if (!schedule || !ownsSchedule(schedule, input.workspaceId)) {
        if (schedule && !input.recovering) throw new WorkspaceBillingError("plan_change_schedule_conflict");
        // Replaying creation also recovers a response lost before metadata/phases were bound.
        let created: Stripe.SubscriptionSchedule;
        try {
          created = await stripe.subscriptionSchedules.create({ from_subscription: subscription.id }, { idempotencyKey: `narriflow_plan_schedule_${input.quoteId}` });
        } catch (error) {
          planChangeFailure(error, "plan_change_schedule_conflict");
        }
        if (schedule && schedule.id !== created.id) throw new WorkspaceBillingError("plan_change_schedule_conflict");
        schedule = created;
      }
      const phase = schedule.phases.find((candidate) => candidate.start_date === schedule?.current_phase?.start_date) ?? schedule.phases[0];
      if (!phase || phase.end_date !== actual.periodEnd) throw new WorkspaceBillingError("plan_change_conflict");
      const current = preservePhase(phase);
      const target = preservePhase(phase);
      target.items = input.items.map((item) => {
        const oldPrice = actual.items.find((original) => original.id === item.id)?.priceId;
        const previous = phase.items.find((original) => objectId(original.price) === oldPrice);
        return { ...(previous ? preserveItem(previous) : {}), price: item.priceId, quantity: item.quantity };
      });
      target.start_date = actual.periodEnd;
      delete target.end_date;
      delete target.trial;
      delete target.trial_end;
      delete target.add_invoice_items;
      target.duration = { interval: mappedBase(input.items, catalog)!.interval === "annual" ? "year" : "month", interval_count: 1 };
      target.proration_behavior = "none";
      try {
        await stripe.subscriptionSchedules.update(schedule.id, {
          metadata: { ...schedule.metadata, app: "narriflow", workspaceId: input.workspaceId, quoteId: input.quoteId },
          end_behavior: "release",
          proration_behavior: "none",
          phases: [current, target],
        }, { idempotencyKey: `narriflow_plan_schedule_apply_${input.quoteId}` });
      } catch (error) {
        const observed = await retrieve(subscription.id).catch(() => null);
        const attached = observed ? expandedSchedule(observed) : null;
        const future = attached && futurePhase(attached);
        if (!attached || !ownsSchedule(attached, input.workspaceId) || attached.metadata?.quoteId !== input.quoteId || !future || !itemsEqual(phaseItems(future), input.items)) {
          planChangeFailure(error, "plan_change_conflict");
        }
      }
      return { kind: "scheduled", effectiveAt: new Date(actual.periodEnd * 1_000).toISOString() };
    },
    async cancelScheduledPlanChange(input) {
      const subscription = await retrieve(input.subscription.id);
      if (objectId(subscription.customer) !== input.subscription.customerId || subscription.metadata.workspaceId !== input.workspaceId) throw new WorkspaceBillingError("plan_change_conflict");
      const schedule = expandedSchedule(subscription);
      if (schedule) await release(schedule, input.workspaceId);
    },
    async cancelPendingPlanChange(input) {
      const subscription = await retrieve(input.subscription.id);
      if (objectId(subscription.customer) !== input.subscription.customerId || subscription.metadata.workspaceId !== input.workspaceId) throw new WorkspaceBillingError("plan_change_conflict");
      if (!subscription.pending_update) return;
      // Stripe's documented way to cancel a pending update: void the invoice it created.
      const invoice = pendingUpdateInvoice(subscription);
      if (!invoice || invoice.status !== "open") throw new WorkspaceBillingError("plan_change_conflict");
      await stripe.invoices.voidInvoice(invoice.id!, {}, { idempotencyKey: `narriflow_plan_pending_void_${invoice.id}` })
        .catch((error) => planChangeFailure(error, "plan_change_conflict"));
    },
    async finalizeCompletedPlanChangeSchedule(input) {
      const subscription = await retrieve(input.subscriptionId);
      if (subscription.metadata.workspaceId !== input.workspaceId) throw new WorkspaceBillingError("plan_change_conflict");
      const schedule = expandedSchedule(subscription);
      if (schedule?.status === "active" && ownsSchedule(schedule, input.workspaceId) && !futurePhase(schedule)) await release(schedule, input.workspaceId);
    },
    async synchronizeScheduledSeats(input) {
      if (!Number.isSafeInteger(input.desired) || input.desired < 0) throw new WorkspaceBillingError("plan_change_invalid");
      const subscription = await retrieve(input.subscriptionId);
      const schedule = expandedSchedule(subscription);
      if (!schedule) return;
      if (subscription.metadata.workspaceId !== input.workspaceId || !ownsSchedule(schedule, input.workspaceId)) throw new WorkspaceBillingError("plan_change_schedule_conflict");
      const currentStart = schedule.current_phase?.start_date;
      if (currentStart == null) throw new WorkspaceBillingError("plan_change_conflict");
      const remaining = schedule.phases.filter((phase) => phase.start_date >= currentStart);
      let changed = false;
      const phases = remaining.map((phase) => {
        const base = mappedBase(phaseItems(phase), catalog);
        if (!base) throw new WorkspaceBillingError("plan_change_conflict");
        const value = preservePhase(phase);
        const existing = phase.items.filter((item) => catalog.seatPrice(objectId(item.price) ?? ""));
        value.items = value.items.filter((item) => !catalog.seatPrice(item.price ?? ""));
        if (base.tier === "business" && input.desired > 0) {
          const seatPrice = catalog.seatPrices.find((price) => price.interval === base.interval)?.priceId;
          if (!seatPrice) throw new WorkspaceBillingError("plan_change_not_configured");
          value.items.push({ ...(existing[0] ? preserveItem(existing[0]) : {}), price: seatPrice, quantity: input.desired });
          changed ||= existing.length !== 1 || objectId(existing[0]?.price) !== seatPrice || existing[0]?.quantity !== input.desired;
        } else changed ||= existing.length > 0;
        return value;
      });
      if (!changed) return;
      const fingerprint = createHash("sha256").update(JSON.stringify(phases)).digest("hex").slice(0, 20);
      await stripe.subscriptionSchedules.update(schedule.id, { phases, proration_behavior: "none" }, { idempotencyKey: `narriflow_plan_seats_${schedule.id}_${input.revision}_${fingerprint}` })
        .catch((error) => planChangeFailure(error, "plan_change_conflict"));
    },
  };
}
