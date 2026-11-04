import type { PrismaClient } from "@prisma/client";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import type { ProcessingUsage } from "./processing-usage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPEN_NEEDS_PAGE = 100;

export type ProcessingUsageOperatorArgs =
  | { mode: "list" }
  | { mode: "refund"; needId: string; actorUserId: string; reason: string };

export function parseProcessingUsageOperatorArgs(args: string[]): ProcessingUsageOperatorArgs {
  let needId: string | null = null;
  let actorUserId: string | null = null;
  let reason: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const next = () => {
      index += 1;
      return args[index] ?? "";
    };
    if (argument === "--refund") needId = next();
    else if (argument === "--actor") actorUserId = next();
    else if (argument === "--reason") reason = next();
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (needId === null && actorUserId === null && reason === null) return { mode: "list" };
  if (!needId || !UUID.test(needId)) throw new Error("--refund must be a valid Source Refund Need UUID");
  if (!actorUserId || !UUID.test(actorUserId)) throw new Error("--actor must be a valid User UUID");
  if (!reason?.trim()) throw new Error("--reason is required");
  return { mode: "refund", needId, actorUserId, reason: reason.trim() };
}

/** Oldest open needs with the usage each would correct. Read-only. */
export async function listOpenSourceRefundNeeds(prisma: PrismaClient) {
  const needs = await prisma.sourceRefundNeed.findMany({
    where: { resolvedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: OPEN_NEEDS_PAGE,
    select: { id: true, projectId: true, sourceRevision: true, failureCode: true, createdAt: true },
  });
  const usage = await prisma.processingUsageReservation.findMany({
    where: { projectId: { in: needs.map((need) => need.projectId) } },
    select: { projectId: true, workspaceId: true, state: true, settledSeconds: true },
  });
  const byProject = new Map(usage.map((row) => [row.projectId, row]));
  return needs.map((need) => {
    const row = byProject.get(need.projectId);
    return {
      ...need,
      workspaceId: row?.workspaceId ?? null,
      usageState: row?.state ?? null,
      settledCredits: row?.settledSeconds == null ? null : row.settledSeconds / 60,
    };
  });
}

/**
 * Refunds the settled source credits behind one need and resolves every open
 * need on that Project, since a Project has one reservation. Rerunning after a
 * crash between the two steps finishes the resolution without a second refund.
 * This corrects credits only; it never moves money in Stripe.
 */
export async function refundSourceRefundNeed(
  dependencies: { prisma: PrismaClient; usage: Pick<ProcessingUsage, "refund">; now?: () => Date },
  input: { needId: string; actorUserId: string; reason: string },
) {
  const { prisma, usage } = dependencies;
  const need = await prisma.sourceRefundNeed.findUnique({
    where: { id: input.needId },
    select: { projectId: true, resolvedAt: true },
  });
  if (!need) {
    throw new ExpectedDomainFailureError({
      code: "source_refund_need_not_found",
      kind: "missing",
      message: "No Source Refund Need has this ID.",
    });
  }
  if (need.resolvedAt) return { outcome: "already_resolved" as const, projectId: need.projectId, resolved: 0 };
  const reservation = await prisma.processingUsageReservation.findUnique({
    where: { projectId: need.projectId },
    select: { state: true },
  });
  if (reservation?.state !== "refunded") {
    await usage.refund({ projectId: need.projectId, actorUserId: input.actorUserId, reason: input.reason });
  }
  const resolved = await prisma.sourceRefundNeed.updateMany({
    where: { projectId: need.projectId, resolvedAt: null },
    data: { resolvedAt: (dependencies.now ?? (() => new Date()))() },
  });
  return { outcome: "refunded" as const, projectId: need.projectId, resolved: resolved.count };
}
