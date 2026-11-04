import { appendBillingLeaseWatchdog, queueBillingReconciliation, recoverBillingReconciliation, type BillingReconciliationClaim } from "./billing-reconciliation";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";
import { readExecutionAdmission } from "./execution-admission";
import { appendProgressRevocation, deliverProgressAfterCommit } from "./progress-outbox";
import type { ExecutionDispatchRecord } from "./execution-dispatch";
import {
  billingHealthSchema,
  billingPlanChangeSchema,
  hasFeature,
  PLAN_CATALOG,
  resolvePricingTier,
  type BillingHealth,
  type BillingInterval,
  type PaidPricingTier,
  type PricingTier,
  type BillingPlanChange,
} from "@narriflow/validators";
import { getPrismaClient } from "@narriflow/db/client";
import { Prisma, type WorkspaceBillingAccount } from "@prisma/client";
import { lockWorkspaceUsage } from "./processing-usage";
import { projectRetentionService } from "./project-retention.service";
import { randomUUID } from "node:crypto";
import { createWorkspacePlanChanges, type WorkspacePlanChangeStore, type WorkspacePlanChangeProvider } from "./workspace-plan-change";
import { createPrismaWorkspacePlanChangeStore } from "./workspace-plan-change-store";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";

export type WorkspaceBillingHealth = BillingHealth;

export type WorkspaceBillingAction =
  | "start_checkout"
  | "open_portal"
  | "retry"
  | "contact_support";
export type WorkspaceBillingProductStatus =
  | "active"
  | "trial"
  | "payment_pending"
  | "payment_past_due"
  | "payment_failed"
  | "payment_expired"
  | "paused"
  | "canceled";

export interface BillingCatalogInput {
  basePrices: Array<{
    priceId: string;
    tier: PaidPricingTier;
    interval: BillingInterval;
  }>;
  seatPrices: Array<{ priceId: string; interval: BillingInterval }>;
  worker: {
    leaseMs: number;
    providerDeadlineMs: number;
    providerCallBudget: number;
  };
}

export interface BillingCatalog extends BillingCatalogInput {
  basePrice(priceId: string):
    | { priceId: string; tier: PaidPricingTier; interval: BillingInterval }
    | null;
  seatPrice(priceId: string):
    | { priceId: string; interval: BillingInterval }
    | null;
}

/** Paid tiers in catalog order; Stripe base prices map onto exactly these. */
export const PAID_PRICING_TIERS = (
  Object.keys(PLAN_CATALOG) as PricingTier[]
).filter((tier): tier is PaidPricingTier => tier !== "free");
export const BILLING_INTERVALS: readonly BillingInterval[] = ["monthly", "annual"];

/**
 * The one billing access-projection rule. A Workspace awaiting its first
 * payment is held; a Workspace whose plan does not include team members but
 * still has non-owner members is restricted (the owner keeps billing, member
 * cleanup, viewing, and downloads) until the owner upgrades or removes them.
 * A Workspace without non-owner members is never restricted by this rule.
 */
export function projectWorkspaceAccessStatus(input: {
  tier: PricingTier;
  hasNonOwnerMembers: boolean;
  awaitingFirstPayment: boolean;
}): "active" | "pending_payment" | "restricted" {
  if (input.awaitingFirstPayment) return "pending_payment";
  if (input.hasNonOwnerMembers && !hasFeature(input.tier, "workspace.members")) {
    return "restricted";
  }
  return "active";
}

/** Provider subscription states that can no longer bill or be recovered. */
export const ENDED_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(["canceled", "incomplete_expired"]);
/** Provider states that grant a plan and may grow or shrink a seat item. */
const ENTITLED_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(["active", "trialing", "past_due"]);
/** Unpaid/paused/incomplete subscriptions on Free are recovered in the portal. */
const PORTAL_RECOVERABLE_SUBSCRIPTION_STATUSES = new Set([
  "incomplete",
  "past_due",
  "unpaid",
  "paused",
]);
/**
 * A slot holder that has not bound a provider session within this window is
 * treated as abandoned. Its session URL, if one was ever created, was never
 * returned, because binding is fenced on holding the slot.
 */
const CHECKOUT_PREPARATION_WINDOW_MS = 2 * 60_000;
/**
 * An abandoned open Checkout holds the slot until Stripe verifiably expires
 * it, so keep sessions short. Stripe accepts 30 minutes to 24 hours measured
 * from its own receipt of the request; the extra minute keeps a request that
 * arrives late from falling under the 30-minute minimum.
 */
const CHECKOUT_SESSION_LIFETIME_MS = 31 * 60_000;

