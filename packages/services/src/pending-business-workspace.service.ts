import type { Prisma, PrismaClient } from "@prisma/client";
import type { WorkspaceBillingProvider } from "./workspace-billing.service";

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 25;
const RECENT_UPDATE_MS = 60 * 60 * 1000;
const ATTEMPT_LIMIT = 100;

// Count soft-deleted content too. Deleting a pending purchase must never discard work.
const contentCounts = {
  projects: true, uploadSessions: true, folders: true, brandTemplates: true,
  brandProfiles: true, brandFonts: true, visualAssets: true, audioAssets: true,
  clipExports: true, generatedMediaJobs: true, recipes: true, autopilotRules: true,
  socialAccounts: true, socialPosts: true, zoomConnections: true, apiKeys: true,
  trackedVideos: true, standingGrants: true, reviewRounds: true,
  campaignOperations: true, assistedCopyGenerations: true,
  processingUsage: true, generatedMediaUsage: true,
} as const;

export const pendingBusinessWorkspaceSelection = {
  id: true, ownerUserId: true, personalOwnerUserId: true, status: true, pricingTier: true,
  createdAt: true, updatedAt: true, avatarStorageKey: true,
  defaultBrandProfileId: true, defaultBrandTemplateId: true,
  members: { select: { userId: true, role: true }, take: 2 },
  _count: { select: contentCounts },
  billingAccount: { include: {
    checkoutAttempts: { orderBy: { id: "asc" }, take: ATTEMPT_LIMIT + 1 },
    _count: { select: { transitions: { where: { OR: [
      { sourceSubscriptionId: { not: null } }, { nextTier: { not: "free" } },
      { previousTier: { not: "free" } },
    ] } }, deliveries: { where: { subjectSubscriptionId: { not: null } } }, planChangeAttempts: true } },
  } },
} as const satisfies Prisma.WorkspaceSelect;

type PendingWorkspace = Prisma.WorkspaceGetPayload<{ select: typeof pendingBusinessWorkspaceSelection }>;

export function canRemovePendingBusinessWorkspace(row: PendingWorkspace): boolean {
  const account = row.billingAccount;
  return row.status === "pending_payment" && row.pricingTier === "free" &&
    row.personalOwnerUserId === null && row.avatarStorageKey === null &&
    row.defaultBrandProfileId === null && row.defaultBrandTemplateId === null &&
    row.members.length === 1 && row.members[0]?.userId === row.ownerUserId &&
    row.members[0]?.role === "owner" && Object.values(row._count).every((count) => count === 0) &&
    account !== null && account.canonicalSubscriptionId === null && account.providerStatus === null &&
    Object.values(account._count).every((count) => count === 0) &&
    account.checkoutAttempts.length <= ATTEMPT_LIMIT &&
    account.checkoutAttempts.every((attempt) => attempt.sessionStatus !== "complete" && attempt.paymentStatus !== "paid");
}

// Reconciliation leases, retry clocks and open -> expired observations can change
// while Stripe expires the session. Only identity/history changes invalidate the check.
function billingFacts(row: PendingWorkspace): string {
  const account = row.billingAccount!;
  return JSON.stringify({
    ownerUserId: row.ownerUserId,
    customerId: account.providerCustomerId,
    accountId: account.id,
    subscriptionId: account.canonicalSubscriptionId,
    providerStatus: account.providerStatus,
    attempts: account.checkoutAttempts.map(({ id, providerSessionId }) => ({ id, providerSessionId })),
  });
}

export function pendingBusinessWorkspaceDueAt(row: PendingWorkspace): number {
  // Session creation is bounded to 24h. A lost provider response has no expiresAt;
  // allow that full session lifetime plus the same extra day before sweeping it.
  return Math.max(row.createdAt.getTime() + 2 * DAY_MS, ...row.billingAccount!.checkoutAttempts.map(
    (attempt) => (attempt.expiresAt?.getTime() ?? attempt.createdAt.getTime() + DAY_MS) + DAY_MS,
  ));
}

export interface PendingBusinessWorkspaceDependencies {
  prisma: PrismaClient;
  provider: Pick<WorkspaceBillingProvider, "retrieveCurrentState" | "findCustomersByWorkspace" | "retrieveCheckoutSession" | "findCheckoutSessionsByAttempt">;
  expireSession(sessionId: string): Promise<void>;
  now?: () => Date;
}

/** Provider checks happen outside transactions. The final transaction locks parents
 * and compares billing identities, then rechecks content, members and payment history. */
