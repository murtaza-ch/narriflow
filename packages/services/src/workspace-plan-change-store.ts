import { getPrismaClient } from "@narriflow/db/client";
import { planChangeQuoteSchema } from "@narriflow/validators";
import type { Prisma } from "@prisma/client";
import type { StoredPlanChangeQuote, WorkspacePlanChangeStore } from "./workspace-plan-change";
import { WorkspaceBillingError } from "./workspace-billing.service";

export function createPrismaWorkspacePlanChangeStore(prisma: NonNullable<ReturnType<typeof getPrismaClient>>): Pick<WorkspacePlanChangeStore, "readPlanChangeQuote" | "readConfirmingPlanChangeQuote" | "savePlanChangeQuote" | "markPlanChangeQuote"> {
  function storedQuote(row: { id: string; quote: Prisma.JsonValue; phase: string; actorUserId: string; clientIdempotencyKey: string; targetTier: string; interval: string; billingAccount: { workspaceId: string } }): StoredPlanChangeQuote {
    const data = row.quote as unknown as StoredPlanChangeQuote;
    const quote = planChangeQuoteSchema.parse(data.public);
    if (!["quoted", "confirming", "submitted", "expired"].includes(row.phase) || data.workspaceId !== row.billingAccount.workspaceId || data.actorUserId !== row.actorUserId || data.clientIdempotencyKey !== row.clientIdempotencyKey || quote.id !== row.id || quote.tier !== row.targetTier || quote.interval !== row.interval) throw new WorkspaceBillingError("plan_change_conflict");
    return { ...data, public: quote, phase: row.phase as StoredPlanChangeQuote["phase"] };
  }
  return {
    async readPlanChangeQuote(input) {
      const row = await prisma.workspacePlanChangeAttempt.findFirst({
        where: { ...(input.id ? { id: input.id } : { clientIdempotencyKey: input.clientIdempotencyKey }), billingAccount: { workspaceId: input.workspaceId } },
        include: { billingAccount: { select: { workspaceId: true } } },
      });
      if (!row) return null;
      return storedQuote(row);
    },
    async readConfirmingPlanChangeQuote(workspaceId) {
      const rows = await prisma.workspacePlanChangeAttempt.findMany({
        where: { billingAccount: { workspaceId }, phase: "confirming" },
        include: { billingAccount: { select: { workspaceId: true } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 2,
      });
      if (rows.length > 1) throw new WorkspaceBillingError("plan_change_conflict");
      return rows[0] ? storedQuote(rows[0]) : null;
    },
    async savePlanChangeQuote(quote) {
      const account = await prisma.workspaceBillingAccount.findUniqueOrThrow({ where: { workspaceId: quote.workspaceId }, select: { id: true } });
      try {
        await prisma.workspacePlanChangeAttempt.create({ data: { id: quote.public.id, billingAccountId: account.id, actorUserId: quote.actorUserId, clientIdempotencyKey: quote.clientIdempotencyKey, targetTier: quote.public.tier, interval: quote.public.interval, quote: quote as unknown as Prisma.InputJsonValue, phase: quote.phase } });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new WorkspaceBillingError("plan_change_conflict");
        throw error;
      }
    },
    async markPlanChangeQuote(input) {
      const updated = await prisma.workspacePlanChangeAttempt.updateMany({ where: { id: input.id, billingAccount: { workspaceId: input.workspaceId } }, data: { phase: input.phase } });
      if (updated.count !== 1) throw new WorkspaceBillingError("plan_change_quote_missing");
    },
  };
}