export function createBillingCatalog(input: BillingCatalogInput): BillingCatalog {
  const seen = new Set<string>();
  for (const entry of [...input.basePrices, ...input.seatPrices]) {
    if (seen.has(entry.priceId)) {
      throw new Error(`${entry.priceId} is mapped more than once`);
    }
    seen.add(entry.priceId);
  }
  for (const tier of PAID_PRICING_TIERS) {
    for (const interval of BILLING_INTERVALS) {
      const matches = input.basePrices.filter(
        (entry) => entry.tier === tier && entry.interval === interval,
      );
      if (matches.length === 0) {
        throw new Error(`Missing base price for ${tier}/${interval}`);
      }
      if (matches.length > 1) {
        throw new Error(`Multiple base prices for ${tier}/${interval}`);
      }
    }
  }
  for (const interval of BILLING_INTERVALS) {
    const matches = input.seatPrices.filter((entry) => entry.interval === interval);
    if (matches.length === 0) {
      throw new Error(`Missing seat price for business/${interval}`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple seat prices for business/${interval}`);
    }
  }
  const numericLimits = [
    ["leaseMs", input.worker.leaseMs, 1_000, 300_000],
    ["providerDeadlineMs", input.worker.providerDeadlineMs, 100, 120_000],
    ["providerCallBudget", input.worker.providerCallBudget, 1, 20],
  ] as const;
  for (const [name, value, minimum, maximum] of numericLimits) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(
        `worker.${name} must be a finite integer between ${minimum} and ${maximum}`,
      );
    }
  }
  const baseById = new Map(input.basePrices.map((entry) => [entry.priceId, entry]));
  const seatById = new Map(input.seatPrices.map((entry) => [entry.priceId, entry]));
  return {
    ...input,
    basePrice: (priceId) => baseById.get(priceId) ?? null,
    seatPrice: (priceId) => seatById.get(priceId) ?? null,
  };
}

export interface ProviderSubscription {
  id: string;
  /** Raw provider status. Unknown values must preserve the last projection. */
  status: string;
  items: Array<{ id?: string; priceId: string; quantity: number }>;
  createdAt: Date;
  /** Provider-derived status/payment/period timestamp; never webhook receipt time. */
  effectiveAt: Date;
  currentPeriodEnd: Date | null;
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  planChange?: BillingPlanChange | null;
  planScheduleId?: string | null;
}

export interface ProviderCurrentState {
  customerId: string;
  ownership:
    | { kind: "verified"; workspaceId: string }
    | { kind: "missing_metadata" }
    | { kind: "workspace_mismatch" }
    /** The provider verifiably deleted this customer and its subscriptions. */
    | { kind: "customer_deleted" };
  subscriptions: ProviderSubscription[];
}

export interface VerifiedBillingDelivery {
  eventId: string;
  eventType: string;
  providerCreatedAt: Date;
  liveMode: boolean;
  apiVersion: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  checkoutSessionId: string | null;
  workspaceHint: string | null;
}

export const WORKSPACE_BILLING_WAKE_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.expired",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.deleted",
  "customer.subscription.pending_update_applied",
  "customer.subscription.pending_update_expired",
  "subscription_schedule.updated",
  "subscription_schedule.released",
  "subscription_schedule.canceled",
  "subscription_schedule.completed",
  "invoice.paid",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
  "customer.updated",
  "customer.deleted",
] as const;

export interface WorkspaceBillingProvider extends WorkspacePlanChangeProvider {
  verifyDelivery(
    rawBody: string,
    signature: string,
  ): VerifiedBillingDelivery | Promise<VerifiedBillingDelivery>;
  retrieveCurrentState(customerId: string): Promise<ProviderCurrentState>;
  findCustomersByWorkspace?(workspaceId: string): Promise<Array<{ customerId: string }>>;
  createCustomer?(
    input: { workspaceId: string; actorUserId: string },
    idempotencyKey: string,
  ): Promise<{ customerId: string }>;
  findCheckoutSessionsByAttempt?(
    input: { attemptId: string; customerId: string },
  ): Promise<ProviderCheckoutSession[]>;
  createCheckoutSession?(
    input: {
      attemptId: string;
      workspaceId: string;
      actorUserId: string;
      customerId: string;
      priceId: string;
      successUrl: string;
      cancelUrl: string;
      /** When the provider must expire the session if it is not completed. */
      expiresAt: Date;
    },
    idempotencyKey: string,
  ): Promise<ProviderCheckoutSession>;
  retrieveCheckoutSession?(sessionId: string): Promise<ProviderCheckoutSession>;
  createPortalSession?(
    input: { customerId: string; returnUrl: string },
  ): Promise<{ url: string }>;
  createSeatItem?(
    input: {
      subscriptionId: string;
      priceId: string;
      quantity: number;
      prorationBehavior: "create_prorations";
    },
    idempotencyKey: string,
  ): Promise<{ itemId: string }>;
  updateSeatItem?(
    input: {
      itemId: string;
      quantity: number;
      prorationBehavior: "create_prorations";
    },
    idempotencyKey: string,
  ): Promise<void>;
  deleteSeatItem?(
    input: { itemId: string; prorationBehavior: "create_prorations" },
    idempotencyKey: string,
  ): Promise<void>;
  /** Sets `cancel_at_period_end` on this Workspace's subscription. Setting it twice changes nothing. */
  cancelSubscriptionAtPeriodEnd?(
    input: { workspaceId: string; subscriptionId: string },
    idempotencyKey: string,
  ): Promise<void>;
}

export interface ProviderCheckoutSession {
  sessionId: string;
  url: string | null;
  expiresAt: Date;
  status: "open" | "complete" | "expired";
  paymentStatus: string;
  workspaceId?: string;
  attemptId?: string;
}

const isTerminalCheckoutPaymentOutcome = (paymentStatus: string) =>
  paymentStatus === "paid" || paymentStatus === "failed";

const checkoutPaymentOutcomeRank = (paymentStatus: string) =>
  paymentStatus === "paid" ? 2 : paymentStatus === "failed" ? 1 : 0;

export const preservesCheckoutPaymentOutcome = (
  currentPaymentStatus: string | undefined,
  observedPaymentStatus: string,
) =>
  Boolean(
    currentPaymentStatus &&
      isTerminalCheckoutPaymentOutcome(currentPaymentStatus) &&
      checkoutPaymentOutcomeRank(currentPaymentStatus) >=
        checkoutPaymentOutcomeRank(observedPaymentStatus),
  );

export interface WorkspaceBillingView {
  workspaceId: string;
  plan: PricingTier;
  interval: BillingInterval | null;
  status: WorkspaceBillingProductStatus;
  workspaceAccessStatus: "active" | "pending_payment" | "restricted";
  health: WorkspaceBillingHealth;
  renewalOrEndAt: string | null;
  cancelAtPeriodEnd: boolean;
  planChange: BillingPlanChange | null;
  graceDeadlineAt: string | null;
  lastSuccessfulSyncAt: string | null;
  desiredAdditionalSeats: number;
  synchronizedAdditionalSeats: number | null;
  actions: WorkspaceBillingAction[];
}

export interface WorkspaceBillingProjection {
  workspaceId: string;
  ownerUserId: string;
  personal: boolean;
  hasNonOwnerMembers: boolean;
  pricingTier: PricingTier;
  status: "active" | "pending_payment" | "restricted";
  providerCustomerId: string | null;
  canonicalSubscriptionId: string | null;
  interval: BillingInterval | null;
  providerStatus: string | null;
  currentPeriodEnd: Date | null;
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /**
   * The Workspace's owner deleted their account and nobody could take over, so
   * reconciliation must get the subscription cancelled at period end. This is
   * the one cancellation Workspace Billing performs; repair never cancels.
   */
  cancelAtPeriodEndRequested: boolean;
  planChange: BillingPlanChange | null;
  firstPastDueAt: Date | null;
  graceDeadlineAt: Date | null;
  health: WorkspaceBillingHealth;
  attentionReason: string | null;
  lastVerifiedAt: Date | null;
  desiredAdditionalSeats: number;
  synchronizedAdditionalSeats: number | null;
  seatItemId: string | null;
  latestCheckoutSessionId: string | null;
  latestCheckout: {
    status: ProviderCheckoutSession["status"];
    paymentStatus: string;
  } | null;
}

export interface WorkspaceBillingStore extends WorkspacePlanChangeStore {
  readProjection(workspaceId: string): Promise<WorkspaceBillingProjection | null>;
  acceptDelivery(input: {
    delivery: VerifiedBillingDelivery;
    receivedAt: Date;
    wakeReconciliation: boolean;
  }): Promise<{
    kind: "accepted" | "duplicate";
    workspaceId: string | null;
  }>;
  claimAccount(input: {
    workspaceId: string;
    now: Date;
    leaseMs: number;
  }): Promise<{
    workspaceId: string;
    attemptId: string;
    attemptCount: number;
    dueAt: Date;
  } | null>;
  renewClaim(input: {
    workspaceId: string;
    attemptId: string;
    now: Date;
    leaseMs: number;
  }): Promise<boolean>;
  scheduleRetry(input: {
    workspaceId: string;
    attemptId?: string;
    now: Date;
    nextReconcileAt: Date;
    reason: string;
    health: "retrying" | "attention_required";
  }): Promise<boolean>;
  commitVerifiedState(input: {
    workspaceId: string;
    expectedCustomerId: string;
    subscription: ProviderSubscription;
    tier: PricingTier;
    interval: BillingInterval | null;
    workspaceStatus: "active" | "pending_payment" | "restricted";
    health: WorkspaceBillingHealth;
    attentionReason: string | null;
    firstPastDueAt: Date | null;
    graceDeadlineAt: Date | null;
    effectiveAt: Date;
    now: Date;
    attemptId?: string;
    seat?: {
      desired: number;
      observed: number;
      itemId: string | null;
      revision: number;
    };
    /** Seats stay unconverged after a provider failure; retry on the changed cadence. */
    seatConvergenceFailed?: boolean;
  }): Promise<WorkspaceBillingProjection>;
  commitNoSubscriptionState(input: {
    workspaceId: string;
    attemptId: string;
    workspaceStatus: "active" | "pending_payment" | "restricted";
    health: "current" | "activating";
    /** Unbinds the customer and its seat item and frees the Checkout slot. */
    customerDeleted?: boolean;
    now: Date;
  }): Promise<WorkspaceBillingProjection>;
  readDesiredSeatState(workspaceId: string): Promise<{
    desired: number;
    revision: number;
  }>;
  markSeatVerificationDue(input: {
    workspaceId: string;
    now: Date;
  }): Promise<void>;
  readBillingActor(input: {
    workspaceId: string;
    actorUserId: string;
  }): Promise<{ role: "owner" | "admin" | "editor" | "viewer" } | null>;
  prepareCheckoutAttempt(input: {
    workspaceId: string;
    actorUserId: string;
    clientIdempotencyKey: string;
    targetTier: PaidPricingTier;
    interval: BillingInterval;
    catalogVersion: string;
    returnDestination: string;
    now: Date;
  }): Promise<{
    /**
     * `created` takes the Billing Account's open Checkout slot; `existing` is
     * this client key's attempt; `conflict` is this key with changed input;
     * `held` is another key's attempt that holds the slot.
     */
    kind: "created" | "existing" | "conflict" | "held";
    attempt: WorkspaceCheckoutAttempt;
  }>;
  /**
   * Frees the slot only if this attempt still holds it with exactly the
   * session binding the caller verified (`null` = still unbound). Returns
   * false when a concurrent request changed the slot first, so a session bound
   * meanwhile can never lose its slot to a stale decision.
   */
  releaseCheckoutSlot(input: {
    attemptId: string;
    expectedSessionId: string | null;
    now: Date;
  }): Promise<boolean>;
  bindCheckoutCustomer(input: {
    workspaceId: string;
    attemptId: string;
    customerId: string;
    now: Date;
  }): Promise<void>;
  /** Fenced: only the attempt holding the slot may bind a session. */
  bindCheckoutSession(input: {
    attemptId: string;
    sessionId: string;
    expiresAt: Date;
    now: Date;
  }): Promise<void>;
  recordCheckoutState(input: {
    workspaceId: string;
    sessionId: string;
    providerAttemptId?: string;
    status: ProviderCheckoutSession["status"];
    paymentStatus: string;
    source: "return" | "reconciliation";
    wakeReconciliation: boolean;
    reconcileAttemptId?: string;
    now: Date;
  }): Promise<WorkspaceCheckoutAttempt>;
}

export interface WorkspaceCheckoutAttempt {
  id: string;
  workspaceId: string;
  actorUserId: string;
  clientIdempotencyKey: string;
  targetTier: PaidPricingTier;
  interval: BillingInterval;
  catalogVersion: string;
  returnDestination: string;
  customerOperationKey: string;
  checkoutOperationKey: string;
  providerSessionId: string | null;
  expiresAt: Date | null;
  /** Whether this attempt holds the Billing Account's open Checkout slot. */
  holdsSlot: boolean;
  createdAt: Date;
}

const workspaceBillingFailureCatalog = {
  billing_customer_missing: "conflict",
  billing_forbidden: "forbidden",
  billing_portal_required: "conflict",
  checkout_attempt_conflict: "conflict",
  checkout_attempt_invalid: "invalid",
  checkout_attempt_missing: "missing",
  checkout_attempt_terminal: "conflict",
  checkout_in_progress: "conflict",
  checkout_not_configured: "unavailable",
  checkout_session_conflict: "conflict",
  customer_identity_conflict: "conflict",
  portal_not_configured: "unavailable",
  price_not_configured: "unavailable",
  seat_provider_not_configured: "unavailable",
  workspace_not_found: "missing",
  plan_change_invalid: "invalid",
  plan_change_conflict: "conflict",
  plan_change_recovery_required: "conflict",
  plan_change_not_configured: "unavailable",
  plan_change_schedule_conflict: "conflict",
  plan_change_busy: "conflict",
  plan_change_quote_missing: "missing",
  plan_change_quote_expired: "conflict",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type WorkspaceBillingErrorCode =
  keyof typeof workspaceBillingFailureCatalog;

const workspaceBillingSafeMessages: Record<WorkspaceBillingErrorCode, string> = {
  billing_customer_missing: "No billing customer is available for this workspace",
  billing_forbidden: "Only the workspace owner can manage billing",
  billing_portal_required: "Manage the current plan in the billing portal",
  checkout_attempt_conflict: "This Checkout request was already used with different details",
  checkout_attempt_invalid: "The Checkout request is invalid",
  checkout_attempt_missing: "The Checkout request could not be found",
  checkout_attempt_terminal: "The previous Checkout is no longer available. Start a new one safely",
  checkout_in_progress: "Another Checkout for this workspace is already in progress",
  checkout_not_configured: "Billing is temporarily unavailable",
  checkout_session_conflict: "Checkout ownership could not be verified. Contact support",
  customer_identity_conflict: "The billing account needs support before it can be changed",
  portal_not_configured: "The billing portal is temporarily unavailable",
  price_not_configured: "This plan is temporarily unavailable",
  seat_provider_not_configured: "Seat billing is temporarily unavailable",
  workspace_not_found: "The workspace could not be found",
  plan_change_invalid: "Choose a different plan or billing interval",
  plan_change_conflict: "Billing changed since this quote. Review a fresh quote before continuing",
  plan_change_recovery_required: "Resolve the current payment or cancellation in billing before changing plans",
  plan_change_not_configured: "Plan changes are temporarily unavailable",
  plan_change_schedule_conflict: "This subscription schedule needs support before it can be changed",
  plan_change_busy: "Billing is updating. Try again in a moment",
  plan_change_quote_missing: "This plan-change quote could not be found",
  plan_change_quote_expired: "This quote expired. Review a fresh quote before continuing",
};

export type WorkspaceBillingErrorDetails = Record<string, string | null>;

export class WorkspaceBillingError extends ExpectedDomainFailureError<
  WorkspaceBillingErrorCode,
  WorkspaceBillingErrorDetails
> {
  constructor(code: WorkspaceBillingErrorCode, details?: WorkspaceBillingErrorDetails) {
    super({
      code,
      kind: workspaceBillingFailureCatalog[code],
      message: workspaceBillingSafeMessages[code],
      ...(details ? { details } : {}),
    });
    this.name = "WorkspaceBillingError";
  }
}

export class WorkspaceBillingAttemptLost extends Error {
  constructor() {
    super("Workspace Billing reconciliation attempt lost");
    this.name = "WorkspaceBillingAttemptLost";
  }
}

export function nextVerifiedReconcileAt(input: {
  now: Date;
  health: WorkspaceBillingHealth;
  changed: boolean;
  seatStillDue: boolean;
}): Date {
  if (input.seatStillDue) return input.now;
  if (input.health === "activating") {
    return new Date(input.now.getTime() + 30_000);
  }
  if (input.health === "payment_action_required" || input.changed) {
    return new Date(input.now.getTime() + 5 * 60_000);
  }
  if (input.health === "attention_required" || input.health === "retrying") {
    return new Date(input.now.getTime() + 6 * 60 * 60_000);
  }
  return new Date(input.now.getTime() + 24 * 60 * 60_000);
}

function billingHealth(value: string): WorkspaceBillingHealth {
  return billingHealthSchema.parse(value);
}

function snapshotPlanChange(snapshot: unknown): BillingPlanChange | null {
  if (!snapshot || typeof snapshot !== "object" || !("planChange" in snapshot) || snapshot.planChange == null) return null;
  return billingPlanChangeSchema.parse(snapshot.planChange);
}

const projectionWorkspaceSelect = {
  id: true,
  ownerUserId: true,
  personalOwnerUserId: true,
  pricingTier: true,
  status: true,
  members: {
    where: { role: { not: "owner" } },
    select: { id: true },
    take: 1,
  },
  billingAccount: true,
} as const;

const latestCheckoutQuery = (billingAccountId: string) => ({
  where: { billingAccountId },
  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  select: {
    providerSessionId: true,
    sessionStatus: true,
    paymentStatus: true,
  },
}) satisfies Prisma.WorkspaceCheckoutAttemptFindFirstArgs;

function toProjection(
  workspace: {
    id: string;
    ownerUserId: string;
    personalOwnerUserId: string | null;
    pricingTier: string;
    status: WorkspaceBillingProjection["status"];
    members: unknown[];
  },
  account: WorkspaceBillingAccount,
  latestCheckout: {
    providerSessionId: string | null;
    sessionStatus: string | null;
    paymentStatus: string | null;
  } | null,
): WorkspaceBillingProjection {
  return {
    workspaceId: workspace.id,
    ownerUserId: workspace.ownerUserId,
    personal: Boolean(workspace.personalOwnerUserId),
    hasNonOwnerMembers: workspace.members.length > 0,
    pricingTier: resolvePricingTier(workspace.pricingTier),
    status: workspace.status,
    providerCustomerId: account.providerCustomerId,
    canonicalSubscriptionId: account.canonicalSubscriptionId,
    interval:
      account.billingInterval === "monthly" || account.billingInterval === "annual"
        ? account.billingInterval
        : null,
    providerStatus: account.providerStatus,
    currentPeriodEnd: account.currentPeriodEndAt,
    trialEnd: account.trialEndAt,
    cancelAtPeriodEnd: account.cancelAtPeriodEnd,
    cancelAtPeriodEndRequested: account.cancelAtPeriodEndRequestedAt !== null,
    planChange: snapshotPlanChange(account.snapshot),
    firstPastDueAt: account.firstPastDueAt,
    graceDeadlineAt: account.graceDeadlineAt,
    health: billingHealth(account.health),
    attentionReason: account.attentionReason,
    lastVerifiedAt: account.lastVerifiedAt,
    desiredAdditionalSeats: account.desiredAdditionalSeats,
    synchronizedAdditionalSeats: account.synchronizedAdditionalSeats,
    seatItemId: account.seatItemId,
    latestCheckoutSessionId: latestCheckout?.providerSessionId ?? null,
    latestCheckout:
      latestCheckout &&
      (latestCheckout.sessionStatus === "open" ||
        latestCheckout.sessionStatus === "complete" ||
        latestCheckout.sessionStatus === "expired") &&
      latestCheckout.paymentStatus
        ? {
            status: latestCheckout.sessionStatus,
            paymentStatus: latestCheckout.paymentStatus,
          }
        : null,
  };
}

export function createPrismaWorkspaceBillingStore(options: { register?(ids: readonly string[]): Promise<void> } = {}): WorkspaceBillingStore {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("DATABASE_URL is required for Workspace Billing");

  return {
    ...createPrismaWorkspacePlanChangeStore(prisma),
    async releasePlanChangeClaim(input) {
      await prisma.$transaction(async tx => {
      await readExecutionAdmission(tx);
      const changed = await tx.workspaceBillingAccount.updateMany({
        where: { workspaceId: input.workspaceId, reconcileAttemptId: input.attemptId },
        data: { reconcileAttemptId: null, leaseExpiresAt: null, ...(input.wake ? { nextReconcileAt: input.now } : {}) },
      });
      if (changed.count) await queueBillingReconciliation(tx, input.workspaceId);
      });
    },
    async readProjection(workspaceId) {
      const row = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: projectionWorkspaceSelect,
      });
      if (!row?.billingAccount) return null;
      const latestCheckout = await prisma.workspaceCheckoutAttempt.findFirst(
        latestCheckoutQuery(row.billingAccount.id),
      );
      return toProjection(row, row.billingAccount, latestCheckout);
    },
    async readBillingActor(input) {
      const membership = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: input.actorUserId,
          },
        },
        select: { role: true },
      });
      return membership;
    },
    async readDesiredSeatState(workspaceId) {
      const [desired, account] = await Promise.all([
        prisma.workspaceMember.count({
          where: { workspaceId, role: { in: ["admin", "editor"] } },
        }),
        prisma.workspaceBillingAccount.findUnique({
          where: { workspaceId },
          select: { seatRevision: true },
        }),
      ]);
      if (!account) {
        throw new WorkspaceBillingError("workspace_not_found");
      }
      return { desired, revision: account.seatRevision };
    },
    async prepareCheckoutAttempt(input) {
      const prepared = await prisma.$transaction(async tx => {
        await readExecutionAdmission(tx);
        const key = `billing-checkout:${input.clientIdempotencyKey}`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0)) IS NULL AS "locked"`;
        await lockWorkspaceUsage(tx, input.workspaceId);
        await tx.$queryRaw`SELECT "id" FROM "WorkspaceBillingAccount" WHERE "workspaceId"=${input.workspaceId}::uuid FOR UPDATE`;
        const accept = async <T>(result: T) => ({ result, reference: await recoverBillingReconciliation(tx, input.workspaceId) });

        const toAttempt = (row: {
          id: string;
          billingAccount: { workspaceId: string };
          actorUserId: string;
          clientIdempotencyKey: string;
          targetTier: string;
          interval: string;
          catalogVersion: string;
          returnDestination: string;
          customerOperationKey: string;
          checkoutOperationKey: string;
          providerSessionId: string | null;
          expiresAt: Date | null;
          activeBillingAccountId: string | null;
          createdAt: Date;
        }): WorkspaceCheckoutAttempt => {
          if (
            row.targetTier !== "creator" &&
            row.targetTier !== "pro" &&
            row.targetTier !== "business"
          ) {
            throw new WorkspaceBillingError(
              "checkout_attempt_invalid",
            );
          }
          if (row.interval !== "monthly" && row.interval !== "annual") {
            throw new WorkspaceBillingError(
              "checkout_attempt_invalid",
            );
          }
          return {
            id: row.id,
            workspaceId: row.billingAccount.workspaceId,
            actorUserId: row.actorUserId,
            clientIdempotencyKey: row.clientIdempotencyKey,
            targetTier: row.targetTier,
            interval: row.interval,
            catalogVersion: row.catalogVersion,
            returnDestination: row.returnDestination,
            customerOperationKey: row.customerOperationKey,
            checkoutOperationKey: row.checkoutOperationKey,
            providerSessionId: row.providerSessionId,
            expiresAt: row.expiresAt,
            holdsSlot: row.activeBillingAccountId !== null,
            createdAt: row.createdAt,
          };
        };
        const classify = (attempt: WorkspaceCheckoutAttempt) => {
          const unchanged =
            attempt.workspaceId === input.workspaceId &&
            attempt.actorUserId === input.actorUserId &&
            attempt.targetTier === input.targetTier &&
            attempt.interval === input.interval &&
            attempt.catalogVersion === input.catalogVersion &&
            attempt.returnDestination === input.returnDestination;
          return {
            kind: unchanged ? ("existing" as const) : ("conflict" as const),
            attempt,
          };
        };
        const select = {
          id: true,
          actorUserId: true,
          clientIdempotencyKey: true,
          targetTier: true,
          interval: true,
          catalogVersion: true,
          returnDestination: true,
          customerOperationKey: true,
          checkoutOperationKey: true,
          providerSessionId: true,
          expiresAt: true,
          activeBillingAccountId: true,
          createdAt: true,
          billingAccount: { select: { workspaceId: true } },
        } as const;
        const account = await tx.workspaceBillingAccount.findUnique({
          where: { workspaceId: input.workspaceId },
          select: { id: true },
        });
        if (!account) throw new WorkspaceBillingError("workspace_not_found");
        // The unique slot column admits one holder. A lost insert race (on the
        // client key or the slot) re-reads; it never creates a second holder.
        for (let pass = 0; pass < 3; pass += 1) {
          const existing = await tx.workspaceCheckoutAttempt.findUnique({
            where: { clientIdempotencyKey: input.clientIdempotencyKey },
            select,
          });
          if (existing) return accept(classify(toAttempt(existing)));
          const holder = await tx.workspaceCheckoutAttempt.findUnique({
            where: { activeBillingAccountId: account.id },
            select,
          });
          if (holder) return accept({ kind: "held" as const, attempt: toAttempt(holder) });
          const id = randomUUID();
          try {
            const created = await tx.workspaceCheckoutAttempt.create({
              data: {
                id,
                billingAccountId: account.id,
                activeBillingAccountId: account.id,
                actorUserId: input.actorUserId,
                clientIdempotencyKey: input.clientIdempotencyKey,
                targetTier: input.targetTier,
                interval: input.interval,
                catalogVersion: input.catalogVersion,
                returnDestination: input.returnDestination,
                customerOperationKey: `workspace-customer-${input.workspaceId}`,
                checkoutOperationKey: `workspace-checkout-${id}`,
                createdAt: input.now,
              },
              select,
            });
            return accept({ kind: "created" as const, attempt: toAttempt(created) });
          } catch (error) {
            if (
              !(
                error &&
                typeof error === "object" &&
                "code" in error &&
                error.code === "P2002"
              )
            ) {
              throw error;
            }
          }
        }
        throw new WorkspaceBillingError("checkout_in_progress");
      });
      if (prepared.reference) await (options.register ?? deliverExecutionDispatches)([prepared.reference.dispatchId]);
      return prepared.result;
    },
    async releaseCheckoutSlot(input) {
      // One conditional row update: it serializes with bindCheckoutSession on
      // the same row, so exactly one of a bind and a stale release wins.
      const released = await prisma.workspaceCheckoutAttempt.updateMany({
        where: {
          id: input.attemptId,
          activeBillingAccountId: { not: null },
          providerSessionId: input.expectedSessionId,
        },
        data: { activeBillingAccountId: null },
      });
      return released.count === 1;
    },
    async bindCheckoutCustomer(input) {
      await prisma.$transaction(async (tx) => {
        await readExecutionAdmission(tx);
        const attempt = await tx.workspaceCheckoutAttempt.findUnique({
          where: { id: input.attemptId },
          select: { billingAccount: { select: { id: true, workspaceId: true, providerCustomerId: true } } },
        });
        if (
          !attempt ||
          attempt.billingAccount.workspaceId !== input.workspaceId
        ) {
          throw new WorkspaceBillingError(
            "checkout_attempt_missing",
          );
        }
        const currentCustomerId = attempt.billingAccount.providerCustomerId;
        if (currentCustomerId && currentCustomerId !== input.customerId) {
          throw new WorkspaceBillingError(
            "customer_identity_conflict",
          );
        }
        await tx.workspaceBillingAccount.update({
          where: { id: attempt.billingAccount.id },
          data: { providerCustomerId: input.customerId },
        });
        await tx.workspaceCheckoutAttempt.update({
          where: { id: input.attemptId },
          data: { providerPhase: "customer_bound" },
        });
        await queueBillingReconciliation(tx, input.workspaceId);
      });
    },
    async bindCheckoutSession(input) {
      const bound = await prisma.workspaceCheckoutAttempt.updateMany({
        where: {
          id: input.attemptId,
          activeBillingAccountId: { not: null },
          OR: [
            { providerSessionId: null },
            { providerSessionId: input.sessionId },
          ],
        },
        data: {
          providerSessionId: input.sessionId,
          providerPhase: "session_bound",
          expiresAt: input.expiresAt,
        },
      });
      if (bound.count === 1) return;
      const attempt = await prisma.workspaceCheckoutAttempt.findUnique({
        where: { id: input.attemptId },
        select: { activeBillingAccountId: true },
      });
      if (!attempt) throw new WorkspaceBillingError("checkout_attempt_missing");
      throw new WorkspaceBillingError(
        attempt.activeBillingAccountId
          ? "checkout_session_conflict"
          : "checkout_attempt_terminal",
      );
    },
    async recordCheckoutState(input) {
      return prisma.$transaction(async (tx) => {
        await readExecutionAdmission(tx);
        await lockWorkspaceUsage(tx, input.workspaceId);
        await tx.$queryRaw`SELECT "id" FROM "WorkspaceBillingAccount" WHERE "workspaceId"=${input.workspaceId}::uuid FOR UPDATE`;
        const attempt = await tx.workspaceCheckoutAttempt.findUnique({
          where: { providerSessionId: input.sessionId },
          select: {
            id: true,
            actorUserId: true,
            clientIdempotencyKey: true,
            targetTier: true,
            interval: true,
            catalogVersion: true,
            returnDestination: true,
            customerOperationKey: true,
            checkoutOperationKey: true,
            providerSessionId: true,
            expiresAt: true,
            paymentStatus: true,
            activeBillingAccountId: true,
            createdAt: true,
            billingAccount: {
              select: {
                id: true,
                workspaceId: true,
              },
            },
          },
        });
        if (
          !attempt ||
          attempt.billingAccount.workspaceId !== input.workspaceId ||
          (input.providerAttemptId && attempt.id !== input.providerAttemptId)
        ) {
          throw new WorkspaceBillingError(
            "checkout_session_conflict",
          );
        }
        if (
          attempt.targetTier !== "creator" &&
          attempt.targetTier !== "pro" &&
          attempt.targetTier !== "business"
        ) {
          throw new WorkspaceBillingError(
            "checkout_attempt_invalid",
          );
        }
        if (attempt.interval !== "monthly" && attempt.interval !== "annual") {
          throw new WorkspaceBillingError(
            "checkout_attempt_invalid",
          );
        }
        const claimWhere = input.reconcileAttemptId
          ? {
              billingAccount: {
                reconcileAttemptId: input.reconcileAttemptId,
                leaseExpiresAt: { gt: input.now },
              },
            }
          : {};
        const providerPhase =
          input.source === "return" ? "return_observed" : "state_retrieved";
        const protectedPaymentStatuses =
          input.paymentStatus === "paid" ? ["paid"] : ["paid", "failed"];
        let preservesEstablishedOutcome = false;
        const updated = await tx.workspaceCheckoutAttempt.updateMany({
          where: {
            id: attempt.id,
            ...claimWhere,
            OR: [
              { paymentStatus: null },
              { paymentStatus: { notIn: protectedPaymentStatuses } },
            ],
          },
          data: {
            providerPhase,
            sessionStatus: input.status,
            paymentStatus: input.paymentStatus,
          },
        });
        if (updated.count === 0) {
          const preserved = await tx.workspaceCheckoutAttempt.updateMany({
            where: {
              id: attempt.id,
              ...claimWhere,
              paymentStatus: { in: protectedPaymentStatuses },
            },
            data: {
              providerPhase,
              sessionStatus: input.status,
            },
          });
          preservesEstablishedOutcome = preserved.count === 1;
        }
        if (updated.count === 0 && !preservesEstablishedOutcome) {
          if (input.reconcileAttemptId) throw new WorkspaceBillingAttemptLost();
          throw new WorkspaceBillingError(
            "checkout_session_conflict",
          );
        }
        const recordedPaymentStatus = preservesEstablishedOutcome
          ? attempt.paymentStatus
          : input.paymentStatus;
        // An expired or failed session can no longer become a subscription.
        const releasesSlot =
          attempt.activeBillingAccountId !== null &&
          (input.status === "expired" || recordedPaymentStatus === "failed");
        if (releasesSlot) {
          await tx.workspaceCheckoutAttempt.update({
            where: { id: attempt.id },
            data: { activeBillingAccountId: null },
          });
        }
        if (input.wakeReconciliation && !preservesEstablishedOutcome) {
          const account = await tx.workspaceBillingAccount.findUniqueOrThrow({ where: { id: attempt.billingAccount.id } });
          const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
          if (!clock) throw new WorkspaceBillingAttemptLost();
          const reconciling = account.reconcileAttemptId !== null && account.leaseExpiresAt !== null && account.leaseExpiresAt > clock.now;
          await tx.workspaceBillingAccount.update({
            where: { id: attempt.billingAccount.id },
            data: {
              health: "activating",
              attentionReason: null,
              ...(reconciling ? {} : { nextReconcileAt: input.now }),
            },
          });
          // A browser observation asks the current provider read to finish.
          // It cannot revoke that reader and discard a concurrent payment fact.
          if (reconciling) await recoverBillingReconciliation(tx, attempt.billingAccount.workspaceId);
          else await queueBillingReconciliation(tx, attempt.billingAccount.workspaceId);
        }
        return {
          id: attempt.id,
          workspaceId: attempt.billingAccount.workspaceId,
          actorUserId: attempt.actorUserId,
          clientIdempotencyKey: attempt.clientIdempotencyKey,
          targetTier: attempt.targetTier,
          interval: attempt.interval,
          catalogVersion: attempt.catalogVersion,
          returnDestination: attempt.returnDestination,
          customerOperationKey: attempt.customerOperationKey,
          checkoutOperationKey: attempt.checkoutOperationKey,
          providerSessionId: attempt.providerSessionId,
          expiresAt: attempt.expiresAt,
          holdsSlot: attempt.activeBillingAccountId !== null && !releasesSlot,
          createdAt: attempt.createdAt,
        };
      });
    },
    async acceptDelivery(input) {
      try {
        return await prisma.$transaction(async (tx) => {
        await readExecutionAdmission(tx);
          const existing = await tx.webhookDeliveryLog.findUnique({
            where: {
              provider_eventId: {
                provider: "stripe",
                eventId: input.delivery.eventId,
              },
            },
            select: {
              workspaceBillingAccount: { select: { workspaceId: true } },
            },
          });
          if (existing) {
            if (input.wakeReconciliation && existing.workspaceBillingAccount) await recoverBillingReconciliation(tx, existing.workspaceBillingAccount.workspaceId);
            return {
              kind: "duplicate" as const,
              workspaceId:
                existing.workspaceBillingAccount?.workspaceId ?? null,
            };
          }

          const identityMatches = [
            ...(input.delivery.customerId
              ? [{ providerCustomerId: input.delivery.customerId }]
              : []),
            ...(input.delivery.subscriptionId
              ? [
                  {
                    canonicalSubscriptionId:
                      input.delivery.subscriptionId,
                  },
                ]
              : []),
            ...(input.delivery.workspaceHint &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              input.delivery.workspaceHint,
            )
              ? [{ workspaceId: input.delivery.workspaceHint }]
              : []),
          ];
          const candidates =
            identityMatches.length > 0
              ? await tx.workspaceBillingAccount.findMany({
                  where: { OR: identityMatches },
                  take: 3,
                })
              : [];
          const account =
            candidates.find(
              (candidate) =>
                input.delivery.customerId &&
                candidate.providerCustomerId === input.delivery.customerId,
            ) ??
            candidates.find(
              (candidate) =>
                input.delivery.subscriptionId &&
                candidate.canonicalSubscriptionId ===
                  input.delivery.subscriptionId,
            ) ??
            null;

          await tx.webhookDeliveryLog.create({
            data: {
              provider: "stripe",
              eventId: input.delivery.eventId,
              eventType: input.delivery.eventType,
              status:
                input.wakeReconciliation && account
                  ? "accepted"
                  : input.wakeReconciliation
                    ? "unmapped"
                    : "ignored",
              payload: undefined,
              providerCreatedAt: input.delivery.providerCreatedAt,
              liveMode: input.delivery.liveMode,
              apiVersion: input.delivery.apiVersion,
              subjectCustomerId: input.delivery.customerId,
              subjectSubscriptionId: input.delivery.subscriptionId,
              subjectCheckoutSessionId:
                input.delivery.checkoutSessionId,
              workspaceHint:
                input.delivery.workspaceHint &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                  input.delivery.workspaceHint,
                )
                  ? input.delivery.workspaceHint
                  : null,
              workspaceBillingAccountId: account?.id ?? null,
              processedAt: input.receivedAt,
            },
          });
          if (input.wakeReconciliation && account) {
            await tx.workspaceBillingAccount.update({
              where: { id: account.id },
              data: { nextReconcileAt: input.receivedAt },
            });
            await queueBillingReconciliation(tx, account.workspaceId);
          }
          return {
            kind: "accepted" as const,
            workspaceId: account?.workspaceId ?? null,
          };
        });
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "P2002"
        ) {
          const duplicate = await prisma.webhookDeliveryLog.findUnique({
            where: {
              provider_eventId: {
                provider: "stripe",
                eventId: input.delivery.eventId,
              },
            },
            select: {
              workspaceBillingAccount: { select: { workspaceId: true } },
            },
          });
          if (duplicate) {
            return {
              kind: "duplicate" as const,
              workspaceId:
                duplicate.workspaceBillingAccount?.workspaceId ?? null,
            };
          }
        }
        throw error;
      }
    },
    async claimAccount(input) {
      const prepared = await prisma.$transaction(async tx => {
        const { epoch } = await readExecutionAdmission(tx);
        await lockWorkspaceUsage(tx, input.workspaceId);
        await tx.$queryRaw`SELECT "id" FROM "WorkspaceBillingAccount" WHERE "workspaceId"=${input.workspaceId}::uuid FOR UPDATE`;
        const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
        if (!clock) throw new WorkspaceBillingAttemptLost();
        const initial = await tx.workspaceBillingAccount.findUnique({ where: { workspaceId: input.workspaceId } });
        if (!initial || initial.leaseExpiresAt && initial.leaseExpiresAt > clock.now) return null;
        await tx.workspaceBillingAccount.update({ where: { workspaceId: input.workspaceId }, data: { nextReconcileAt: clock.now } });
        const reference = await queueBillingReconciliation(tx, input.workspaceId);
        const account = await tx.workspaceBillingAccount.update({ where: { workspaceId: input.workspaceId },
          data: { reconcileAttemptId: randomUUID(), reconciliationEpoch: epoch,
            leaseExpiresAt: new Date(clock.now.getTime() + input.leaseMs), attemptCount: { increment: 1 } } });
        const watchdogId = await appendBillingLeaseWatchdog(tx, reference, account.leaseExpiresAt!);
        return { claim: { workspaceId: account.workspaceId, attemptId: account.reconcileAttemptId!, attemptCount: account.attemptCount, dueAt: account.nextReconcileAt },
          reference, watchdogId };
      });
      if (!prepared) return null;
      try { await (options.register ?? deliverExecutionDispatches)([prepared.watchdogId, prepared.reference.dispatchId]); }
      catch (error) {
        await prisma.$transaction(async tx => {
          const { epoch } = await readExecutionAdmission(tx);
          if (epoch !== prepared.reference.deploymentEpoch) return;
          await tx.workspaceBillingAccount.updateMany({ where: { workspaceId: input.workspaceId, reconciliationEpoch: epoch,
            reconciliationGeneration: prepared.reference.generation, reconcileAttemptId: prepared.claim.attemptId },
            data: { reconcileAttemptId: null, leaseExpiresAt: null, attemptCount: { decrement: 1 } } });
        });
        throw error;
      }
      return prepared.claim;
    },
    async renewClaim(input) {
      return prisma.$transaction(async tx => {
        const { epoch } = await readExecutionAdmission(tx);
        await tx.$queryRaw`SELECT "id" FROM "WorkspaceBillingAccount" WHERE "workspaceId"=${input.workspaceId}::uuid FOR UPDATE`;
        const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
        if (!clock) throw new WorkspaceBillingAttemptLost();
        const renewed = await tx.workspaceBillingAccount.updateMany({ where: { workspaceId: input.workspaceId,
          reconciliationEpoch: epoch, reconcileAttemptId: input.attemptId, leaseExpiresAt: { gt: clock.now } },
          data: { leaseExpiresAt: new Date(clock.now.getTime() + input.leaseMs) } });
        return renewed.count === 1;
      });
    },
    async scheduleRetry(input) {
      return prisma.$transaction(async tx => {
      const { epoch } = await readExecutionAdmission(tx);
      await lockWorkspaceUsage(tx, input.workspaceId);
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
      if (!clock) throw new WorkspaceBillingAttemptLost();
      const settled = await tx.workspaceBillingAccount.updateMany({
        where: {
          workspaceId: input.workspaceId,
          reconciliationEpoch: epoch,
          ...(input.attemptId
            ? {
                reconcileAttemptId: input.attemptId,
                leaseExpiresAt: { gt: clock.now },
              }
            : {}),
        },
        data: {
          reconcileAttemptId: null,
          leaseExpiresAt: null,
          nextReconcileAt: input.nextReconcileAt,
          health: input.health,
          attentionReason: input.reason,
        },
      });
      if (settled.count) await queueBillingReconciliation(tx, input.workspaceId);
      return settled.count === 1;
      });
    },
    async markSeatVerificationDue(input) {
      await prisma.$transaction(async tx => {
      await readExecutionAdmission(tx);
      await tx.workspaceBillingAccount.update({
        where: { workspaceId: input.workspaceId },
        data: {
          seatRevision: { increment: 1 },
          nextReconcileAt: input.now,
        },
      });
      await queueBillingReconciliation(tx, input.workspaceId);
      });
    },
    async commitNoSubscriptionState(input) {
      const revocations: ExecutionDispatchRecord[] = [];
      const result = await prisma.$transaction<WorkspaceBillingProjection>(async (tx) => {
        const { epoch } = await readExecutionAdmission(tx);
        // Access projection changes share the Workspace usage lock so a
        // concurrent intake reservation observes either the old or new status.
        // Lock order: usage lock, then Project rows, then billing rows.
        await lockWorkspaceUsage(tx, input.workspaceId);
        await tx.$queryRaw`SELECT "id" FROM "WorkspaceBillingAccount" WHERE "workspaceId"=${input.workspaceId}::uuid FOR UPDATE`;
        const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
        if (!clock) throw new WorkspaceBillingAttemptLost();
        const row = await tx.workspace.findUnique({
          where: { id: input.workspaceId },
          select: projectionWorkspaceSelect,
        });
        if (!row?.billingAccount) throw new Error("Workspace not found");
        const workspaceStatus = projectWorkspaceAccessStatus({
          tier: "free",
          hasNonOwnerMembers: row.members.length > 0,
          awaitingFirstPayment: input.workspaceStatus === "pending_payment",
        });
        const stateChanged =
          Boolean(input.customerDeleted) ||
          row.pricingTier !== "free" ||
          row.status !== workspaceStatus ||
          row.billingAccount.health !== input.health;
        const fenced = await tx.workspaceBillingAccount.updateMany({
          where: {
            workspaceId: input.workspaceId,
            reconcileAttemptId: input.attemptId,
              reconciliationEpoch: epoch,
            leaseExpiresAt: { gt: clock.now },
          },
          data: {
            canonicalSubscriptionId: null,
            billingInterval: null,
            providerStatus: null,
            currentPeriodEndAt: null,
            trialEndAt: null,
            cancelAtPeriodEnd: false,
            firstPastDueAt: null,
            graceDeadlineAt: null,
            health: input.health,
            attentionReason: null,
            nextReconcileAt: nextVerifiedReconcileAt({
              now: input.now,
              health: input.health,
              changed: stateChanged,
              seatStillDue: false,
            }),
            reconcileAttemptId: null,
            leaseExpiresAt: null,
            attemptCount: 0,
            snapshot: Prisma.JsonNull,
            ...(input.customerDeleted
              ? { providerCustomerId: null, seatItemId: null, synchronizedAdditionalSeats: null }
              : {}),
          },
        });
        if (fenced.count !== 1) throw new WorkspaceBillingAttemptLost();
        if (row.pricingTier !== "free") {
          await projectRetentionService.applyWorkspaceTierTransition(tx, {
            workspaceId: row.id,
            previousTier: row.pricingTier,
            nextTier: "free",
            effectiveAt: input.now,
            observedAt: input.now,
          });
        }
        if (workspaceStatus !== "active" && row.status !== workspaceStatus) {
          revocations.push(await appendProgressRevocation(tx, { workspaceId: row.id, error: "workspace_restricted" }));
        }
        await tx.workspace.update({
          where: { id: input.workspaceId },
          data: { pricingTier: "free", status: workspaceStatus },
        });
        const account = await tx.workspaceBillingAccount.findUniqueOrThrow({
          where: { workspaceId: input.workspaceId },
        });
        // A session of a deleted customer can never activate, whatever its
        // state, so it must not hold the slot against the owner's next Checkout.
        if (input.customerDeleted) {
          await tx.workspaceCheckoutAttempt.updateMany({
            where: { activeBillingAccountId: account.id },
            data: { activeBillingAccountId: null },
          });
        }
        if (stateChanged) {
          await tx.workspaceBillingTransition.create({
            data: {
              billingAccountId: account.id,
              previousTier: row.pricingTier,
              nextTier: "free",
              previousStatus: row.status,
              nextStatus: workspaceStatus,
              reason: input.customerDeleted ? "provider_customer_deleted" : "provider_current_state_verified",
              effectiveAt: input.now,
              observedAt: input.now,
            },
          });
        }
        await tx.webhookDeliveryLog.updateMany({
          where: {
            workspaceBillingAccountId: account.id,
            status: "accepted",
          },
          data: {
            status: "reconciled",
            processedAt: input.now,
          },
        });
        const latestCheckout = await tx.workspaceCheckoutAttempt.findFirst(latestCheckoutQuery(account.id));
        await queueBillingReconciliation(tx, row.id);
        return toProjection({ ...row, pricingTier: "free", status: workspaceStatus }, account, latestCheckout);
      });
      await deliverProgressAfterCommit(prisma, revocations);
      return result;
    },
    async commitVerifiedState(input) {
      const revocations: ExecutionDispatchRecord[] = [];
      const result = await prisma.$transaction<WorkspaceBillingProjection>(async (tx) => {
        const { epoch } = await readExecutionAdmission(tx);
        // Same lock order as commitNoSubscriptionState: usage lock first.
        await lockWorkspaceUsage(tx, input.workspaceId);
        await tx.$queryRaw`SELECT "id" FROM "WorkspaceBillingAccount" WHERE "workspaceId"=${input.workspaceId}::uuid FOR UPDATE`;
        const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
        if (!clock) throw new WorkspaceBillingAttemptLost();
        const row = await tx.workspace.findUnique({
          where: { id: input.workspaceId },
          select: projectionWorkspaceSelect,
        });
        if (!row?.billingAccount) {
          throw new Error("Workspace Billing Account not found");
        }
        if (row.billingAccount.providerCustomerId !== input.expectedCustomerId) {
          throw new Error("Workspace Billing customer mismatch");
        }
        if (input.attemptId) {
          const fenced = await tx.workspaceBillingAccount.updateMany({
            where: {
              id: row.billingAccount.id,
              reconcileAttemptId: input.attemptId,
              reconciliationEpoch: epoch,
              leaseExpiresAt: { gt: clock.now },
            },
            data: { leaseExpiresAt: row.billingAccount.leaseExpiresAt },
          });
          if (fenced.count !== 1) throw new WorkspaceBillingAttemptLost();
        }
        const workspaceStatus = projectWorkspaceAccessStatus({
          tier: input.tier,
          hasNonOwnerMembers: row.members.length > 0,
          awaitingFirstPayment: input.workspaceStatus === "pending_payment",
        });

        const currentDesiredSeats = input.seat
          ? await tx.workspaceMember.count({
              where: {
                workspaceId: row.id,
                role: { in: ["admin", "editor"] },
              },
            })
          : row.billingAccount.desiredAdditionalSeats;
        const seatStillDue = Boolean(
          input.seat &&
            (currentDesiredSeats !== input.seat.observed ||
              row.billingAccount.seatRevision !== input.seat.revision),
        );
        const stateChanged =
          row.pricingTier !== input.tier ||
          row.status !== workspaceStatus ||
          row.billingAccount.canonicalSubscriptionId !== input.subscription.id ||
          row.billingAccount.billingInterval !== input.interval ||
          row.billingAccount.providerStatus !== input.subscription.status ||
          row.billingAccount.currentPeriodEndAt?.getTime() !==
            input.subscription.currentPeriodEnd?.getTime() ||
          row.billingAccount.trialEndAt?.getTime() !== input.subscription.trialEnd?.getTime() ||
          row.billingAccount.cancelAtPeriodEnd !== input.subscription.cancelAtPeriodEnd ||
          row.billingAccount.firstPastDueAt?.getTime() !==
            input.firstPastDueAt?.getTime() ||
          row.billingAccount.graceDeadlineAt?.getTime() !==
            input.graceDeadlineAt?.getTime() ||
          row.billingAccount.health !== input.health ||
          row.billingAccount.attentionReason !== input.attentionReason ||
          (input.seat !== undefined &&
            (row.billingAccount.desiredAdditionalSeats !== currentDesiredSeats ||
              row.billingAccount.synchronizedAdditionalSeats !== input.seat.observed ||
              row.billingAccount.seatItemId !== input.seat.itemId));

        if (row.pricingTier !== input.tier) {
          await projectRetentionService.applyWorkspaceTierTransition(tx, {
            workspaceId: row.id,
            previousTier: row.pricingTier,
            nextTier: input.tier,
            effectiveAt: input.effectiveAt,
            observedAt: input.now,
          });
        }

        if (workspaceStatus !== "active" && row.status !== workspaceStatus) {
          revocations.push(await appendProgressRevocation(tx, { workspaceId: row.id, error: "workspace_restricted" }));
        }
        await tx.workspace.update({
          where: { id: row.id },
          data: { pricingTier: input.tier, status: workspaceStatus },
        });
        const account = await tx.workspaceBillingAccount.update({
          where: { workspaceId: row.id },
          data: {
            canonicalSubscriptionId: input.subscription.id,
            billingInterval: input.interval,
            providerStatus: input.subscription.status,
            currentPeriodEndAt: input.subscription.currentPeriodEnd,
            trialEndAt: input.subscription.trialEnd,
            cancelAtPeriodEnd: input.subscription.cancelAtPeriodEnd,
            firstPastDueAt: input.firstPastDueAt,
            graceDeadlineAt: input.graceDeadlineAt,
            health: input.health,
            attentionReason: input.attentionReason,
            lastVerifiedAt: input.now,
            nextReconcileAt: nextVerifiedReconcileAt({
              now: input.now,
              health: input.health,
              changed: stateChanged || Boolean(input.seatConvergenceFailed),
              seatStillDue: seatStillDue && !input.seatConvergenceFailed,
            }),
            reconcileAttemptId: null,
            leaseExpiresAt: null,
            attemptCount: 0,
            ...(input.seat
              ? {
                  desiredAdditionalSeats: currentDesiredSeats,
                  synchronizedAdditionalSeats: input.seat.observed,
                  seatItemId: input.seat.itemId,
                }
              : {}),
            snapshot: {
              subscriptionId: input.subscription.id,
              status: input.subscription.status,
              priceIds: input.subscription.items.map((item) => item.priceId),
              currentPeriodEnd: input.subscription.currentPeriodEnd?.toISOString() ?? null,
              trialEnd: input.subscription.trialEnd?.toISOString() ?? null,
              cancelAtPeriodEnd: input.subscription.cancelAtPeriodEnd,
              planChange: input.subscription.planChange ?? null,
            },
          },
        });
        if (stateChanged) {
          await tx.workspaceBillingTransition.create({
            data: {
              billingAccountId: account.id,
              previousTier: row.pricingTier,
              nextTier: input.tier,
              previousStatus: row.status,
              nextStatus: workspaceStatus,
              providerStatus: input.subscription.status,
              reason: "provider_current_state_verified",
              effectiveAt: input.effectiveAt,
              observedAt: input.now,
              sourceSubscriptionId: input.subscription.id,
            },
          });
        }
        await tx.webhookDeliveryLog.updateMany({
          where: {
            workspaceBillingAccountId: account.id,
            status: "accepted",
          },
          data: {
            status: "reconciled",
            processedAt: input.now,
          },
        });
        await queueBillingReconciliation(tx, row.id);
        return toProjection({ ...row, pricingTier: input.tier, status: workspaceStatus }, account, null);
      });
      await deliverProgressAfterCommit(prisma, revocations);
      return result;
    },
  };
}