export function createPendingBusinessWorkspaceService(deps: PendingBusinessWorkspaceDependencies) {
  const { prisma, provider } = deps;
  const now = deps.now ?? (() => new Date());

  async function remove(workspaceId: string, reason: "expired" | "canceled", actorUserId?: string): Promise<boolean> {
    let row = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: pendingBusinessWorkspaceSelection });
    // Missing and inaccessible IDs both acknowledge an idempotent no-op.
    if (!row) return true;
    if (actorUserId && row.ownerUserId !== actorUserId) return true;
    if (!canRemovePendingBusinessWorkspace(row)) return false;
    if (reason === "expired" && (pendingBusinessWorkspaceDueAt(row) > now().getTime() ||
      row.updatedAt.getTime() > now().getTime() - RECENT_UPDATE_MS)) return false;
    const account = row.billingAccount!;
    const preparing = account.checkoutAttempts.filter((attempt) => !attempt.providerSessionId && attempt.activeBillingAccountId);
    // Fence an abandoned provider preparation before recovering its possible session.
    // A late bind cannot hand out its URL after this slot is released.
    if (preparing.length) {
      await prisma.workspaceCheckoutAttempt.updateMany({
        where: { id: { in: preparing.map((attempt) => attempt.id) }, providerSessionId: null },
        data: { activeBillingAccountId: null },
      });
      row = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: pendingBusinessWorkspaceSelection });
      if (!row || !canRemovePendingBusinessWorkspace(row)) return false;
    }
    const before = billingFacts(row);
    const current = row.billingAccount!;
    const customers = current.providerCustomerId
      ? [{ customerId: current.providerCustomerId }]
      : current.checkoutAttempts.length
        ? await provider.findCustomersByWorkspace!(workspaceId)
        : [];
    if (customers.length > 1) return false;
    // Even a canceled or incomplete-expired subscription is subscription history.
    for (const customer of customers) {
      const state = await provider.retrieveCurrentState(customer.customerId);
      if (state.ownership.kind !== "verified" || state.ownership.workspaceId !== workspaceId ||
        state.customerId !== customer.customerId || state.subscriptions.length !== 0) return false;
    }
    for (const attempt of current.checkoutAttempts) {
      const sessions = attempt.providerSessionId
        ? [await provider.retrieveCheckoutSession!(attempt.providerSessionId)]
        : customers.length
          ? await provider.findCheckoutSessionsByAttempt!({ attemptId: attempt.id, customerId: customers[0]!.customerId })
          : [];
      for (const session of sessions) {
        if (session.workspaceId !== workspaceId || session.attemptId !== attempt.id ||
          session.status === "complete" || session.paymentStatus === "paid") return false;
        if (session.status === "open") {
          if (reason === "expired") return false;
          await deps.expireSession(session.sessionId);
          const expired = await provider.retrieveCheckoutSession!(session.sessionId);
          if (expired.status !== "expired" || expired.paymentStatus === "paid") return false;
        }
      }
    }
    const removed = await prisma.$transaction(async (tx) => {
      // FOR UPDATE blocks new FK children during the final content check/delete.
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "WorkspaceBillingAccount" WHERE "workspaceId" = ${workspaceId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "WorkspaceCheckoutAttempt" WHERE "billingAccountId" = ${current.id}::uuid FOR UPDATE`;
      const latest = await tx.workspace.findUnique({ where: { id: workspaceId }, select: pendingBusinessWorkspaceSelection });
      if (!latest) return true;
      if (!canRemovePendingBusinessWorkspace(latest) || billingFacts(latest) !== before) return false;
      if (reason === "expired" && (pendingBusinessWorkspaceDueAt(latest) > now().getTime() ||
        latest.updatedAt.getTime() > now().getTime() - RECENT_UPDATE_MS)) return false;
      await tx.workspace.delete({ where: { id: workspaceId } });
      return true;
    });
    if (removed) console.warn(JSON.stringify({ level: "info", message: "pending_business_workspace_removed", workspaceId, reason }));
    return removed;
  }

  return {
    cancel: (workspaceId: string, actorUserId: string) => remove(workspaceId, "canceled", actorUserId),
    async sweep() {
      let checked = 0;
      let removed = 0;
      try {
        const candidates = await prisma.workspace.findMany({
          where: {
            status: "pending_payment", personalOwnerUserId: null,
            createdAt: { lte: new Date(now().getTime() - 2 * DAY_MS) },
            updatedAt: { lte: new Date(now().getTime() - RECENT_UPDATE_MS) },
          },
          // Rotate protected rows too, rather than starving later expired workspaces.
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: BATCH_SIZE,
          select: { id: true },
        });
        for (const candidate of candidates) {
          checked++;
          try {
            if (await remove(candidate.id, "expired")) removed++;
          } catch (error) {
            logDeferred(error, candidate.id);
          }
          try {
            await prisma.workspace.updateMany({ where: { id: candidate.id, status: "pending_payment" }, data: { updatedAt: now() } });
          } catch (error) {
            logDeferred(error, candidate.id);
          }
        }
      } catch (error) {
        logDeferred(error);
      }
      return { checked, removed };
    },
  };
}

function logDeferred(error: unknown, workspaceId?: string) {
  console.warn(JSON.stringify({ level: "warn", message: "pending_business_workspace_cleanup_deferred", workspaceId, errorName: error instanceof Error ? error.name : typeof error }));
}
