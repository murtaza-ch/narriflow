import {
  billingHealthSchema,
  resolvePricingTier,
  type BillingHealth,
  type BillingInterval,
  type PaidPricingTier,
  type PricingTier,
} from "@narriflow/validators";
import { getPrismaClient } from "@narriflow/db/client";
import { projectRetentionService } from "./project-retention.service";
import { randomUUID } from "node:crypto";

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
    batchSize: number;
    concurrency: number;
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

export function createBillingCatalog(input: BillingCatalogInput): BillingCatalog {
  const seen = new Set<string>();
  for (const entry of [...input.basePrices, ...input.seatPrices]) {
    if (seen.has(entry.priceId)) {
      throw new Error(`${entry.priceId} is mapped more than once`);
    }
    seen.add(entry.priceId);
  }
  for (const tier of ["creator", "pro", "business"] as const) {
    for (const interval of ["monthly", "annual"] as const) {
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
  for (const interval of ["monthly", "annual"] as const) {
    const matches = input.seatPrices.filter((entry) => entry.interval === interval);
    if (matches.length === 0) {
      throw new Error(`Missing seat price for business/${interval}`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple seat prices for business/${interval}`);
    }
  }
  const numericLimits = [
    ["batchSize", input.worker.batchSize, 1, 500],
    ["concurrency", input.worker.concurrency, 1, 32],
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
}

export interface ProviderCurrentState {
  customerId: string;
  ownership:
    | { kind: "verified"; workspaceId: string }
    | { kind: "missing_metadata" }
    | { kind: "workspace_mismatch" };
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
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
  "customer.updated",
  "customer.deleted",
] as const;

export interface WorkspaceBillingProvider {
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

export interface WorkspaceBillingView {
  workspaceId: string;
  plan: PricingTier;
  interval: BillingInterval | null;
  status: WorkspaceBillingProductStatus;
  workspaceAccessStatus: "active" | "pending_payment" | "restricted";
  health: WorkspaceBillingHealth;
  renewalOrEndAt: string | null;
  cancelAtPeriodEnd: boolean;
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
  firstPastDueAt: Date | null;
  graceDeadlineAt: Date | null;
  health: WorkspaceBillingHealth;
  attentionReason: string | null;
  lastVerifiedAt: Date | null;
  desiredAdditionalSeats: number;
  synchronizedAdditionalSeats: number | null;
  seatItemId: string | null;
  latestCheckout: {
    status: ProviderCheckoutSession["status"];
    paymentStatus: string;
  } | null;
}

export interface WorkspaceBillingStore {
  readProjection(workspaceId: string): Promise<WorkspaceBillingProjection | null>;
  acceptDelivery(input: {
    delivery: VerifiedBillingDelivery;
    receivedAt: Date;
    wakeReconciliation: boolean;
  }): Promise<{
    kind: "accepted" | "duplicate";
    workspaceId: string | null;
  }>;
  claimDueAccounts(input: {
    now: Date;
    limit: number;
    leaseMs: number;
  }): Promise<
    Array<{
      workspaceId: string;
      attemptId: string;
      attemptCount: number;
      dueAt: Date;
    }>
  >;
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
  }): Promise<WorkspaceBillingProjection>;
  commitNoSubscriptionState(input: {
    workspaceId: string;
    attemptId: string;
    workspaceStatus: "active" | "pending_payment" | "restricted";
    health: "current" | "activating";
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
    kind: "created" | "existing" | "conflict";
    attempt: WorkspaceCheckoutAttempt;
  }>;
  bindCheckoutCustomer(input: {
    workspaceId: string;
    attemptId: string;
    customerId: string;
    now: Date;
  }): Promise<void>;
  bindCheckoutSession(input: {
    attemptId: string;
    sessionId: string;
    expiresAt: Date;
    now: Date;
  }): Promise<void>;
  recordCheckoutReturn(input: {
    workspaceId: string;
    sessionId: string;
    providerAttemptId?: string;
    status: ProviderCheckoutSession["status"];
    paymentStatus: string;
    wakeReconciliation: boolean;
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
}

export type WorkspaceBillingErrorCode =
  | "billing_customer_missing"
  | "billing_forbidden"
  | "billing_portal_required"
  | "checkout_attempt_conflict"
  | "checkout_attempt_invalid"
  | "checkout_attempt_missing"
  | "checkout_attempt_terminal"
  | "checkout_not_configured"
  | "checkout_session_conflict"
  | "customer_identity_conflict"
  | "portal_not_configured"
  | "price_not_configured"
  | "seat_provider_not_configured"
  | "workspace_not_found";

export class WorkspaceBillingError extends Error {
  constructor(
    public readonly code: WorkspaceBillingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceBillingError";
  }
}

export class WorkspaceBillingAttemptLost extends Error {
  constructor() {
    super("Workspace Billing reconciliation attempt lost");
    this.name = "WorkspaceBillingAttemptLost";
  }
}

function nextVerifiedReconcileAt(input: {
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

export function createInMemoryWorkspaceBillingStore(
  workspaces: Array<
    Pick<
      WorkspaceBillingProjection,
      | "workspaceId"
      | "personal"
      | "hasNonOwnerMembers"
      | "pricingTier"
      | "status"
      | "providerCustomerId"
    > & { ownerUserId?: string; desiredAdditionalSeats?: number }
  >,
): WorkspaceBillingStore {
  const rows = new Map<string, WorkspaceBillingProjection>(
    workspaces.map((workspace) => [
      workspace.workspaceId,
      {
        ...workspace,
        ownerUserId: workspace.ownerUserId ?? `owner-${workspace.workspaceId}`,
        canonicalSubscriptionId: null,
        interval: null,
        providerStatus: null,
        currentPeriodEnd: null,
        trialEnd: null,
        cancelAtPeriodEnd: false,
        firstPastDueAt: null,
        graceDeadlineAt: null,
        health: "current",
        attentionReason: null,
        lastVerifiedAt: null,
        desiredAdditionalSeats: workspace.desiredAdditionalSeats ?? 0,
        synchronizedAdditionalSeats: null,
        seatItemId: null,
        latestCheckout: null,
      },
    ]),
  );
  const deliveries = new Map<string, string | null>();
  const checkoutAttempts = new Map<string, WorkspaceCheckoutAttempt>();
  const runtime = new Map(
    workspaces.map((workspace) => [
      workspace.workspaceId,
      {
        nextReconcileAt: new Date(0),
        attemptId: null as string | null,
        leaseExpiresAt: null as Date | null,
        attemptCount: 0,
        seatRevision: workspace.desiredAdditionalSeats ? 1 : 0,
      },
    ]),
  );

  return {
    async readProjection(workspaceId) {
      return rows.get(workspaceId) ?? null;
    },
    async readBillingActor(input) {
      const row = rows.get(input.workspaceId);
      if (!row || row.ownerUserId !== input.actorUserId) return null;
      return { role: "owner" };
    },
    async readDesiredSeatState(workspaceId) {
      const row = rows.get(workspaceId);
      const state = runtime.get(workspaceId);
      if (!row || !state) {
        throw new WorkspaceBillingError("workspace_not_found", "Workspace not found");
      }
      return {
        desired: row.desiredAdditionalSeats,
        revision: state.seatRevision,
      };
    },
    async prepareCheckoutAttempt(input) {
      const existing = checkoutAttempts.get(input.clientIdempotencyKey);
      if (existing) {
        const unchanged =
          existing.workspaceId === input.workspaceId &&
          existing.actorUserId === input.actorUserId &&
          existing.targetTier === input.targetTier &&
          existing.interval === input.interval &&
          existing.catalogVersion === input.catalogVersion &&
          existing.returnDestination === input.returnDestination;
        return { kind: unchanged ? "existing" : "conflict", attempt: existing };
      }
      const id = randomUUID();
      const attempt: WorkspaceCheckoutAttempt = {
        id,
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        clientIdempotencyKey: input.clientIdempotencyKey,
        targetTier: input.targetTier,
        interval: input.interval,
        catalogVersion: input.catalogVersion,
        returnDestination: input.returnDestination,
        customerOperationKey: `workspace-customer-${input.workspaceId}`,
        checkoutOperationKey: `workspace-checkout-${id}`,
        providerSessionId: null,
        expiresAt: null,
      };
      checkoutAttempts.set(input.clientIdempotencyKey, attempt);
      const row = rows.get(input.workspaceId);
      if (row) row.latestCheckout = null;
      return { kind: "created", attempt };
    },
    async bindCheckoutCustomer(input) {
      const row = rows.get(input.workspaceId);
      if (!row) throw new WorkspaceBillingError("workspace_not_found", "Workspace not found");
      if (row.providerCustomerId && row.providerCustomerId !== input.customerId) {
        throw new WorkspaceBillingError(
          "customer_identity_conflict",
          "Billing customer identity needs attention",
        );
      }
      row.providerCustomerId = input.customerId;
    },
    async bindCheckoutSession(input) {
      const attempt = [...checkoutAttempts.values()].find(
        (candidate) => candidate.id === input.attemptId,
      );
      if (!attempt) {
        throw new WorkspaceBillingError("checkout_attempt_missing", "Checkout attempt not found");
      }
      if (attempt.providerSessionId && attempt.providerSessionId !== input.sessionId) {
        throw new WorkspaceBillingError(
          "checkout_session_conflict",
          "Checkout session needs attention",
        );
      }
      attempt.providerSessionId = input.sessionId;
      attempt.expiresAt = input.expiresAt;
    },
    async recordCheckoutReturn(input) {
      const attempt = [...checkoutAttempts.values()].find(
        (candidate) => candidate.providerSessionId === input.sessionId,
      );
      if (
        !attempt ||
        attempt.workspaceId !== input.workspaceId ||
        (input.providerAttemptId && attempt.id !== input.providerAttemptId)
      ) {
        throw new WorkspaceBillingError(
          "checkout_session_conflict",
          "Checkout session ownership could not be verified",
        );
      }
      const row = rows.get(input.workspaceId)!;
      if (input.wakeReconciliation) {
        row.health = "activating";
        row.attentionReason = null;
        const state = runtime.get(input.workspaceId)!;
        state.nextReconcileAt = input.now;
      }
      row.latestCheckout = {
        status: input.status,
        paymentStatus: input.paymentStatus,
      };
      return attempt;
    },
    async acceptDelivery(input) {
      if (deliveries.has(input.delivery.eventId)) {
        return {
          kind: "duplicate",
          workspaceId: deliveries.get(input.delivery.eventId) ?? null,
        };
      }
      const hinted = input.delivery.workspaceHint
        ? rows.get(input.delivery.workspaceHint)
        : null;
      const matched =
        hinted?.providerCustomerId === input.delivery.customerId
          ? hinted
          : [...rows.values()].find(
              (row) => row.providerCustomerId === input.delivery.customerId,
            ) ?? null;
      const workspaceId = matched?.workspaceId ?? null;
      deliveries.set(input.delivery.eventId, workspaceId);
      return { kind: "accepted", workspaceId };
    },
    async claimDueAccounts(input) {
      const claimed: Array<{
        workspaceId: string;
        attemptId: string;
        attemptCount: number;
        dueAt: Date;
      }> = [];
      for (const workspaceId of [...runtime.keys()].sort()) {
        if (claimed.length >= input.limit) break;
        const state = runtime.get(workspaceId)!;
        if (state.nextReconcileAt.getTime() > input.now.getTime()) continue;
        if (
          state.leaseExpiresAt &&
          state.leaseExpiresAt.getTime() > input.now.getTime()
        ) {
          continue;
        }
        const attemptId = randomUUID();
        state.attemptId = attemptId;
        state.leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
        state.attemptCount += 1;
        claimed.push({
          workspaceId,
          attemptId,
          attemptCount: state.attemptCount,
          dueAt: state.nextReconcileAt,
        });
      }
      return claimed;
    },
    async claimAccount(input) {
      const state = runtime.get(input.workspaceId);
      if (
        !state ||
        (state.leaseExpiresAt && state.leaseExpiresAt.getTime() > input.now.getTime())
      ) {
        return null;
      }
      const attemptId = randomUUID();
      state.attemptId = attemptId;
      state.leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
      state.attemptCount += 1;
      return {
        workspaceId: input.workspaceId,
        attemptId,
        attemptCount: state.attemptCount,
        dueAt: state.nextReconcileAt,
      };
    },
    async renewClaim(input) {
      const state = runtime.get(input.workspaceId);
      if (
        !state ||
        state.attemptId !== input.attemptId ||
        !state.leaseExpiresAt ||
        state.leaseExpiresAt.getTime() <= input.now.getTime()
      ) {
        return false;
      }
      state.leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
      return true;
    },
    async scheduleRetry(input) {
      const state = runtime.get(input.workspaceId);
      if (
        !state ||
        (input.attemptId !== undefined &&
          (state.attemptId !== input.attemptId ||
            !state.leaseExpiresAt ||
            state.leaseExpiresAt.getTime() <= input.now.getTime()))
      ) {
        return false;
      }
      state.attemptId = null;
      state.leaseExpiresAt = null;
      state.nextReconcileAt = input.nextReconcileAt;
      const row = rows.get(input.workspaceId);
      if (row) {
        row.health = input.health;
        row.attentionReason = input.reason;
      }
      return true;
    },
    async markSeatVerificationDue(input) {
      const state = runtime.get(input.workspaceId);
      if (!state) return;
      state.seatRevision += 1;
      if (state.nextReconcileAt.getTime() > input.now.getTime()) {
        state.nextReconcileAt = input.now;
      }
    },
    async commitNoSubscriptionState(input) {
      const current = rows.get(input.workspaceId);
      const state = runtime.get(input.workspaceId);
      if (
        !current ||
        !state ||
        state.attemptId !== input.attemptId ||
        !state.leaseExpiresAt ||
        state.leaseExpiresAt.getTime() <= input.now.getTime()
      ) {
        throw new WorkspaceBillingAttemptLost();
      }
      const changed =
        current.status !== input.workspaceStatus || current.health !== input.health;
      const next = {
        ...current,
        pricingTier: "free" as const,
        status: input.workspaceStatus,
        canonicalSubscriptionId: null,
        interval: null,
        providerStatus: null,
        currentPeriodEnd: null,
        trialEnd: null,
        cancelAtPeriodEnd: false,
        firstPastDueAt: null,
        graceDeadlineAt: null,
        health: input.health,
        attentionReason: null,
      };
      rows.set(input.workspaceId, next);
      state.attemptId = null;
      state.leaseExpiresAt = null;
      state.attemptCount = 0;
      state.nextReconcileAt = nextVerifiedReconcileAt({
        now: input.now,
        health: input.health,
        changed,
        seatStillDue: false,
      });
      return next;
    },
    async commitVerifiedState(input) {
      const current = rows.get(input.workspaceId);
      if (!current) throw new Error("Workspace Billing Account not found");
      const runtimeState = runtime.get(input.workspaceId)!;
      if (
        input.attemptId &&
        (runtimeState.attemptId !== input.attemptId ||
          !runtimeState.leaseExpiresAt ||
          runtimeState.leaseExpiresAt.getTime() <= input.now.getTime())
      ) {
        throw new WorkspaceBillingAttemptLost();
      }
      if (current.providerCustomerId !== input.expectedCustomerId) {
        throw new Error("Workspace Billing customer mismatch");
      }
      const changed =
        current.pricingTier !== input.tier ||
        current.status !== input.workspaceStatus ||
        current.canonicalSubscriptionId !== input.subscription.id ||
        current.providerStatus !== input.subscription.status ||
        current.health !== input.health ||
        current.attentionReason !== input.attentionReason;
      const next: WorkspaceBillingProjection = {
        ...current,
        pricingTier: input.tier,
        status: input.workspaceStatus,
        canonicalSubscriptionId: input.subscription.id,
        interval: input.interval,
        providerStatus: input.subscription.status,
        currentPeriodEnd: input.subscription.currentPeriodEnd,
        trialEnd: input.subscription.trialEnd,
        cancelAtPeriodEnd: input.subscription.cancelAtPeriodEnd,
        firstPastDueAt: input.firstPastDueAt,
        graceDeadlineAt: input.graceDeadlineAt,
        health: input.health,
        attentionReason: input.attentionReason,
        lastVerifiedAt: input.now,
        desiredAdditionalSeats: input.seat?.desired ?? current.desiredAdditionalSeats,
        synchronizedAdditionalSeats:
          input.seat?.observed ?? current.synchronizedAdditionalSeats,
        seatItemId: input.seat?.itemId ?? current.seatItemId,
      };
      rows.set(input.workspaceId, next);
      if (input.attemptId) {
        runtimeState.attemptId = null;
        runtimeState.leaseExpiresAt = null;
        runtimeState.attemptCount = 0;
        runtimeState.nextReconcileAt = nextVerifiedReconcileAt({
          now: input.now,
          health: input.health,
          changed,
          seatStillDue:
            input.seat !== undefined &&
            runtimeState.seatRevision !== input.seat.revision,
        });
      }
      return next;
    },
  };
}

function billingHealth(value: string): WorkspaceBillingHealth {
  return billingHealthSchema.parse(value);
}

export function createPrismaWorkspaceBillingStore(): WorkspaceBillingStore {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("DATABASE_URL is required for Workspace Billing");

  return {
    async readProjection(workspaceId) {
      const row = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: {
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
        },
      });
      if (!row?.billingAccount) return null;
      const account = row.billingAccount;
      const latestCheckout = await prisma.workspaceCheckoutAttempt.findFirst({
        where: { billingAccountId: account.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { sessionStatus: true, paymentStatus: true },
      });
      return {
        workspaceId: row.id,
        ownerUserId: row.ownerUserId,
        personal: Boolean(row.personalOwnerUserId),
        hasNonOwnerMembers: row.members.length > 0,
        pricingTier: resolvePricingTier(row.pricingTier),
        status: row.status,
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
        firstPastDueAt: account.firstPastDueAt,
        graceDeadlineAt: account.graceDeadlineAt,
        health: billingHealth(account.health),
        attentionReason: account.attentionReason,
        lastVerifiedAt: account.lastVerifiedAt,
        desiredAdditionalSeats: account.desiredAdditionalSeats,
        synchronizedAdditionalSeats: account.synchronizedAdditionalSeats,
        seatItemId: account.seatItemId,
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
        throw new WorkspaceBillingError("workspace_not_found", "Workspace not found");
      }
      return { desired, revision: account.seatRevision };
    },
    async prepareCheckoutAttempt(input) {
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
      }): WorkspaceCheckoutAttempt => {
        if (
          row.targetTier !== "creator" &&
          row.targetTier !== "pro" &&
          row.targetTier !== "business"
        ) {
          throw new WorkspaceBillingError(
            "checkout_attempt_invalid",
            "Checkout attempt has an invalid plan",
          );
        }
        if (row.interval !== "monthly" && row.interval !== "annual") {
          throw new WorkspaceBillingError(
            "checkout_attempt_invalid",
            "Checkout attempt has an invalid interval",
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
        billingAccount: { select: { workspaceId: true } },
      } as const;
      const existing = await prisma.workspaceCheckoutAttempt.findUnique({
        where: { clientIdempotencyKey: input.clientIdempotencyKey },
        select,
      });
      if (existing) return classify(toAttempt(existing));
      const id = randomUUID();
      try {
        const created = await prisma.workspaceCheckoutAttempt.create({
          data: {
            id,
            billingAccount: { connect: { workspaceId: input.workspaceId } },
            actorUserId: input.actorUserId,
            clientIdempotencyKey: input.clientIdempotencyKey,
            targetTier: input.targetTier,
            interval: input.interval,
            catalogVersion: input.catalogVersion,
            returnDestination: input.returnDestination,
            customerOperationKey: `workspace-customer-${input.workspaceId}`,
            checkoutOperationKey: `workspace-checkout-${id}`,
          },
          select,
        });
        return { kind: "created" as const, attempt: toAttempt(created) };
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "P2002"
        ) {
          const raced = await prisma.workspaceCheckoutAttempt.findUnique({
            where: { clientIdempotencyKey: input.clientIdempotencyKey },
            select,
          });
          if (raced) return classify(toAttempt(raced));
        }
        throw error;
      }
    },
    async bindCheckoutCustomer(input) {
      await prisma.$transaction(async (tx) => {
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
            "Checkout attempt not found",
          );
        }
        const currentCustomerId = attempt.billingAccount.providerCustomerId;
        if (currentCustomerId && currentCustomerId !== input.customerId) {
          throw new WorkspaceBillingError(
            "customer_identity_conflict",
            "Billing customer identity needs attention",
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
      });
    },
    async bindCheckoutSession(input) {
      await prisma.workspaceCheckoutAttempt.update({
        where: { id: input.attemptId },
        data: {
          providerSessionId: input.sessionId,
          providerPhase: "session_bound",
          expiresAt: input.expiresAt,
        },
      });
    },
    async recordCheckoutReturn(input) {
      return prisma.$transaction(async (tx) => {
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
            billingAccount: { select: { id: true, workspaceId: true } },
          },
        });
        if (
          !attempt ||
          attempt.billingAccount.workspaceId !== input.workspaceId ||
          (input.providerAttemptId && attempt.id !== input.providerAttemptId)
        ) {
          throw new WorkspaceBillingError(
            "checkout_session_conflict",
            "Checkout session ownership could not be verified",
          );
        }
        if (
          attempt.targetTier !== "creator" &&
          attempt.targetTier !== "pro" &&
          attempt.targetTier !== "business"
        ) {
          throw new WorkspaceBillingError(
            "checkout_attempt_invalid",
            "Checkout attempt has an invalid plan",
          );
        }
        if (attempt.interval !== "monthly" && attempt.interval !== "annual") {
          throw new WorkspaceBillingError(
            "checkout_attempt_invalid",
            "Checkout attempt has an invalid interval",
          );
        }
        await tx.workspaceCheckoutAttempt.update({
          where: { id: attempt.id },
          data: {
            providerPhase: "return_observed",
            sessionStatus: input.status,
            paymentStatus: input.paymentStatus,
          },
        });
        if (input.wakeReconciliation) {
          await tx.workspaceBillingAccount.update({
            where: { id: attempt.billingAccount.id },
            data: {
              health: "activating",
              attentionReason: null,
              nextReconcileAt: input.now,
            },
          });
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
        };
      });
    },
    async acceptDelivery(input) {
      try {
        return await prisma.$transaction(async (tx) => {
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
    async claimDueAccounts(input) {
      const claims: Array<{
        workspaceId: string;
        attemptId: string;
        attemptCount: number;
        dueAt: Date;
      }> = [];
      for (let index = 0; index < input.limit; index += 1) {
        const candidate = await prisma.workspaceBillingAccount.findFirst({
          where: {
            nextReconcileAt: { lte: input.now },
            OR: [
              { leaseExpiresAt: null },
              { leaseExpiresAt: { lte: input.now } },
            ],
          },
          orderBy: [{ nextReconcileAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            workspaceId: true,
            attemptCount: true,
            nextReconcileAt: true,
          },
        });
        if (!candidate) break;
        const attemptId = randomUUID();
        const won = await prisma.workspaceBillingAccount.updateMany({
          where: {
            id: candidate.id,
            nextReconcileAt: { lte: input.now },
            OR: [
              { leaseExpiresAt: null },
              { leaseExpiresAt: { lte: input.now } },
            ],
          },
          data: {
            reconcileAttemptId: attemptId,
            leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
            attemptCount: { increment: 1 },
          },
        });
        if (won.count === 0) {
          index -= 1;
          continue;
        }
        claims.push({
          workspaceId: candidate.workspaceId,
          attemptId,
          attemptCount: candidate.attemptCount + 1,
          dueAt: candidate.nextReconcileAt,
        });
      }
      return claims;
    },
    async claimAccount(input) {
      const attemptId = randomUUID();
      const won = await prisma.workspaceBillingAccount.updateMany({
        where: {
          workspaceId: input.workspaceId,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: input.now } }],
        },
        data: {
          reconcileAttemptId: attemptId,
          leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
          attemptCount: { increment: 1 },
        },
      });
      if (won.count === 0) return null;
      const account = await prisma.workspaceBillingAccount.findUniqueOrThrow({
        where: { workspaceId: input.workspaceId },
        select: { attemptCount: true, nextReconcileAt: true },
      });
      return {
        workspaceId: input.workspaceId,
        attemptId,
        attemptCount: account.attemptCount,
        dueAt: account.nextReconcileAt,
      };
    },
    async renewClaim(input) {
      const renewed = await prisma.workspaceBillingAccount.updateMany({
        where: {
          workspaceId: input.workspaceId,
          reconcileAttemptId: input.attemptId,
          leaseExpiresAt: { gt: input.now },
        },
        data: {
          leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
        },
      });
      return renewed.count === 1;
    },
    async scheduleRetry(input) {
      const settled = await prisma.workspaceBillingAccount.updateMany({
        where: {
          workspaceId: input.workspaceId,
          ...(input.attemptId
            ? {
                reconcileAttemptId: input.attemptId,
                leaseExpiresAt: { gt: input.now },
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
      return settled.count === 1;
    },
    async markSeatVerificationDue(input) {
      await prisma.workspaceBillingAccount.update({
        where: { workspaceId: input.workspaceId },
        data: {
          seatRevision: { increment: 1 },
          nextReconcileAt: input.now,
        },
      });
    },
    async commitNoSubscriptionState(input) {
      return prisma.$transaction(async (tx) => {
        const row = await tx.workspace.findUnique({
          where: { id: input.workspaceId },
          select: {
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
            billingAccount: { select: { health: true } },
          },
        });
        if (!row?.billingAccount) throw new Error("Workspace not found");
        const stateChanged =
          row.pricingTier !== "free" ||
          row.status !== input.workspaceStatus ||
          row.billingAccount.health !== input.health;
        const fenced = await tx.workspaceBillingAccount.updateMany({
          where: {
            workspaceId: input.workspaceId,
            reconcileAttemptId: input.attemptId,
            leaseExpiresAt: { gt: input.now },
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
          },
        });
        if (fenced.count !== 1) throw new WorkspaceBillingAttemptLost();
        await tx.workspace.update({
          where: { id: input.workspaceId },
          data: { pricingTier: "free", status: input.workspaceStatus },
        });
        const account = await tx.workspaceBillingAccount.findUniqueOrThrow({
          where: { workspaceId: input.workspaceId },
        });
        const latestCheckout = await tx.workspaceCheckoutAttempt.findFirst({
          where: { billingAccountId: account.id },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { sessionStatus: true, paymentStatus: true },
        });
        const latestCheckoutState: WorkspaceBillingProjection["latestCheckout"] =
          latestCheckout &&
          (latestCheckout.sessionStatus === "open" ||
            latestCheckout.sessionStatus === "complete" ||
            latestCheckout.sessionStatus === "expired") &&
          latestCheckout.paymentStatus
            ? {
                status: latestCheckout.sessionStatus,
                paymentStatus: latestCheckout.paymentStatus,
              }
            : null;
        return {
          workspaceId: row.id,
          ownerUserId: row.ownerUserId,
          personal: Boolean(row.personalOwnerUserId),
          hasNonOwnerMembers: row.members.length > 0,
          pricingTier: "free",
          status: input.workspaceStatus,
          providerCustomerId: account.providerCustomerId,
          canonicalSubscriptionId: null,
          interval: null,
          providerStatus: null,
          currentPeriodEnd: null,
          trialEnd: null,
          cancelAtPeriodEnd: false,
          firstPastDueAt: null,
          graceDeadlineAt: null,
          health: input.health,
          attentionReason: null,
          lastVerifiedAt: account.lastVerifiedAt,
          desiredAdditionalSeats: account.desiredAdditionalSeats,
          synchronizedAdditionalSeats: account.synchronizedAdditionalSeats,
          seatItemId: account.seatItemId,
          latestCheckout: latestCheckoutState,
        };
      });
    },
    async commitVerifiedState(input) {
      return prisma.$transaction(async (tx) => {
        const row = await tx.workspace.findUnique({
          where: { id: input.workspaceId },
          select: {
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
          },
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
              leaseExpiresAt: { gt: input.now },
            },
            data: { leaseExpiresAt: row.billingAccount.leaseExpiresAt },
          });
          if (fenced.count !== 1) throw new WorkspaceBillingAttemptLost();
        }

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
          row.status !== input.workspaceStatus ||
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

        await tx.workspace.update({
          where: { id: row.id },
          data: { pricingTier: input.tier, status: input.workspaceStatus },
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
              changed: stateChanged,
              seatStillDue,
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
              nextStatus: input.workspaceStatus,
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
        return {
          workspaceId: row.id,
          ownerUserId: row.ownerUserId,
          personal: Boolean(row.personalOwnerUserId),
          hasNonOwnerMembers: row.members.length > 0,
          pricingTier: input.tier,
          status: input.workspaceStatus,
          providerCustomerId: account.providerCustomerId,
          canonicalSubscriptionId: account.canonicalSubscriptionId,
          interval: input.interval,
          providerStatus: account.providerStatus,
          currentPeriodEnd: account.currentPeriodEndAt,
          trialEnd: account.trialEndAt,
          cancelAtPeriodEnd: account.cancelAtPeriodEnd,
          firstPastDueAt: account.firstPastDueAt,
          graceDeadlineAt: account.graceDeadlineAt,
          health: billingHealth(account.health),
          attentionReason: account.attentionReason,
          lastVerifiedAt: account.lastVerifiedAt,
          desiredAdditionalSeats: currentDesiredSeats,
          synchronizedAdditionalSeats: account.synchronizedAdditionalSeats,
          seatItemId: account.seatItemId,
          latestCheckout: null,
        };
      });
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
        return row.status === "pending_payment" ? "payment_pending" : "active";
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
      if (row.pricingTier === "free") return ["start_checkout"];
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
      throw new WorkspaceBillingError("workspace_not_found", "Workspace not found");
    }
    const settleNoSubscription = async (activating: boolean) => {
      if (!attemptId) throw new WorkspaceBillingAttemptLost();
      const workspaceStatus = activating
        ? "pending_payment"
        : current.status === "pending_payment"
          ? "pending_payment"
          : !current.personal && current.hasNonOwnerMembers
            ? "restricted"
            : "active";
      const settled = await dependencies.store.commitNoSubscriptionState({
        workspaceId,
        attemptId,
        workspaceStatus,
        health: activating ? "activating" : "current",
        now: dependencies.clock.now(),
      });
      dependencies.diagnostics.record({
        level: "info",
        message: "workspace_billing_no_subscription_verified",
        workspaceId,
        phase: "projection",
        outcome: activating ? "activating" : "current_free",
        durationMs: dependencies.clock.now().getTime() - startedAt.getTime(),
      });
      metrics.observe(
        "workspace_billing_operation_duration_ms",
        dependencies.clock.now().getTime() - startedAt.getTime(),
        {
          operation: "current_state",
          outcome: activating ? "activating" : "current_free",
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
    if (providerState.ownership.kind !== "verified") {
      return unresolved(providerState.ownership.kind);
    }
    if (providerState.ownership.workspaceId !== workspaceId) {
      return unresolved("workspace_mismatch");
    }
    if (providerState.subscriptions.length === 0) {
      if (current.pricingTier !== "free") {
        return unresolved("missing_paid_subscription");
      }
      return settleNoSubscription(current.latestCheckout?.status === "complete");
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
      (candidate) =>
        ["active", "trialing", "past_due"].includes(candidate.status),
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
      .filter((candidate) =>
        ["active", "trialing", "past_due"].includes(candidate.status),
      )
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
    const subscription =
      (hasSubscriptionConflict
        ? entitlementCandidates[0]?.subscription
        : undefined) ??
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
    let workspaceStatus: WorkspaceBillingProjection["status"];
    let health: WorkspaceBillingHealth;
    let attentionReason: string | null = null;
    let firstPastDueAt: Date | null = null;
    let graceDeadlineAt: Date | null = null;
    let effectiveAt = subscription.effectiveAt;
    switch (subscription.status) {
      case "active":
      case "trialing":
        tier = mapped.tier;
        workspaceStatus = "active";
        health = "current";
        break;
      case "incomplete":
        tier = "free";
        workspaceStatus = "pending_payment";
        health = "activating";
        break;
      case "past_due": {
        firstPastDueAt = current.firstPastDueAt ?? dependencies.clock.now();
        graceDeadlineAt =
          current.graceDeadlineAt ??
          new Date(firstPastDueAt.getTime() + 7 * 24 * 60 * 60 * 1000);
        const withinGrace =
          dependencies.clock.now().getTime() < graceDeadlineAt.getTime();
        tier = withinGrace ? current.pricingTier : "free";
        workspaceStatus =
          tier === "free" && !current.personal && current.hasNonOwnerMembers
            ? "restricted"
            : "active";
        health = "payment_action_required";
        effectiveAt = withinGrace ? firstPastDueAt : graceDeadlineAt;
        break;
      }
      case "unpaid":
      case "paused":
      case "incomplete_expired":
      case "canceled":
        tier = "free";
        workspaceStatus =
          !current.personal && current.hasNonOwnerMembers
            ? "restricted"
            : "active";
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
    let providerSeatMutation = false;
    let seat:
      | {
          desired: number;
          observed: number;
          itemId: string | null;
          revision: number;
        }
      | undefined;
    if (mapped.tier === "business" && !hasSubscriptionConflict) {
      const desired = await dependencies.store.readDesiredSeatState(workspaceId);
      const providerSeat = selectedItems.seatItems[0]?.item;
      let observed = providerSeat?.quantity ?? 0;
      let itemId = providerSeat?.id ?? null;
      if (providerSeat && !providerSeat.id) {
        return unresolved("seat_item_identity_missing");
      }
      if (observed !== desired.desired) {
        const operationKey = `workspace-seat-${workspaceId}-${desired.revision}`;
        if (!providerSeat && desired.desired > 0) {
          if (!dependencies.provider.createSeatItem) {
            throw new WorkspaceBillingError(
              "seat_provider_not_configured",
              "Paid-seat synchronization is not configured",
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
              "Paid-seat synchronization is not configured",
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
              "Paid-seat synchronization is not configured",
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
      }
      seat = {
        desired: desired.desired,
        observed,
        itemId,
        revision: desired.revision,
      };
    }
    let settled: WorkspaceBillingProjection;
    try {
      settled = await dependencies.store.commitVerifiedState({
        workspaceId,
        expectedCustomerId: providerState.customerId,
        subscription,
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
        "Checkout is not configured",
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
        "Only the Workspace owner can manage billing",
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
        "This Checkout attempt is no longer available",
      );
    }
    return {
      kind: "checkout" as const,
      url: session.url,
      expiresAt: session.expiresAt.toISOString(),
    };
  };

  return {
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
        throw new WorkspaceBillingError("workspace_not_found", "Workspace not found");
      }
      if (current.pricingTier !== "free" && current.status !== "pending_payment") {
        throw new WorkspaceBillingError(
          "billing_portal_required",
          "Manage the current subscription in the billing portal",
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
          "This plan is not available",
        );
      }
      const catalogVersion = `${input.targetTier}:${input.interval}:${price.priceId}`;
      const prepared = await dependencies.store.prepareCheckoutAttempt({
        ...input,
        catalogVersion,
        now: dependencies.clock.now(),
      });
      if (prepared.kind === "conflict") {
        throw new WorkspaceBillingError(
          "checkout_attempt_conflict",
          "This Checkout request was already used with different details",
        );
      }
      dependencies.diagnostics.record({
        level: "info",
        message: "workspace_billing_checkout_prepared",
        workspaceId: input.workspaceId,
        phase: "checkout_attempt",
        disposition: prepared.kind,
        targetPlan: input.targetTier,
        interval: input.interval,
      });
      const provider = checkoutProvider();
      const attempt = prepared.attempt;
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
            "Checkout session ownership could not be verified",
          );
        }
        const destination = checkoutDestination(session);
        dependencies.diagnostics.record({
          level: "info",
          message: "workspace_billing_checkout_ready",
          workspaceId: input.workspaceId,
          phase: "checkout_session",
          disposition: "replayed",
          durationMs: dependencies.clock.now().getTime() - startedAt.getTime(),
        });
        return destination;
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
            "Billing customer identity needs attention",
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
          "Checkout session needs attention",
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
            },
            attempt.checkoutOperationKey,
          ),
        ));
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
          "Checkout session ownership could not be verified",
        );
      }
      const expired = session.status === "expired";
      await dependencies.store.recordCheckoutReturn({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        providerAttemptId: session.attemptId,
        status: session.status,
        paymentStatus: session.paymentStatus,
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
        throw new WorkspaceBillingError("workspace_not_found", "Workspace not found");
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
          "Billing setup has not created a customer yet",
        );
      }
      if (!dependencies.provider.createPortalSession) {
        throw new WorkspaceBillingError(
          "portal_not_configured",
          "The billing portal is not configured",
        );
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
          throw new WorkspaceBillingError("workspace_not_found", "Workspace not found");
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
    async reconcileDueAccounts() {
      const now = dependencies.clock.now();
      const claims = await dependencies.store.claimDueAccounts({
        now,
        limit: dependencies.catalog.worker.batchSize,
        leaseMs: dependencies.catalog.worker.leaseMs,
      });
      dependencies.diagnostics.record({
        level: "info",
        message: "workspace_billing_accounts_claimed",
        phase: "claim",
        claimed: claims.length,
      });
      metrics.observe("workspace_billing_claims_total", claims.length, {
        surface: "worker",
      });
      for (const claim of claims) {
        metrics.observe(
          "workspace_billing_queue_age_ms",
          Math.max(0, now.getTime() - claim.dueAt.getTime()),
          {},
        );
      }
      const summary = {
        claimed: claims.length,
        reconciled: 0,
        retried: 0,
        unresolved: 0,
        staleSettlements: 0,
      };
      let cursor = 0;
      const worker = async () => {
        for (;;) {
          const claim = claims[cursor];
          cursor += 1;
          if (!claim) return;
          try {
            const result = await withProviderDeadline(
              reconcileOne(claim.workspaceId, claim.attemptId),
            );
            if (result.kind === "reconciled") {
              summary.reconciled += 1;
              continue;
            }
            summary.unresolved += 1;
            const attentionDelayMs = 6 * 60 * 60 * 1000;
            const settled = await dependencies.store.scheduleRetry({
              workspaceId: claim.workspaceId,
              attemptId: claim.attemptId,
              now: dependencies.clock.now(),
              nextReconcileAt: new Date(
                dependencies.clock.now().getTime() + attentionDelayMs,
              ),
              reason: result.reason,
              health: "attention_required",
            });
            metrics.observe("workspace_billing_retry_delay_ms", attentionDelayMs, {
              surface: "worker",
              retryBand: retryBand(claim.attemptCount),
              reason: "attention_required",
            });
            if (settled) summary.retried += 1;
            else summary.staleSettlements += 1;
          } catch (error) {
            if (error instanceof WorkspaceBillingAttemptLost) {
              summary.staleSettlements += 1;
              continue;
            }
            const baseDelay = Math.min(
              60 * 60 * 1000,
              60_000 * 2 ** Math.min(6, Math.max(0, claim.attemptCount - 1)),
            );
            const jitter = Math.floor(
              (dependencies.random?.() ?? Math.random()) *
                Math.max(1, Math.floor(baseDelay / 4)),
            );
            const settled = await dependencies.store.scheduleRetry({
              workspaceId: claim.workspaceId,
              attemptId: claim.attemptId,
              now: dependencies.clock.now(),
              nextReconcileAt: new Date(
                dependencies.clock.now().getTime() + baseDelay + jitter,
              ),
              reason: "retryable_provider",
              health: "retrying",
            });
            metrics.observe("workspace_billing_retry_delay_ms", baseDelay + jitter, {
              surface: "worker",
              retryBand: retryBand(claim.attemptCount),
              reason: "retryable_provider",
            });
            if (settled) summary.retried += 1;
            else summary.staleSettlements += 1;
          }
        }
      };
      await Promise.all(
        Array.from(
          {
            length: Math.min(
              dependencies.catalog.worker.concurrency,
              claims.length,
            ),
          },
          worker,
        ),
      );
      dependencies.diagnostics.record({
        level: "info",
        message: "workspace_billing_batch_settled",
        phase: "settlement",
        ...summary,
      });
      for (const [outcome, value] of Object.entries(summary)) {
        metrics.observe("workspace_billing_settlements_total", value, {
          outcome,
          surface: "worker",
        });
      }
      return summary;
    },
    async readBillingState(workspaceId: string): Promise<WorkspaceBillingView> {
      const current = await dependencies.store.readProjection(workspaceId);
      if (!current) throw new Error("Workspace Billing Account not found");
      return billingView(current);
    },
    async inspectAccount(workspaceId: string) {
      const current = await dependencies.store.readProjection(workspaceId);
      if (!current) {
        throw new WorkspaceBillingError("workspace_not_found", "Workspace not found");
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