export interface WorkspaceBillingDiagnostics {
  record(event: Record<string, unknown>): void;
}

export type WorkspaceBillingMetricName =
  | "workspace_billing_deliveries_total"
  | "workspace_billing_delivery_latency_ms"
  | "workspace_billing_queue_age_ms"
  | "workspace_billing_claims_total"
  | "workspace_billing_settlements_total"
  | "workspace_billing_operation_duration_ms"
  | "workspace_billing_provider_calls_total"
  | "workspace_billing_retry_delay_ms"
  | "workspace_billing_transitions_total"
  | "workspace_billing_seat_quantity";

export interface WorkspaceBillingMetrics {
  observe(
    name: WorkspaceBillingMetricName,
    value: number,
    attributes: Record<string, string | number | boolean | null>,
  ): void;
}

export interface WorkspaceBillingClock {
  now(): Date;
}

export type ReconcileCurrentStateResult =
  | { kind: "reconciled"; view: WorkspaceBillingView }
  | { kind: "unresolved"; reason: string; view: WorkspaceBillingView };

function billingView(row: WorkspaceBillingProjection): WorkspaceBillingView {
  const productStatus = (): WorkspaceBillingProductStatus => {
    switch (row.providerStatus) {
      case "trialing":
        return "trial";
      case "incomplete":
        return "payment_pending";
      case "past_due":
        return "payment_past_due";
      case "unpaid":
        return "payment_failed";
      case "incomplete_expired":
        return "payment_expired";
      case "paused":
        return "paused";
      case "canceled":
        return "canceled";
      default:
        if (row.latestCheckout?.status === "expired") {
          return "payment_expired";
        }
        if (row.latestCheckout?.paymentStatus === "failed") {
          return "payment_failed";
        }
        return row.status === "pending_payment" ||
          (row.pricingTier === "free" && row.health === "activating")
          ? "payment_pending"
          : "active";
    }
  };
  return {
    workspaceId: row.workspaceId,
    plan: row.pricingTier,
    interval: row.interval,
    status: productStatus(),
    workspaceAccessStatus: row.status,
    health: row.health,
    renewalOrEndAt: (row.trialEnd ?? row.currentPeriodEnd)?.toISOString() ?? null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    planChange: row.planChange,
    graceDeadlineAt: row.graceDeadlineAt?.toISOString() ?? null,
    lastSuccessfulSyncAt: row.lastVerifiedAt?.toISOString() ?? null,
    desiredAdditionalSeats: row.desiredAdditionalSeats,
    synchronizedAdditionalSeats: row.synchronizedAdditionalSeats,
    actions: ((): WorkspaceBillingAction[] => {
      if (row.status === "restricted") {
        return row.providerCustomerId ? ["open_portal"] : ["contact_support"];
      }
      if (row.health === "attention_required") {
        return row.providerCustomerId
          ? ["open_portal", "contact_support"]
          : ["contact_support"];
      }
      if (row.health === "retrying") return ["retry"];
      if (row.health === "activating") return [];
      if (row.pricingTier === "free") {
        // A subscription that can still bill is recovered, never replaced.
        return row.providerStatus &&
          PORTAL_RECOVERABLE_SUBSCRIPTION_STATUSES.has(row.providerStatus)
          ? ["open_portal"]
          : ["start_checkout"];
      }
      return ["open_portal"];
    })(),
  };
}

