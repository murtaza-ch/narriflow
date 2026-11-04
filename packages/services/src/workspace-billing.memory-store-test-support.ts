import { randomUUID } from "node:crypto";
import type { StoredPlanChangeQuote } from "./workspace-plan-change";
import {
  nextVerifiedReconcileAt,
  preservesCheckoutPaymentOutcome,
  projectWorkspaceAccessStatus,
  WorkspaceBillingAttemptLost,
  WorkspaceBillingError,
  type WorkspaceBillingProjection,
  type WorkspaceBillingStore,
  type WorkspaceCheckoutAttempt,
} from "./workspace-billing.service";

/** The Workspace Billing store contract for fast tests without PostgreSQL. */
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
    > & { ownerUserId?: string; desiredAdditionalSeats?: number; cancelAtPeriodEndRequested?: boolean }
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
        cancelAtPeriodEndRequested: workspace.cancelAtPeriodEndRequested ?? false,
        planChange: null,
        firstPastDueAt: null,
        graceDeadlineAt: null,
        health: "current",
        attentionReason: null,
        lastVerifiedAt: null,
        desiredAdditionalSeats: workspace.desiredAdditionalSeats ?? 0,
        synchronizedAdditionalSeats: null,
        seatItemId: null,
        latestCheckoutSessionId: null,
        latestCheckout: null,
      },
    ]),
  );
  const deliveries = new Map<string, string | null>();
  const checkoutAttempts = new Map<string, WorkspaceCheckoutAttempt>();
  const planChangeQuotes = new Map<string, StoredPlanChangeQuote>();
  /** Workspace ID -> attempt ID holding the one open Checkout slot. */
  const checkoutSlots = new Map<string, string>();
  const attemptView = (attempt: WorkspaceCheckoutAttempt): WorkspaceCheckoutAttempt => ({
    ...attempt,
    holdsSlot: checkoutSlots.get(attempt.workspaceId) === attempt.id,
  });
  const releaseSlot = (attempt: WorkspaceCheckoutAttempt) => {
    if (checkoutSlots.get(attempt.workspaceId) === attempt.id) {
      checkoutSlots.delete(attempt.workspaceId);
    }
  };
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
    async readPlanChangeQuote(input) {
      return [...planChangeQuotes.values()].find((quote) => quote.workspaceId === input.workspaceId && (input.id ? quote.public.id === input.id : quote.clientIdempotencyKey === input.clientIdempotencyKey)) ?? null;
    },
    async readConfirmingPlanChangeQuote(workspaceId) {
      const quotes = [...planChangeQuotes.values()].filter((quote) => quote.workspaceId === workspaceId && quote.phase === "confirming");
      if (quotes.length > 1) throw new WorkspaceBillingError("plan_change_conflict");
      return quotes[0] ?? null;
    },
    async savePlanChangeQuote(quote) {
      if ([...planChangeQuotes.values()].some((existing) => existing.clientIdempotencyKey === quote.clientIdempotencyKey)) throw new WorkspaceBillingError("plan_change_conflict");
      planChangeQuotes.set(quote.public.id, structuredClone(quote));
    },
    async markPlanChangeQuote(input) {
      const quote = planChangeQuotes.get(input.id);
      if (!quote || quote.workspaceId !== input.workspaceId) throw new WorkspaceBillingError("plan_change_quote_missing");
      quote.phase = input.phase;
    },
    async releasePlanChangeClaim(input) {
      const state = runtime.get(input.workspaceId);
      if (state?.attemptId === input.attemptId) {
        state.attemptId = null;
        state.leaseExpiresAt = null;
        if (input.wake) state.nextReconcileAt = input.now;
      }
    },
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
        throw new WorkspaceBillingError("workspace_not_found");
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
        return {
          kind: unchanged ? "existing" : "conflict",
          attempt: attemptView(existing),
        };
      }
      const holderId = checkoutSlots.get(input.workspaceId);
      const holder = holderId
        ? [...checkoutAttempts.values()].find((candidate) => candidate.id === holderId)
        : undefined;
      if (holder) return { kind: "held", attempt: attemptView(holder) };
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
        holdsSlot: true,
        createdAt: input.now,
      };
      checkoutAttempts.set(input.clientIdempotencyKey, attempt);
      checkoutSlots.set(input.workspaceId, id);
      const row = rows.get(input.workspaceId);
      if (row) row.latestCheckout = null;
      return { kind: "created", attempt: attemptView(attempt) };
    },
    async releaseCheckoutSlot(input) {
      const attempt = [...checkoutAttempts.values()].find(
        (candidate) => candidate.id === input.attemptId,
      );
      if (
        !attempt ||
        checkoutSlots.get(attempt.workspaceId) !== attempt.id ||
        attempt.providerSessionId !== input.expectedSessionId
      ) {
        return false;
      }
      releaseSlot(attempt);
      return true;
    },
    async bindCheckoutCustomer(input) {
      const row = rows.get(input.workspaceId);
      if (!row) throw new WorkspaceBillingError("workspace_not_found");
      if (row.providerCustomerId && row.providerCustomerId !== input.customerId) {
        throw new WorkspaceBillingError(
          "customer_identity_conflict",
        );
      }
      row.providerCustomerId = input.customerId;
    },
    async bindCheckoutSession(input) {
      const attempt = [...checkoutAttempts.values()].find(
        (candidate) => candidate.id === input.attemptId,
      );
      if (!attempt) {
        throw new WorkspaceBillingError("checkout_attempt_missing");
      }
      if (checkoutSlots.get(attempt.workspaceId) !== attempt.id) {
        throw new WorkspaceBillingError("checkout_attempt_terminal");
      }
      if (attempt.providerSessionId && attempt.providerSessionId !== input.sessionId) {
        throw new WorkspaceBillingError(
          "checkout_session_conflict",
        );
      }
      attempt.providerSessionId = input.sessionId;
      attempt.expiresAt = input.expiresAt;
      const row = rows.get(attempt.workspaceId);
      if (row) row.latestCheckoutSessionId = input.sessionId;
    },
    async recordCheckoutState(input) {
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
        );
      }
      const row = rows.get(input.workspaceId)!;
      if (input.reconcileAttemptId) {
        const state = runtime.get(input.workspaceId)!;
        if (
          state.attemptId !== input.reconcileAttemptId ||
          !state.leaseExpiresAt ||
          state.leaseExpiresAt.getTime() <= input.now.getTime()
        ) {
          throw new WorkspaceBillingAttemptLost();
        }
      }
      const currentPaymentStatus = row.latestCheckout?.paymentStatus;
      const preservesEstablishedOutcome = preservesCheckoutPaymentOutcome(
        currentPaymentStatus,
        input.paymentStatus,
      );
      if (input.wakeReconciliation && !preservesEstablishedOutcome) {
        row.health = "activating";
        row.attentionReason = null;
        const state = runtime.get(input.workspaceId)!;
        state.nextReconcileAt = input.now;
      }
      row.latestCheckout = {
        status: input.status,
        paymentStatus: preservesEstablishedOutcome
          ? currentPaymentStatus!
          : input.paymentStatus,
      };
      // An expired or failed session can no longer become a subscription.
      if (
        row.latestCheckout.status === "expired" ||
        row.latestCheckout.paymentStatus === "failed"
      ) {
        releaseSlot(attempt);
      }
      return attemptView(attempt);
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
      const workspaceStatus = projectWorkspaceAccessStatus({
        tier: "free",
        hasNonOwnerMembers: current.hasNonOwnerMembers,
        awaitingFirstPayment: input.workspaceStatus === "pending_payment",
      });
      const changed =
        Boolean(input.customerDeleted) ||
        current.pricingTier !== "free" ||
        current.status !== workspaceStatus ||
        current.health !== input.health;
      const next = {
        ...current,
        ...(input.customerDeleted
          ? { providerCustomerId: null, seatItemId: null, synchronizedAdditionalSeats: null }
          : {}),
        pricingTier: "free" as const,
        status: workspaceStatus,
        canonicalSubscriptionId: null,
        interval: null,
        providerStatus: null,
        currentPeriodEnd: null,
        trialEnd: null,
        cancelAtPeriodEnd: false,
        planChange: null,
        firstPastDueAt: null,
        graceDeadlineAt: null,
        health: input.health,
        attentionReason: null,
      };
      rows.set(input.workspaceId, next);
      if (input.customerDeleted) checkoutSlots.delete(input.workspaceId);
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
      const workspaceStatus = projectWorkspaceAccessStatus({
        tier: input.tier,
        hasNonOwnerMembers: current.hasNonOwnerMembers,
        awaitingFirstPayment: input.workspaceStatus === "pending_payment",
      });
      const changed =
        current.pricingTier !== input.tier ||
        current.status !== workspaceStatus ||
        current.canonicalSubscriptionId !== input.subscription.id ||
        current.providerStatus !== input.subscription.status ||
        current.health !== input.health ||
        current.attentionReason !== input.attentionReason;
      const next: WorkspaceBillingProjection = {
        ...current,
        pricingTier: input.tier,
        status: workspaceStatus,
        canonicalSubscriptionId: input.subscription.id,
        interval: input.interval,
        providerStatus: input.subscription.status,
        currentPeriodEnd: input.subscription.currentPeriodEnd,
        trialEnd: input.subscription.trialEnd,
        cancelAtPeriodEnd: input.subscription.cancelAtPeriodEnd,
        planChange: input.subscription.planChange ?? null,
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
          changed: changed || Boolean(input.seatConvergenceFailed),
          seatStillDue:
            !input.seatConvergenceFailed &&
            input.seat !== undefined &&
            runtimeState.seatRevision !== input.seat.revision,
        });
      }
      return next;
    },
  };
}
