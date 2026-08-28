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

export type WorkspaceBillingAction = "open_portal" | "retry" | "contact_support";
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
  items: Array<{ priceId: string; quantity: number }>;
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

export interface WorkspaceBillingProvider {
  verifyDelivery(rawBody: string, signature: string): VerifiedBillingDelivery;
  retrieveCurrentState(customerId: string): Promise<ProviderCurrentState>;
}

export interface WorkspaceBillingView {
  workspaceId: string;
  plan: PricingTier;
  interval: BillingInterval | null;
  status: string;
  health: WorkspaceBillingHealth;
  renewalOrEndAt: string | null;
  cancelAtPeriodEnd: boolean;
  graceDeadlineAt: string | null;
  lastSuccessfulSyncAt: string | null;
  actions: WorkspaceBillingAction[];
}

export interface WorkspaceBillingProjection {
  workspaceId: string;
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
  }): Promise<Array<{ workspaceId: string; attemptId: string; attemptCount: number }>>;
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
  }): Promise<WorkspaceBillingProjection>;
}

export class WorkspaceBillingAttemptLost extends Error {
  constructor() {
    super("Workspace Billing reconciliation attempt lost");
    this.name = "WorkspaceBillingAttemptLost";
  }
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
    >
  >,
): WorkspaceBillingStore {
  const rows = new Map<string, WorkspaceBillingProjection>(
    workspaces.map((workspace) => [
      workspace.workspaceId,
      {
        ...workspace,
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
      },
    ]),
  );
  const deliveries = new Map<string, string | null>();
  const runtime = new Map(
    workspaces.map((workspace) => [
      workspace.workspaceId,
      {
        nextReconcileAt: new Date(0),
        attemptId: null as string | null,
        leaseExpiresAt: null as Date | null,
        attemptCount: 0,
      },
    ]),
  );

  return {
    async readProjection(workspaceId) {
      return rows.get(workspaceId) ?? null;
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
        claimed.push({ workspaceId, attemptId, attemptCount: state.attemptCount });
      }
      return claimed;
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
      };
      rows.set(input.workspaceId, next);
      if (input.attemptId) {
        runtimeState.attemptId = null;
        runtimeState.leaseExpiresAt = null;
        runtimeState.attemptCount = 0;
        runtimeState.nextReconcileAt = new Date(
          input.now.getTime() + 24 * 60 * 60 * 1000,
        );
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
      return {
        workspaceId: row.id,
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
      };
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
          select: { id: true, workspaceId: true, attemptCount: true },
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
        });
      }
      return claims;
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
    async commitVerifiedState(input) {
      return prisma.$transaction(async (tx) => {
        const row = await tx.workspace.findUnique({
          where: { id: input.workspaceId },
          select: {
            id: true,
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
          row.billingAccount.attentionReason !== input.attentionReason;

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
            nextReconcileAt: new Date(input.now.getTime() + 24 * 60 * 60 * 1000),
            reconcileAttemptId: null,
            leaseExpiresAt: null,
            attemptCount: 0,
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
        };
      });
    },
  };
}

export interface WorkspaceBillingDiagnostics {
  record(event: Record<string, unknown>): void;
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
        return row.status === "pending_payment" ? "payment_pending" : "active";
    }
  };
  return {
    workspaceId: row.workspaceId,
    plan: row.pricingTier,
    interval: row.interval,
    status: productStatus(),
    health: row.health,
    renewalOrEndAt: (row.trialEnd ?? row.currentPeriodEnd)?.toISOString() ?? null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    graceDeadlineAt: row.graceDeadlineAt?.toISOString() ?? null,
    lastSuccessfulSyncAt: row.lastVerifiedAt?.toISOString() ?? null,
    actions:
      row.health === "attention_required"
        ? ["open_portal", "contact_support"]
        : row.health === "retrying"
          ? ["retry"]
          : ["open_portal"],
  };
}