export function createWorkspaceBillingModule(dependencies: {
  catalog: BillingCatalog;
  store: WorkspaceBillingStore;
  provider: WorkspaceBillingProvider;
  clock: WorkspaceBillingClock;
  diagnostics: WorkspaceBillingDiagnostics;
  metrics?: WorkspaceBillingMetrics;
  random?: () => number;
}) {
  const wakeEventTypes = new Set<string>(WORKSPACE_BILLING_WAKE_EVENT_TYPES);
  const metrics: WorkspaceBillingMetrics = dependencies.metrics ?? {
    observe: () => undefined,
  };
  const retryBand = (attemptCount: number) =>
    attemptCount <= 1 ? "first" : attemptCount <= 3 ? "early" : "persistent";
  const planChanges = createWorkspacePlanChanges(dependencies);
  const callProvider = async <T>(
    operation: string,
    call: () => Promise<T> | T,
  ): Promise<T> => {
    try {
      const value = await call();
      metrics.observe("workspace_billing_provider_calls_total", 1, {
        operation,
        outcome: "success",
      });
      return value;
    } catch (error) {
      metrics.observe("workspace_billing_provider_calls_total", 1, {
        operation,
        outcome: "failure",
      });
      throw error;
    }
  };
  const reconcileOne = async (
    workspaceId: string,
    attemptId?: string,
  ): Promise<ReconcileCurrentStateResult> => {
    const startedAt = dependencies.clock.now();
    const current = await dependencies.store.readProjection(workspaceId);
    if (!current) {
      throw new WorkspaceBillingError("workspace_not_found");
    }
    if (attemptId) {
      // Best effort: entitlements follow the provider whether or not an
      // interrupted plan change can still be resumed.
      if ((await planChanges.recoverConfirmingPlanChange({ workspaceId, attemptId })) === "expired") {
        dependencies.diagnostics.record({ level: "warn", message: "workspace_billing_plan_change_abandoned", workspaceId, phase: "plan_change_recovery" });
      }
    }
    const settleNoSubscription = async (activating: boolean, customerDeleted = false) => {
      if (!attemptId) throw new WorkspaceBillingAttemptLost();
      // Only a Workspace awaiting its first payment is held. An existing Free
      // Workspace keeps working while its Checkout activates.
      const workspaceStatus = projectWorkspaceAccessStatus({
        tier: "free",
        hasNonOwnerMembers: current.hasNonOwnerMembers,
        awaitingFirstPayment: current.status === "pending_payment",
      });
      const settled = await dependencies.store.commitNoSubscriptionState({
        workspaceId,
        attemptId,
        workspaceStatus,
        health: activating ? "activating" : "current",
        customerDeleted,
        now: dependencies.clock.now(),
      });
      const outcome = activating ? "activating" : customerDeleted ? "customer_deleted" : "current_free";
      dependencies.diagnostics.record({
        level: "info",
        message: "workspace_billing_no_subscription_verified",
        workspaceId,
        phase: "projection",
        outcome,
        durationMs: dependencies.clock.now().getTime() - startedAt.getTime(),
      });
      metrics.observe(
        "workspace_billing_operation_duration_ms",
        dependencies.clock.now().getTime() - startedAt.getTime(),
        {
          operation: "current_state",
          outcome,
          health: settled.health,
          accessStatus: settled.status,
        },
      );
      metrics.observe("workspace_billing_transitions_total", 1, {
        transition:
          current.status !== settled.status && settled.status === "restricted"
            ? "access_restricted"
            : activating
              ? "activation_wait"
              : "verified_free",
        health: settled.health,
        accessStatus: settled.status,
      });
      return { kind: "reconciled" as const, view: billingView(settled) };
    };
    if (!current.providerCustomerId) {
      if (current.pricingTier === "free") return settleNoSubscription(false);
      throw new Error("Workspace Billing Account has no provider customer");
    }
    const providerState = await callProvider("retrieve_current_state", () =>
      dependencies.provider.retrieveCurrentState(current.providerCustomerId!),
    );
    const unresolved = (reason: string): ReconcileCurrentStateResult => {
      metrics.observe("workspace_billing_transitions_total", 1, {
        transition: "conflict",
        reason,
        health: "attention_required",
        accessStatus: current.status,
      });
      return { kind: "unresolved", reason, view: billingView(current) };
    };
    if (
      attemptId &&
      !(await dependencies.store.renewClaim({
        workspaceId,
        attemptId,
        now: dependencies.clock.now(),
        leaseMs: dependencies.catalog.worker.leaseMs,
      }))
    ) {
      throw new WorkspaceBillingAttemptLost();
    }
    if (providerState.customerId !== current.providerCustomerId) {
      return unresolved("customer_mismatch");
    }
    if (providerState.ownership.kind === "customer_deleted") {
      return settleNoSubscription(false, true);
    }
    if (providerState.ownership.kind !== "verified") {
      return unresolved(providerState.ownership.kind);
    }
    if (providerState.ownership.workspaceId !== workspaceId) {
      return unresolved("workspace_mismatch");
    }
    let checkoutState = current.latestCheckout;
    if (current.latestCheckoutSessionId) {
      if (!dependencies.provider.retrieveCheckoutSession) {
        return unresolved("checkout_retrieval_unavailable");
      }
      const checkout = await callProvider("retrieve_checkout", () =>
        dependencies.provider.retrieveCheckoutSession!(
          current.latestCheckoutSessionId!,
        ),
      );
      if (
        checkout.sessionId !== current.latestCheckoutSessionId ||
        (checkout.workspaceId && checkout.workspaceId !== workspaceId)
      ) {
        return unresolved("checkout_session_conflict");
      }
      if (
        attemptId &&
        !(await dependencies.store.renewClaim({
          workspaceId,
          attemptId,
          now: dependencies.clock.now(),
          leaseMs: dependencies.catalog.worker.leaseMs,
        }))
      ) {
        throw new WorkspaceBillingAttemptLost();
      }
      const currentPaymentStatus = current.latestCheckout?.paymentStatus;
      const paymentStatus = preservesCheckoutPaymentOutcome(
        currentPaymentStatus,
        checkout.paymentStatus,
      )
        ? currentPaymentStatus!
        : checkout.paymentStatus;
      await dependencies.store.recordCheckoutState({
        workspaceId,
        sessionId: checkout.sessionId,
        providerAttemptId: checkout.attemptId,
        status: checkout.status,
        paymentStatus,
        source: "reconciliation",
        wakeReconciliation: false,
        reconcileAttemptId: attemptId,
        now: dependencies.clock.now(),
      });
      checkoutState = {
        status: checkout.status,
        paymentStatus,
      };
    }
    if (providerState.subscriptions.length === 0) {
      if (current.pricingTier !== "free") {
        return unresolved("missing_paid_subscription");
      }
      return settleNoSubscription(
        checkoutState?.status === "complete" &&
          checkoutState.paymentStatus !== "failed",
      );
    }
    const tierRank: Record<PricingTier, number> = {
      free: 0,
      creator: 1,
      pro: 2,
      business: 3,
    };
    const analyzeItems = (candidate: ProviderSubscription) => {
      const base = candidate.items
        .map((item) => dependencies.catalog.basePrice(item.priceId))
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      const seats = candidate.items
        .map((item) => dependencies.catalog.seatPrice(item.priceId))
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      const seatItems = candidate.items
        .map((item) => ({
          item,
          mapping: dependencies.catalog.seatPrice(item.priceId),
        }))
        .filter(
          (entry): entry is {
            item: (typeof candidate.items)[number];
            mapping: NonNullable<ReturnType<BillingCatalog["seatPrice"]>>;
          } => Boolean(entry.mapping),
        );
      const unknown = candidate.items.filter(
        (item) =>
          !dependencies.catalog.basePrice(item.priceId) &&
          !dependencies.catalog.seatPrice(item.priceId),
      );
      const baseItem = base[0];
      const invalidSeats =
        seats.length > 1 ||
        (seats.length === 1 &&
          (!baseItem ||
            baseItem.tier !== "business" ||
            seats[0]!.interval !== baseItem.interval));
      return { base, seats, seatItems, unknown, invalidSeats };
    };
    const entitlementSubscriptions = providerState.subscriptions.filter(
      (candidate) => ENTITLED_SUBSCRIPTION_STATUSES.has(candidate.status),
    );
    const malformedEntitlement = entitlementSubscriptions
      .map((subscription) => ({ subscription, items: analyzeItems(subscription) }))
      .find(
        ({ items }) =>
          items.base.length !== 1 ||
          items.unknown.length > 0 ||
          items.invalidSeats,
      );
    if (malformedEntitlement) {
      const reason =
        malformedEntitlement.items.unknown.length > 0
          ? "unmapped_price"
          : malformedEntitlement.items.invalidSeats
            ? "invalid_seat_items"
            : "ambiguous_base_price";
      return unresolved(reason);
    }
    const entitlementCandidates = entitlementSubscriptions
      .map((candidate) => ({
        subscription: candidate,
        mappings: analyzeItems(candidate).base,
      }))
      .filter((candidate) => candidate.mappings.length === 1)
      .sort(
        (left, right) =>
          tierRank[right.mappings[0]!.tier] - tierRank[left.mappings[0]!.tier],
      );
    const hasSubscriptionConflict = entitlementCandidates.length > 1;
    // An entitled subscription outranks the stored canonical one, which may be
    // the canceled subscription a returning customer has since replaced.
    const subscription =
      entitlementCandidates[0]?.subscription ??
      providerState.subscriptions.find(
        (candidate) => candidate.id === current.canonicalSubscriptionId,
      ) ??
      providerState.subscriptions.find((candidate) => candidate.status !== "canceled") ??
      providerState.subscriptions[0];
    const selectedItems = subscription ? analyzeItems(subscription) : null;
    const mappedItems = selectedItems?.base;
    if (
      !subscription ||
      !selectedItems ||
      mappedItems?.length !== 1 ||
      selectedItems.unknown.length > 0 ||
      selectedItems.invalidSeats
    ) {
      return unresolved("unsupported_provider_state");
    }
    const mapped = mappedItems[0]!;
    let tier: PricingTier;
    let awaitingFirstPayment = false;
    let health: WorkspaceBillingHealth;
    let attentionReason: string | null = null;
    let firstPastDueAt: Date | null = null;
    let graceDeadlineAt: Date | null = null;
    let effectiveAt = subscription.effectiveAt;
    switch (subscription.status) {
      case "active":
      case "trialing":
        tier = mapped.tier;
        health = "current";
        break;
      case "incomplete":
        tier = "free";
        // Only a Workspace awaiting its first payment is held. An existing
        // Free Workspace keeps working while its upgrade payment completes.
        awaitingFirstPayment = current.status === "pending_payment";
        health = "activating";
        break;
      case "past_due": {
        firstPastDueAt = current.firstPastDueAt ?? dependencies.clock.now();
        graceDeadlineAt =
          current.graceDeadlineAt ??
          new Date(firstPastDueAt.getTime() + 7 * 24 * 60 * 60 * 1000);
        const withinGrace =
          dependencies.clock.now().getTime() < graceDeadlineAt.getTime();
        // A scheduled downgrade can take effect on the renewal that failed.
        const graceTier =
          tierRank[mapped.tier] < tierRank[current.pricingTier]
            ? mapped.tier
            : current.pricingTier;
        tier = withinGrace ? graceTier : "free";
        health = "payment_action_required";
        effectiveAt = withinGrace ? firstPastDueAt : graceDeadlineAt;
        break;
      }
      case "unpaid":
      case "paused":
      case "incomplete_expired":
      case "canceled":
        tier = "free";
        // Only a first successful payment leaves pending_payment, so a
        // subscription that ended while pending was never paid for.
        awaitingFirstPayment = current.status === "pending_payment";
        health = "current";
        break;
      default:
        return unresolved("unsupported_subscription_status");
    }
    if (hasSubscriptionConflict) {
      if (tierRank[current.pricingTier] > tierRank[tier]) {
        tier = current.pricingTier;
      }
      health = "attention_required";
      attentionReason = "multiple_entitlement_subscriptions";
    }
    const workspaceStatus = projectWorkspaceAccessStatus({
      tier,
      hasNonOwnerMembers: current.hasNonOwnerMembers,
      awaitingFirstPayment,
    });
    // Seats converge only on a subscription that can still bill, and a seat
    // failure never blocks committing the verified projection: otherwise an
    // ended plan, or the durable start of past-due grace, could wait forever
    // behind a seat change the provider keeps rejecting.
    let providerSeatMutation = false;
    let seatConvergenceFailed = false;
    let seat:
      | {
          desired: number;
          observed: number;
          itemId: string | null;
          revision: number;
        }
      | undefined;
    if (
      mapped.tier === "business" &&
      !hasSubscriptionConflict &&
      ENTITLED_SUBSCRIPTION_STATUSES.has(subscription.status)
      && subscription.planChange?.state !== "pending_payment"
    ) {
      const desired = await dependencies.store.readDesiredSeatState(workspaceId);
      const providerSeat = selectedItems.seatItems[0]?.item;
      let observed = providerSeat?.quantity ?? 0;
      let itemId = providerSeat?.id ?? null;
      if (providerSeat && !providerSeat.id) {
        return unresolved("seat_item_identity_missing");
      }
      if (observed !== desired.desired) {
        try {
          // A returning subscription or an interval change must never replay an
          // earlier provider operation for the same membership revision. The
          // quantity is part of the key because count and revision are read
          // apart: a retry that counts differently is a different operation.
          const operationKey = `workspace-seat-${workspaceId}-${subscription.id}-${mapped.interval}-${desired.revision}-${desired.desired}`;
          if (!providerSeat && desired.desired > 0) {
            if (!dependencies.provider.createSeatItem) {
              throw new WorkspaceBillingError(
                "seat_provider_not_configured",
              );
            }
            const created = await callProvider("create_seat_item", () =>
              dependencies.provider.createSeatItem!(
                {
                  subscriptionId: subscription.id,
                  priceId:
                    dependencies.catalog.seatPrices.find(
                      (candidate) => candidate.interval === mapped.interval,
                    )?.priceId ?? "",
                  quantity: desired.desired,
                  prorationBehavior: "create_prorations",
                },
                operationKey,
              ),
            );
            providerSeatMutation = true;
            itemId = created.itemId;
            observed = desired.desired;
          } else if (providerSeat && desired.desired === 0) {
            if (!dependencies.provider.deleteSeatItem) {
              throw new WorkspaceBillingError(
                "seat_provider_not_configured",
              );
            }
            await callProvider("delete_seat_item", () =>
              dependencies.provider.deleteSeatItem!(
                {
                  itemId: providerSeat.id!,
                  prorationBehavior: "create_prorations",
                },
                operationKey,
              ),
            );
            providerSeatMutation = true;
            itemId = null;
            observed = 0;
          } else if (providerSeat) {
            if (!dependencies.provider.updateSeatItem) {
              throw new WorkspaceBillingError(
                "seat_provider_not_configured",
              );
            }
            await callProvider("update_seat_item", () =>
              dependencies.provider.updateSeatItem!(
                {
                  itemId: providerSeat.id!,
                  quantity: desired.desired,
                  prorationBehavior: "create_prorations",
                },
                operationKey,
              ),
            );
            providerSeatMutation = true;
            observed = desired.desired;
          }
        } catch (error) {
          if (error instanceof WorkspaceBillingError) throw error;
          seatConvergenceFailed = true;
          dependencies.diagnostics.record({
            level: "warn",
            message: "workspace_billing_seat_convergence_failed",
            workspaceId,
            phase: "seat_convergence",
            desiredAdditionalSeats: desired.desired,
            synchronizedAdditionalSeats: observed,
          });
        }
      }
      // The schedule update can't prorate, so it only follows a live seat change
      // that has already been billed; a failed one is retried first.
      if (subscription.planChange?.state === "scheduled" && !seatConvergenceFailed) {
        try {
          if (!dependencies.provider.synchronizeScheduledSeats) throw new WorkspaceBillingError("plan_change_not_configured");
          providerSeatMutation = true;
          await dependencies.provider.synchronizeScheduledSeats({ workspaceId, subscriptionId: subscription.id, desired: desired.desired, revision: desired.revision });
        } catch {
          seatConvergenceFailed = true;
          dependencies.diagnostics.record({ level: "warn", message: "workspace_billing_scheduled_seat_convergence_failed", workspaceId, phase: "seat_convergence" });
        }
      }
      seat = {
        desired: desired.desired,
        observed,
        itemId,
        revision: desired.revision,
      };
    }
    // A deleted sole owner's subscription runs out at period end. Like a seat
    // change this happens before the commit, and a failure only schedules the
    // retry: the committed state keeps following the provider.
    let committedSubscription = subscription;
    let cancellationFailed = false;
    if (
      current.cancelAtPeriodEndRequested &&
      !subscription.cancelAtPeriodEnd &&
      !hasSubscriptionConflict &&
      ENTITLED_SUBSCRIPTION_STATUSES.has(subscription.status)
    ) {
      try {
        const provider = dependencies.provider;
        if (!provider.cancelSubscriptionAtPeriodEnd) throw new WorkspaceBillingError("plan_change_not_configured");
        // Stripe will not cancel a subscription that a schedule manages. The
        // pending change is moot once the plan is ending; a schedule that is
        // not ours is refused and retried until support releases it.
        if (subscription.planScheduleId) {
          if (!provider.retrievePlanChangeSubscription || !provider.cancelScheduledPlanChange) throw new WorkspaceBillingError("plan_change_not_configured");
          await callProvider("release_plan_schedule", async () =>
            provider.cancelScheduledPlanChange!({
              workspaceId,
              subscription: await provider.retrievePlanChangeSubscription!(subscription.id),
            }),
          );
        }
        await callProvider("cancel_at_period_end", () =>
          provider.cancelSubscriptionAtPeriodEnd!(
            { workspaceId, subscriptionId: subscription.id },
            `workspace-cancel-${workspaceId}-${subscription.id}`,
          ),
        );
        committedSubscription = { ...subscription, cancelAtPeriodEnd: true, planChange: null, planScheduleId: null };
      } catch (error) {
        if (error instanceof WorkspaceBillingAttemptLost) throw error;
        cancellationFailed = true;
        dependencies.diagnostics.record({
          level: "warn",
          message: "workspace_billing_owner_deletion_cancel_failed",
          workspaceId,
          phase: "owner_deletion_cancel",
        });
      }
    }
    if (subscription.planScheduleId && !subscription.planChange && dependencies.provider.finalizeCompletedPlanChangeSchedule) {
      // Releasing a finished schedule keeps portal cancellation available; it
      // must never stop the verified state from being committed.
      try {
        await dependencies.provider.finalizeCompletedPlanChangeSchedule({ workspaceId, subscriptionId: subscription.id });
      } catch (error) {
        if (error instanceof WorkspaceBillingAttemptLost) throw error;
        dependencies.diagnostics.record({ level: "warn", message: "workspace_billing_schedule_release_failed", workspaceId, phase: "projection" });
      }
    }
    let settled: WorkspaceBillingProjection;
    try {
      settled = await dependencies.store.commitVerifiedState({
        workspaceId,
        expectedCustomerId: providerState.customerId,
        subscription: committedSubscription,
        tier,
        interval: mapped.interval,
        workspaceStatus,
        health,
        attentionReason,
        firstPastDueAt,
        graceDeadlineAt,
        effectiveAt,
        now: dependencies.clock.now(),
        attemptId,
        seat,
        // Both are provider mutations that failed and retry on the changed cadence.
        seatConvergenceFailed: seatConvergenceFailed || cancellationFailed,
      });
    } catch (error) {
      if (error instanceof WorkspaceBillingAttemptLost && providerSeatMutation) {
        await dependencies.store.markSeatVerificationDue({
          workspaceId,
          now: dependencies.clock.now(),
        });
      }
      throw error;
    }
    dependencies.diagnostics.record({
      level: "info",
      message: "workspace_billing_reconciled",
      workspaceId,
      phase: "projection",
      providerOperation: "retrieve_current_state",
      mappedPlan: tier,
      accessStatus: workspaceStatus,
      billingHealth: health,
      desiredAdditionalSeats: seat?.desired ?? 0,
      synchronizedAdditionalSeats: seat?.observed ?? 0,
      retentionTransition: current.pricingTier === "free" && tier !== "free",
      outcome: "reconciled",
      durationMs: dependencies.clock.now().getTime() - startedAt.getTime(),
    });
    metrics.observe(
      "workspace_billing_operation_duration_ms",
      dependencies.clock.now().getTime() - startedAt.getTime(),
      {
        operation: "current_state",
        outcome: "reconciled",
        health,
        accessStatus: workspaceStatus,
        retentionTransition: current.pricingTier === "free" && tier !== "free",
      },
    );
    metrics.observe("workspace_billing_seat_quantity", seat?.desired ?? 0, {
      kind: "desired",
      health,
    });
    metrics.observe("workspace_billing_seat_quantity", seat?.observed ?? 0, {
      kind: "synchronized",
      health,
    });
    metrics.observe("workspace_billing_transitions_total", 1, {
      transition:
        !current.graceDeadlineAt && settled.graceDeadlineAt
          ? "grace_entered"
          : current.graceDeadlineAt && !settled.graceDeadlineAt
            ? "grace_recovered"
            : current.status !== settled.status && settled.status === "restricted"
              ? "access_restricted"
              : current.health !== settled.health
                ? "health_changed"
                : "verified",
      health: settled.health,
      accessStatus: settled.status,
      retentionTransition: current.pricingTier === "free" && tier !== "free",
    });
    return { kind: "reconciled", view: billingView(settled) };
  };

  const withProviderDeadline = async <T>(operation: Promise<T>): Promise<T> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Workspace Billing provider deadline exceeded")),
            dependencies.catalog.worker.providerDeadlineMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const reconcileClaim = async (claim: BillingReconciliationClaim) => {
    metrics.observe("workspace_billing_claims_total", 1, { surface: "driver" });
    metrics.observe("workspace_billing_queue_age_ms", Math.max(0, dependencies.clock.now().getTime() - claim.dueAt.getTime()), {});
    try {
      const result = await withProviderDeadline(reconcileOne(claim.workspaceId, claim.attemptId));
      if (result.kind === "reconciled") return { reconciled: 1, retried: 0, unresolved: 0, staleSettlements: 0 };
      const settled = await dependencies.store.scheduleRetry({ workspaceId: claim.workspaceId, attemptId: claim.attemptId,
        now: dependencies.clock.now(), nextReconcileAt: new Date(dependencies.clock.now().getTime() + 6 * 60 * 60 * 1000),
        reason: result.reason, health: "attention_required" });
      return { reconciled: 0, retried: settled ? 1 : 0, unresolved: 1, staleSettlements: settled ? 0 : 1 };
    } catch (error) {
      if (error instanceof WorkspaceBillingAttemptLost) return { reconciled: 0, retried: 0, unresolved: 0, staleSettlements: 1 };
      const delay = Math.min(60 * 60 * 1000, 60_000 * 2 ** Math.min(6, Math.max(0, claim.attemptCount - 1)));
      const jitter = Math.floor((dependencies.random?.() ?? Math.random()) * Math.max(1, Math.floor(delay / 4)));
      const settled = await dependencies.store.scheduleRetry({ workspaceId: claim.workspaceId, attemptId: claim.attemptId,
        now: dependencies.clock.now(), nextReconcileAt: new Date(dependencies.clock.now().getTime() + delay + jitter),
        reason: "retryable_provider", health: "retrying" });
      return { reconciled: 0, retried: settled ? 1 : 0, unresolved: 0, staleSettlements: settled ? 0 : 1 };
    }
  };

  const checkoutProvider = () => {
    const provider = dependencies.provider;
    if (
      !provider.findCustomersByWorkspace ||
      !provider.createCustomer ||
      !provider.createCheckoutSession ||
      !provider.retrieveCheckoutSession
    ) {
      throw new WorkspaceBillingError(
        "checkout_not_configured",
      );
    }
    return provider;
  };

  const requireBillingOwner = async (input: {
    workspaceId: string;
    actorUserId: string;
  }) => {
    const actor = await dependencies.store.readBillingActor(input);
    if (actor?.role !== "owner") {
      throw new WorkspaceBillingError(
        "billing_forbidden",
      );
    }
  };

  const checkoutDestination = (session: ProviderCheckoutSession) => {
    if (
      session.status !== "open" ||
      !session.url ||
      session.expiresAt.getTime() <= dependencies.clock.now().getTime()
    ) {
      throw new WorkspaceBillingError(
        "checkout_attempt_terminal",
      );
    }
    return {
      kind: "checkout" as const,
      url: session.url,
      expiresAt: session.expiresAt.toISOString(),
    };
  };

  return {
    ...planChanges,
    async startCheckout(input: {
      workspaceId: string;
      actorUserId: string;
      clientIdempotencyKey: string;
      targetTier: PaidPricingTier;
      interval: BillingInterval;
      returnDestination: string;
    }) {
      const startedAt = dependencies.clock.now();
      await requireBillingOwner(input);
      const current = await dependencies.store.readProjection(input.workspaceId);
      if (!current) {
        throw new WorkspaceBillingError("workspace_not_found");
      }
      if (current.pricingTier !== "free" && current.status !== "pending_payment") {
        throw new WorkspaceBillingError(
          "billing_portal_required",
        );
      }
      const price = dependencies.catalog.basePrices.find(
        (candidate) =>
          candidate.tier === input.targetTier &&
          candidate.interval === input.interval,
      );
      if (!price) {
        throw new WorkspaceBillingError(
          "price_not_configured",
        );
      }
      const catalogVersion = `${input.targetTier}:${input.interval}:${price.priceId}`;
      const provider = checkoutProvider();
      const inProgress = (attempt: WorkspaceCheckoutAttempt) =>
        new WorkspaceBillingError("checkout_in_progress", {
          tier: attempt.targetTier,
          interval: attempt.interval,
          expiresAt: attempt.expiresAt?.toISOString() ?? null,
        });

      /**
       * Retrieves current provider subscriptions before any subscription
       * Checkout is offered. The projected Free tier is not evidence: past-due
       * after grace, unpaid, paused, and incomplete subscriptions can still
       * bill, so they route to the portal. Only verified ended subscriptions
       * allow a new Checkout.
       */
      const requireNoBillableSubscription = async (
        customerId: string,
        attempt: WorkspaceCheckoutAttempt,
      ) => {
        const state = await callProvider("retrieve_current_state", () =>
          provider.retrieveCurrentState(customerId),
        );
        if (
          state.customerId !== customerId ||
          state.ownership.kind !== "verified" ||
          state.ownership.workspaceId !== input.workspaceId
        ) {
          throw new WorkspaceBillingError("customer_identity_conflict");
        }
        const billable = state.subscriptions.filter(
          (subscription) => !ENDED_SUBSCRIPTION_STATUSES.has(subscription.status),
        );
        if (billable.length === 0) return;
        if (!attempt.providerSessionId) {
          // Frees an unbound preparation only; if a concurrent request bound a
          // session meanwhile, that holder keeps the slot.
          await dependencies.store.releaseCheckoutSlot({
            attemptId: attempt.id,
            expectedSessionId: null,
            now: dependencies.clock.now(),
          });
        }
        dependencies.diagnostics.record({
          level: "info",
          message: "workspace_billing_checkout_portal_required",
          workspaceId: input.workspaceId,
          phase: "checkout_attempt",
          subscriptionStatuses: [...new Set(billable.map((item) => item.status))],
        });
        throw new WorkspaceBillingError("billing_portal_required");
      };

      // Two passes: a slot freed by verified provider state is taken once.
      for (let pass = 0; pass < 2; pass += 1) {
        const prepared = await dependencies.store.prepareCheckoutAttempt({
          ...input,
          catalogVersion,
          now: dependencies.clock.now(),
        });
        if (prepared.kind === "conflict") {
          throw new WorkspaceBillingError(
            "checkout_attempt_conflict",
          );
        }
        const attempt = prepared.attempt;
        dependencies.diagnostics.record({
          level: "info",
          message: "workspace_billing_checkout_prepared",
          workspaceId: input.workspaceId,
          phase: "checkout_attempt",
          disposition: prepared.kind,
          targetPlan: input.targetTier,
          interval: input.interval,
        });
        // A key whose attempt lost the slot can never hand out a session again.
        if (prepared.kind === "existing" && !attempt.holdsSlot) {
          throw new WorkspaceBillingError("checkout_attempt_terminal");
        }
        const sameChoice = attempt.catalogVersion === catalogVersion;

        if (attempt.providerSessionId) {
          const session = await callProvider("retrieve_checkout", () =>
            provider.retrieveCheckoutSession!(attempt.providerSessionId!),
          );
          if (
            (session.workspaceId && session.workspaceId !== input.workspaceId) ||
            (session.attemptId && session.attemptId !== attempt.id)
          ) {
            throw new WorkspaceBillingError(
              "checkout_session_conflict",
            );
          }
          if (session.status === "expired" || session.paymentStatus === "failed") {
            // Recording the verified outcome frees the slot.
            await dependencies.store.recordCheckoutState({
              workspaceId: input.workspaceId,
              sessionId: session.sessionId,
              providerAttemptId: session.attemptId,
              status: session.status,
              paymentStatus: session.paymentStatus,
              source: "reconciliation",
              wakeReconciliation: false,
              now: dependencies.clock.now(),
            });
            if (prepared.kind === "held") continue;
            throw new WorkspaceBillingError("checkout_attempt_terminal");
          }
          if (session.status === "complete") {
            // A completed Checkout awaiting reconciliation is never replaced.
            if (current.health === "activating" || !current.providerCustomerId) {
              throw inProgress(attempt);
            }
            await requireNoBillableSubscription(current.providerCustomerId, attempt);
            // Its subscription has verifiably ended; a returning customer may
            // start again.
            const released = await dependencies.store.releaseCheckoutSlot({
              attemptId: attempt.id,
              expectedSessionId: attempt.providerSessionId,
              now: dependencies.clock.now(),
            });
            if (prepared.kind === "held" || !released) continue;
            throw new WorkspaceBillingError("checkout_attempt_terminal");
          }
          if (!sameChoice) throw inProgress(attempt);
          // A bound session implies a bound customer; a concurrent request may
          // have bound both after this request read the projection.
          const customerId =
            current.providerCustomerId ??
            (await dependencies.store.readProjection(input.workspaceId))
              ?.providerCustomerId;
          if (!customerId) {
            throw new WorkspaceBillingError("billing_customer_missing");
          }
          await requireNoBillableSubscription(customerId, attempt);
          const destination = checkoutDestination(session);
          dependencies.diagnostics.record({
            level: "info",
            message: "workspace_billing_checkout_ready",
            workspaceId: input.workspaceId,
            phase: "checkout_session",
            disposition: prepared.kind === "held" ? "resumed" : "replayed",
            durationMs: dependencies.clock.now().getTime() - startedAt.getTime(),
          });
          return destination;
        }

        if (!sameChoice) {
          // Another choice is still being prepared. After the preparation
          // window it is abandoned: its session, if any, was never handed out.
          if (
            dependencies.clock.now().getTime() - attempt.createdAt.getTime() <
            CHECKOUT_PREPARATION_WINDOW_MS
          ) {
            throw inProgress(attempt);
          }
          // Lost to a concurrent bind or release: the next pass re-reads the
          // holder and resumes it or refuses with checkout_in_progress.
          await dependencies.store.releaseCheckoutSlot({
            attemptId: attempt.id,
            expectedSessionId: null,
            now: dependencies.clock.now(),
          });
          continue;
        }

        let customerId = current.providerCustomerId;
        if (!customerId) {
          const matches = await callProvider("find_customers", () =>
            provider.findCustomersByWorkspace!(input.workspaceId),
          );
          if (matches.length > 1) {
            await dependencies.store.scheduleRetry({
              workspaceId: input.workspaceId,
              now: dependencies.clock.now(),
              nextReconcileAt: new Date(
                dependencies.clock.now().getTime() + 6 * 60 * 60 * 1000,
              ),
              reason: "multiple_provider_customers",
              health: "attention_required",
            });
            throw new WorkspaceBillingError(
              "customer_identity_conflict",
            );
          }
          const recoveredCustomer = matches[0]?.customerId;
          customerId =
            recoveredCustomer ??
            (
              await callProvider("create_customer", () =>
                provider.createCustomer!(
                  {
                    workspaceId: input.workspaceId,
                    actorUserId: input.actorUserId,
                  },
                  attempt.customerOperationKey,
                ),
              )
            ).customerId;
          dependencies.diagnostics.record({
            level: "info",
            message: "workspace_billing_customer_resolved",
            workspaceId: input.workspaceId,
            phase: "customer_provisioning",
            disposition: recoveredCustomer ? "recovered" : "created",
          });
          await dependencies.store.bindCheckoutCustomer({
            workspaceId: input.workspaceId,
            attemptId: attempt.id,
            customerId,
            now: dependencies.clock.now(),
          });
        }
        await requireNoBillableSubscription(customerId, attempt);

        const recovered = provider.findCheckoutSessionsByAttempt
          ? await callProvider("find_checkouts", () =>
              provider.findCheckoutSessionsByAttempt!({
                attemptId: attempt.id,
                customerId,
              }),
            )
          : undefined;
        if (recovered && recovered.length > 1) {
          throw new WorkspaceBillingError(
            "checkout_session_conflict",
          );
        }
        const session =
          recovered?.[0] ??
          (await callProvider("create_checkout", () =>
            provider.createCheckoutSession!(
              {
                attemptId: attempt.id,
                workspaceId: input.workspaceId,
                actorUserId: input.actorUserId,
                customerId,
                priceId: price.priceId,
                successUrl: `${input.returnDestination}${input.returnDestination.includes("?") ? "&" : "?"}checkout=return&session_id={CHECKOUT_SESSION_ID}`,
                cancelUrl: `${input.returnDestination}${input.returnDestination.includes("?") ? "&" : "?"}checkout=cancelled`,
                expiresAt: new Date(
                  dependencies.clock.now().getTime() + CHECKOUT_SESSION_LIFETIME_MS,
                ),
              },
              attempt.checkoutOperationKey,
            ),
          ));
        // Fenced on the slot: a session URL is only returned to its holder.
        await dependencies.store.bindCheckoutSession({
          attemptId: attempt.id,
          sessionId: session.sessionId,
          expiresAt: session.expiresAt,
          now: dependencies.clock.now(),
        });
        const destination = checkoutDestination(session);
        dependencies.diagnostics.record({
          level: "info",
          message: "workspace_billing_checkout_ready",
          workspaceId: input.workspaceId,
          phase: "checkout_session",
          disposition: recovered?.[0] ? "recovered" : "created",
          durationMs: dependencies.clock.now().getTime() - startedAt.getTime(),
        });
        return destination;
      }
      throw new WorkspaceBillingError("checkout_in_progress");
    },
    async observeCheckoutReturn(input: {
      workspaceId: string;
      actorUserId: string;
      sessionId: string;
    }) {
      await requireBillingOwner(input);
      const provider = checkoutProvider();
      const session = await callProvider("retrieve_checkout", () =>
        provider.retrieveCheckoutSession!(input.sessionId),
      );
      if (session.workspaceId !== input.workspaceId) {
        throw new WorkspaceBillingError(
          "checkout_session_conflict",
        );
      }
      const expired = session.status === "expired";
      await dependencies.store.recordCheckoutState({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        providerAttemptId: session.attemptId,
        status: session.status,
        paymentStatus: session.paymentStatus,
        source: "return",
        wakeReconciliation: !expired,
        now: dependencies.clock.now(),
      });
      dependencies.diagnostics.record({
        level: "info",
        message: "workspace_billing_checkout_return_observed",
        workspaceId: input.workspaceId,
        phase: "checkout_return",
        checkoutStatus: session.status,
        paymentStatus: session.paymentStatus,
      });
      const view = await dependencies.store.readProjection(input.workspaceId);
      if (!view) {
        throw new WorkspaceBillingError("workspace_not_found");
      }
      if (expired) {
        return {
          kind: "terminal" as const,
          reason: "expired" as const,
          view: billingView(view),
        };
      }
      return {
        kind: "activating" as const,
        retryAfterSeconds: 2,
        view: billingView(view),
      };
    },
    async openPortal(input: {
      workspaceId: string;
      actorUserId: string;
      returnUrl: string;
    }) {
      await requireBillingOwner(input);
      const current = await dependencies.store.readProjection(input.workspaceId);
      if (!current?.providerCustomerId) {
        throw new WorkspaceBillingError(
          "billing_customer_missing",
        );
      }
      if (!dependencies.provider.createPortalSession) {
        throw new WorkspaceBillingError(
          "portal_not_configured",
        );
      }
      if (current.canonicalSubscriptionId && dependencies.provider.finalizeCompletedPlanChangeSchedule) {
        // Best effort: the portal is also where payment is recovered, so a failed
        // release must not make it unavailable.
        await dependencies.provider.finalizeCompletedPlanChangeSchedule({ workspaceId: input.workspaceId, subscriptionId: current.canonicalSubscriptionId }).catch(() => {
          dependencies.diagnostics.record({ level: "warn", message: "workspace_billing_schedule_release_failed", workspaceId: input.workspaceId, phase: "portal" });
        });
      }
      const portal = await callProvider("create_portal", () =>
        dependencies.provider.createPortalSession!({
          customerId: current.providerCustomerId!,
          returnUrl: input.returnUrl,
        }),
      );
      dependencies.diagnostics.record({
        level: "info",
        message: "workspace_billing_portal_started",
        workspaceId: input.workspaceId,
        phase: "portal",
        disposition: "created",
      });
      return portal;
    },
    async acceptStripeDelivery(rawBody: string, signature: string) {
      const delivery = await callProvider("verify_delivery", () =>
        dependencies.provider.verifyDelivery(rawBody, signature),
      );
      const wakeReconciliation = wakeEventTypes.has(delivery.eventType);
      const accepted = await dependencies.store.acceptDelivery({
        delivery,
        receivedAt: dependencies.clock.now(),
        wakeReconciliation,
      });
      const disposition: "accepted" | "duplicate" | "ignored" =
        accepted.kind === "accepted" && !wakeReconciliation
          ? "ignored"
          : accepted.kind;
      dependencies.diagnostics.record({
        level: "info",
        message: "workspace_billing_delivery_accepted",
        deliveryType: delivery.eventType,
        disposition,
        workspaceId: accepted.workspaceId,
      });
      metrics.observe("workspace_billing_deliveries_total", 1, {
        disposition,
        deliveryType: delivery.eventType,
        matchedWorkspace: Boolean(accepted.workspaceId),
      });
      metrics.observe(
        "workspace_billing_delivery_latency_ms",
        Math.max(
          0,
          dependencies.clock.now().getTime() - delivery.providerCreatedAt.getTime(),
        ),
        { disposition, deliveryType: delivery.eventType },
      );
      return { kind: disposition, workspaceId: accepted.workspaceId };
    },
    async reconcileCurrentState(
      workspaceId: string,
    ): Promise<ReconcileCurrentStateResult> {
      const now = dependencies.clock.now();
      const claim = await dependencies.store.claimAccount({
        workspaceId,
        now,
        leaseMs: dependencies.catalog.worker.leaseMs,
      });
      if (!claim) {
        const current = await dependencies.store.readProjection(workspaceId);
        if (!current) {
          throw new WorkspaceBillingError("workspace_not_found");
        }
        return {
          kind: "unresolved",
          reason: "reconciliation_in_progress",
          view: billingView(current),
        };
      }
      metrics.observe("workspace_billing_claims_total", 1, {
        surface: "interactive",
      });
      metrics.observe(
        "workspace_billing_queue_age_ms",
        Math.max(0, now.getTime() - claim.dueAt.getTime()),
        {},
      );
      try {
        const result = await withProviderDeadline(
          reconcileOne(workspaceId, claim.attemptId),
        );
        if (result.kind === "reconciled") return result;
        const attentionDelayMs = 6 * 60 * 60 * 1000;
        await dependencies.store.scheduleRetry({
          workspaceId,
          attemptId: claim.attemptId,
          now: dependencies.clock.now(),
          nextReconcileAt: new Date(
            dependencies.clock.now().getTime() + attentionDelayMs,
          ),
          reason: result.reason,
          health: "attention_required",
        });
        metrics.observe("workspace_billing_retry_delay_ms", attentionDelayMs, {
          surface: "interactive",
          retryBand: retryBand(claim.attemptCount),
          reason: "attention_required",
        });
        dependencies.diagnostics.record({
          level: "warn",
          message: "workspace_billing_attention_required",
          workspaceId,
          phase: "current_state",
          reason: result.reason,
        });
        const current = await dependencies.store.readProjection(workspaceId);
        return {
          ...result,
          view: current ? billingView(current) : result.view,
        };
      } catch (error) {
        if (error instanceof WorkspaceBillingAttemptLost) {
          const current = await dependencies.store.readProjection(workspaceId);
          if (!current) throw error;
          return {
            kind: "unresolved",
            reason: "reconciliation_superseded",
            view: billingView(current),
          };
        }
        const retryDelayMs = 60_000;
        await dependencies.store.scheduleRetry({
          workspaceId,
          attemptId: claim.attemptId,
          now: dependencies.clock.now(),
          nextReconcileAt: new Date(
            dependencies.clock.now().getTime() + retryDelayMs,
          ),
          reason: "retryable_provider",
          health: "retrying",
        });
        metrics.observe("workspace_billing_retry_delay_ms", retryDelayMs, {
          surface: "interactive",
          retryBand: retryBand(claim.attemptCount),
          reason: "retryable_provider",
        });
        dependencies.diagnostics.record({
          level: "warn",
          message: "workspace_billing_retry_scheduled",
          workspaceId,
          phase: "current_state",
          reason: "retryable_provider",
        });
        const current = await dependencies.store.readProjection(workspaceId);
        if (!current) throw error;
        return {
          kind: "unresolved",
          reason: "retryable_provider",
          view: billingView(current),
        };
      }
    },
    async reconcileClaim(claim: BillingReconciliationClaim): Promise<void> { await reconcileClaim(claim); },
    async readBillingState(workspaceId: string): Promise<WorkspaceBillingView> {
      const current = await dependencies.store.readProjection(workspaceId);
      if (!current) throw new Error("Workspace Billing Account not found");
      return billingView(current);
    },
    async inspectAccount(workspaceId: string) {
      const current = await dependencies.store.readProjection(workspaceId);
      if (!current) {
        throw new WorkspaceBillingError("workspace_not_found");
      }
      const view = billingView(current);
      const local = {
        ...view,
        hasProviderCustomer: Boolean(current.providerCustomerId),
        hasCanonicalSubscription: Boolean(current.canonicalSubscriptionId),
        hasSeatItem: Boolean(current.seatItemId),
        attentionReason: current.attentionReason,
      };
      if (!current.providerCustomerId) {
        return { workspaceId, local, provider: null };
      }
      const providerState = await callProvider("inspect_current_state", () =>
        dependencies.provider.retrieveCurrentState(current.providerCustomerId!),
      );
      return {
        workspaceId,
        local,
        provider: {
          ownership: providerState.ownership.kind,
          subscriptionCount: providerState.subscriptions.length,
          subscriptions: providerState.subscriptions.map((subscription) => {
            const baseItems = subscription.items.flatMap((item) => {
              const match = dependencies.catalog.basePrices.find(
                (price) => price.priceId === item.priceId,
              );
              return match ? [match] : [];
            });
            const seatItems = subscription.items.filter((item) =>
              dependencies.catalog.seatPrices.some(
                (price) => price.priceId === item.priceId,
              ),
            );
            return {
              status: subscription.status,
              basePlan:
                baseItems.length === 1
                  ? `${baseItems[0]!.tier}/${baseItems[0]!.interval}`
                  : baseItems.length === 0
                    ? "unknown"
                    : "conflict",
              additionalSeats: seatItems.reduce(
                (quantity, item) => quantity + item.quantity,
                0,
              ),
              seatItemCount: seatItems.length,
              itemCount: subscription.items.length,
              cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
              currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
              trialEnd: subscription.trialEnd?.toISOString() ?? null,
            };
          }),
        },
      };
    },
  };
}