export function createWorkspaceBillingModule(dependencies: {
  catalog: BillingCatalog;
  store: WorkspaceBillingStore;
  provider: WorkspaceBillingProvider;
  clock: WorkspaceBillingClock;
  diagnostics: WorkspaceBillingDiagnostics;
  random?: () => number;
}) {
  const wakeEventTypes = new Set([
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.paused",
    "customer.subscription.resumed",
    "customer.subscription.deleted",
    "invoice.payment_succeeded",
    "invoice.payment_failed",
    "customer.updated",
    "customer.deleted",
  ]);
  const reconcileOne = async (
    workspaceId: string,
    attemptId?: string,
  ): Promise<ReconcileCurrentStateResult> => {
    const startedAt = dependencies.clock.now();
    const current = await dependencies.store.readProjection(workspaceId);
    if (!current?.providerCustomerId) {
      throw new Error("Workspace Billing Account has no provider customer");
    }
    const providerState = await dependencies.provider.retrieveCurrentState(
      current.providerCustomerId,
    );
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
      return {
        kind: "unresolved",
        reason: "customer_mismatch",
        view: billingView(current),
      };
    }
    if (providerState.ownership.kind !== "verified") {
      return {
        kind: "unresolved",
        reason: providerState.ownership.kind,
        view: billingView(current),
      };
    }
    if (providerState.ownership.workspaceId !== workspaceId) {
      return {
        kind: "unresolved",
        reason: "workspace_mismatch",
        view: billingView(current),
      };
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
      return { base, seats, unknown, invalidSeats };
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
      return { kind: "unresolved", reason, view: billingView(current) };
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
      return {
        kind: "unresolved",
        reason: "unsupported_provider_state",
        view: billingView(current),
      };
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
        return {
          kind: "unresolved",
          reason: "unsupported_subscription_status",
          view: billingView(current),
        };
    }
    if (hasSubscriptionConflict) {
      if (tierRank[current.pricingTier] > tierRank[tier]) {
        tier = current.pricingTier;
      }
      health = "attention_required";
      attentionReason = "multiple_entitlement_subscriptions";
    }
    const settled = await dependencies.store.commitVerifiedState({
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
    });
    dependencies.diagnostics.record({
      level: "info",
      message: "workspace_billing_reconciled",
      workspaceId,
      phase: "projection",
      providerOperation: "retrieve_current_state",
      mappedPlan: tier,
      outcome: "reconciled",
      durationMs: dependencies.clock.now().getTime() - startedAt.getTime(),
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

  return {
    async acceptStripeDelivery(rawBody: string, signature: string) {
      const delivery = dependencies.provider.verifyDelivery(rawBody, signature);
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
      return { kind: disposition, workspaceId: accepted.workspaceId };
    },
    async reconcileCurrentState(
      workspaceId: string,
    ): Promise<ReconcileCurrentStateResult> {
      try {
        const result = await reconcileOne(workspaceId);
        if (result.kind === "reconciled") return result;
        await dependencies.store.scheduleRetry({
          workspaceId,
          now: dependencies.clock.now(),
          nextReconcileAt: new Date(
            dependencies.clock.now().getTime() + 6 * 60 * 60 * 1000,
          ),
          reason: result.reason,
          health: "attention_required",
        });
        const current = await dependencies.store.readProjection(workspaceId);
        return {
          ...result,
          view: current ? billingView(current) : result.view,
        };
      } catch (error) {
        await dependencies.store.scheduleRetry({
          workspaceId,
          now: dependencies.clock.now(),
          nextReconcileAt: new Date(
            dependencies.clock.now().getTime() + 60_000,
          ),
          reason: "retryable_provider",
          health: "retrying",
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
            const settled = await dependencies.store.scheduleRetry({
              workspaceId: claim.workspaceId,
              attemptId: claim.attemptId,
              now: dependencies.clock.now(),
              nextReconcileAt: new Date(
                dependencies.clock.now().getTime() + 6 * 60 * 60 * 1000,
              ),
              reason: result.reason,
              health: "attention_required",
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
      return summary;
    },
    async readBillingState(workspaceId: string): Promise<WorkspaceBillingView> {
      const current = await dependencies.store.readProjection(workspaceId);
      if (!current) throw new Error("Workspace Billing Account not found");
      return billingView(current);
    },
  };
}
