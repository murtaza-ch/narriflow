import type { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  lowestTier,
  PLAN_CATALOG,
  planLimits,
  processingPeriodEnd,
  processingPeriodStart,
  resolvePricingTier,
  type PricingTier,
} from "@narriflow/validators";
import { GeneratedMediaJobError, type GenerationUsageLedger } from "./generated-media";
import { generatedImagePolicy, type GenerationUsagePolicy } from "./generation-usage";
import { hasFeature, PlanRequirementError } from "./plan-features";

/**
 * Generation counts: one Workspace-owned reservation per accepted AI image
 * request or voice-over dub, keyed by the subject id (`jobId`). Images count
 * per UTC month on paid plans, or for the Workspace's lifetime under Free's
 * `trial_metered` sample; dubs count per UTC month. Each kind has its own
 * allowance. A reservation keeps its admission period; only a deliberate
 * dub re-admission moves it to the current period.
 */

type Tx = Prisma.TransactionClient;
export type GenerationUsageKind = "image" | "dub";

const COUNTED = ["reserved", "finalized"] as const;

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

/** Serializes every count admission for one Workspace. Re-entrant within a transaction. */
export async function lockGenerationUsage(tx: Tx, workspaceId: string) {
  const key = `generation_usage:${workspaceId}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"`;
}

function tierName(tier: PricingTier) {
  return PLAN_CATALOG[tier].name;
}

function countWhere(input: {
  kind: GenerationUsageKind;
  workspaceId: string;
  policy: GenerationUsagePolicy;
  periodStart: Date;
  excludeJobId?: string;
}): Prisma.GeneratedMediaUsageReservationWhereInput {
  return {
    workspaceId: input.workspaceId,
    kind: input.kind,
    status: { in: [...COUNTED] },
    // The Free sample counts only sample-policy requests, ever. Monthly
    // allowances count every request admitted in the period.
    ...(input.kind === "image" && input.policy === "trial_metered"
      ? { policy: "trial_metered" }
      : { periodStart: input.periodStart }),
    ...(input.excludeJobId ? { jobId: { not: input.excludeJobId } } : {}),
  };
}

async function requireAllowance(
  tx: Tx,
  input: {
    kind: GenerationUsageKind;
    workspaceId: string;
    tier: PricingTier;
    policy: GenerationUsagePolicy;
    periodStart: Date;
    excludeJobId?: string;
  },
) {
  const used = await tx.generatedMediaUsageReservation.count({ where: countWhere(input) });
  if (input.kind === "image") {
    const allowance = planLimits(input.tier).generatedImages;
    if (used >= allowance.count) {
      const requiredTier = lowestTier(
        (plan) => plan.limits.generatedImages.period === "month" && plan.limits.generatedImages.count > used,
      );
      throw new PlanRequirementError({
        code: "plan_limit_reached",
        message:
          (allowance.period === "lifetime"
            ? "The free AI image sample has been used."
            : `This plan includes ${allowance.count} AI images a month.`) +
          (requiredTier && requiredTier !== input.tier
            ? ` ${tierName(requiredTier)} includes ${planLimits(requiredTier).generatedImages.count} a month.`
            : ""),
        currentTier: input.tier,
        requiredTier: requiredTier === input.tier ? null : requiredTier,
        limit: "generatedImages",
        used,
        max: allowance.count,
      });
    }
    // Concurrency is an operational bound across every period for the kind.
    const active = await tx.generatedMediaUsageReservation.count({
      where: { workspaceId: input.workspaceId, kind: "image", status: "reserved" },
    });
    if (active >= allowance.concurrency) {
      throw new GeneratedMediaJobError("generated_media_concurrency_limit_reached");
    }
    return;
  }
  const max = planLimits(input.tier).dubs.perMonth;
  if (used >= max) {
    const requiredTier = lowestTier((plan) => plan.limits.dubs.perMonth > used);
    throw new PlanRequirementError({
      code: "plan_limit_reached",
      message:
        `This plan includes ${max} voice-over dubs a month.` +
        (requiredTier && requiredTier !== input.tier ? ` ${tierName(requiredTier)} includes more.` : ""),
      currentTier: input.tier,
      requiredTier: requiredTier === input.tier ? null : requiredTier,
      limit: "dubs",
      used,
      max,
    });
  }
}

/**
 * Reserves one count for `jobId` inside the caller's transaction, after taking
 * the Workspace generation lock. A replay of a live or finalized reservation
 * returns it unchanged. `readmit` is the deliberate re-request of a dub whose
 * earlier attempt failed: its reservation (released, or still reserved while
 * the failure settles) moves to the current period after a fresh allowance check.
 */
export async function reserveGenerationUsage(
  tx: Tx,
  input: {
    kind: GenerationUsageKind;
    jobId: string;
    workspaceId: string;
    actorUserId: string;
    pricingTier: string;
    now: Date;
    attached: boolean;
    readmit?: boolean;
  },
): Promise<{ reservationId: string }> {
  await lockGenerationUsage(tx, input.workspaceId);
  const tier = resolvePricingTier(input.pricingTier);
  const policy: GenerationUsagePolicy = input.kind === "image" ? generatedImagePolicy(tier) : "metered";
  const periodStart = processingPeriodStart(input.now);
  const existing = await tx.generatedMediaUsageReservation.findUnique({
    where: { jobId: input.jobId },
    select: { id: true, kind: true, workspaceId: true, status: true },
  });
  if (existing && (existing.kind !== input.kind || existing.workspaceId !== input.workspaceId)) {
    throw new GeneratedMediaJobError("generated_media_usage_reconciliation_required");
  }
  if (existing && !input.readmit) {
    if (existing.status === "released") {
      throw new GeneratedMediaJobError("generated_media_usage_reconciliation_required");
    }
    return { reservationId: existing.id };
  }
  if (existing?.status === "finalized") {
    throw new GeneratedMediaJobError("generated_media_usage_reconciliation_required");
  }
  await requireAllowance(tx, {
    kind: input.kind,
    workspaceId: input.workspaceId,
    tier,
    policy,
    periodStart,
    excludeJobId: existing?.id ? input.jobId : undefined,
  });
  const data = {
    actorUserId: input.actorUserId,
    policy,
    periodStart,
    status: "reserved" as const,
    actualUnits: null,
    reason: null,
    settledAt: null,
    attachedAt: input.attached ? input.now : null,
  };
  const reservation = existing
    ? await tx.generatedMediaUsageReservation.update({ where: { id: existing.id }, data, select: { id: true } })
    : await tx.generatedMediaUsageReservation.create({
        data: { ...data, jobId: input.jobId, kind: input.kind, workspaceId: input.workspaceId },
        select: { id: true },
      });
  return { reservationId: reservation.id };
}

/** Counts a reservation as one delivered request. Idempotent; refuses a released or missing one. */
export async function finalizeGenerationUsage(
  tx: Tx,
  input: { kind: GenerationUsageKind; jobId: string; reservationId?: string; units: number; reason?: string },
) {
  const where = { jobId: input.jobId, kind: input.kind, ...(input.reservationId ? { id: input.reservationId } : {}) };
  const result = await tx.generatedMediaUsageReservation.updateMany({
    where: { ...where, status: "reserved" },
    data: { status: "finalized", actualUnits: input.units, settledAt: new Date(), reason: input.reason ?? null },
  });
  if (result.count === 1) return;
  const existing = await tx.generatedMediaUsageReservation.findFirst({ where, select: { status: true } });
  if (existing?.status === "finalized") return;
  throw new GeneratedMediaJobError("generated_media_usage_reconciliation_required");
}

/** Returns reservations after a known failure before delivery. Finalized counts never return. */
export async function releaseGenerationUsage(
  tx: Tx,
  input: { kind: GenerationUsageKind; jobIds: string[]; reason: string },
) {
  if (input.jobIds.length === 0) return 0;
  const result = await tx.generatedMediaUsageReservation.updateMany({
    where: { jobId: { in: input.jobIds }, kind: input.kind, status: "reserved" },
    data: { status: "released", reason: input.reason, settledAt: new Date() },
  });
  return result.count;
}

/**
 * Releases the counts of dubs that failed under an attempt whose run is now
 * terminal (`includeProcessing` when the attempt itself is failing them). The dubs are re-read under the Workspace generation lock, which
 * every re-admission holds: a dub re-admitted meanwhile is queued with no
 * attempt, so its new reservation is not touched.
 */
export async function releaseFailedDubUsage(
  tx: Tx,
  input: { projectId: string; attemptId: string; reason: string; includeProcessing?: boolean },
) {
  const project = await tx.project.findUnique({ where: { id: input.projectId }, select: { workspaceId: true } });
  if (!project) return 0;
  await lockGenerationUsage(tx, project.workspaceId);
  const failed = await tx.clipDub.findMany({
    where: {
      projectId: input.projectId,
      workflowAttemptId: input.attemptId,
      status: input.includeProcessing ? { in: ["processing", "failed"] } : "failed",
    },
    select: { id: true },
  });
  return releaseGenerationUsage(tx, { kind: "dub", jobIds: failed.map((dub) => dub.id), reason: input.reason });
}

export function createPrismaGenerationUsageLedger(): GenerationUsageLedger {
  return {
    async reserve(input) {
      return requirePrisma().$transaction((tx) =>
        reserveGenerationUsage(tx, {
          kind: input.kind,
          jobId: input.jobId,
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          pricingTier: input.pricingTier,
          now: new Date(),
          attached: false,
        }),
      );
    },

    async finalize(input) {
      await requirePrisma().$transaction((tx) =>
        finalizeGenerationUsage(tx, {
          kind: input.kind,
          jobId: input.jobId,
          reservationId: input.reservationId,
          units: input.kind === "image" ? input.images : 1,
        }),
      );
    },

    async release(input) {
      const prisma = requirePrisma();
      const result = await prisma.generatedMediaUsageReservation.updateMany({
        where: { id: input.reservationId, jobId: input.jobId, kind: "image", status: "reserved" },
        data: { status: "released", reason: input.reason, settledAt: new Date() },
      });
      if (result.count === 1) return;
      const existing = await prisma.generatedMediaUsageReservation.findUnique({
        where: { id: input.reservationId },
        select: { jobId: true, status: true },
      });
      if (existing?.jobId === input.jobId && existing.status === "released") return;
      throw new GeneratedMediaJobError("generated_media_usage_reconciliation_required");
    },
  };
}

export interface GenerationAllowanceSummary {
  /** `lifetime` is the Free sample; `month` renews at `renewsAt` (00:00 UTC on the 1st). */
  period: "lifetime" | "month";
  periodStart: string | null;
  renewsAt: string | null;
  limit: number;
  used: number;
  reserved: number;
  finalized: number;
  remaining: number;
}

export interface GenerationUsageSummary {
  images: GenerationAllowanceSummary & {
    entitled: boolean;
    policy: GenerationUsagePolicy;
    concurrency: { limit: number; active: number };
  };
  dubs: GenerationAllowanceSummary & { entitled: boolean; maxClipSeconds: number };
}

export type GeneratedImageUsageSummary = GenerationUsageSummary["images"];
export type DubUsageSummary = GenerationUsageSummary["dubs"];

/** The Workspace's image and dub allowances for its current plan and UTC period. */
export async function summarizeGenerationUsage(
  workspaceId: string,
  now = new Date(),
): Promise<GenerationUsageSummary> {
  const prisma = requirePrisma();
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { pricingTier: true },
  });
  const tier = resolvePricingTier(workspace.pricingTier);
  const limits = planLimits(tier);
  const periodStart = processingPeriodStart(now);
  const renewsAt = processingPeriodEnd(periodStart).toISOString();
  const imagePolicy = generatedImagePolicy(tier);
  const statusCounts = async (where: Prisma.GeneratedMediaUsageReservationWhereInput) => {
    const groups = await prisma.generatedMediaUsageReservation.groupBy({
      by: ["status"],
      where,
      _count: { _all: true },
    });
    const of = (status: string) => groups.find((group) => group.status === status)?._count._all ?? 0;
    return { reserved: of("reserved"), finalized: of("finalized") };
  };
  const [images, dubs, activeImages] = await Promise.all([
    statusCounts(countWhere({ kind: "image", workspaceId, policy: imagePolicy, periodStart })),
    statusCounts(countWhere({ kind: "dub", workspaceId, policy: "metered", periodStart })),
    prisma.generatedMediaUsageReservation.count({ where: { workspaceId, kind: "image", status: "reserved" } }),
  ]);
  const allowance = (limit: number, counts: { reserved: number; finalized: number }, lifetime: boolean) => ({
    period: lifetime ? ("lifetime" as const) : ("month" as const),
    periodStart: lifetime ? null : periodStart.toISOString(),
    renewsAt: lifetime ? null : renewsAt,
    limit,
    used: counts.reserved + counts.finalized,
    reserved: counts.reserved,
    finalized: counts.finalized,
    remaining: Math.max(0, limit - counts.reserved - counts.finalized),
  });
  return {
    images: {
      ...allowance(limits.generatedImages.count, images, limits.generatedImages.period === "lifetime"),
      entitled: hasFeature(tier, "generated.images"),
      policy: imagePolicy,
      concurrency: { limit: limits.generatedImages.concurrency, active: activeImages },
    },
    dubs: {
      ...allowance(limits.dubs.perMonth, dubs, false),
      entitled: hasFeature(tier, "dubbing"),
      maxClipSeconds: limits.dubs.maxClipSeconds,
    },
  };
}

const LIVE_RUN = ["queued", "running", "waiting"] as const;

type SweepOutcome = { action: "released" | "finalized"; reason: string } | null;

async function settleCandidate(
  tx: Tx,
  candidate: { id: string; jobId: string; kind: GenerationUsageKind; attachedAt: Date | null },
): Promise<SweepOutcome> {
  if (candidate.kind === "image") {
    const job = await tx.generatedMediaJob.findUnique({ where: { id: candidate.jobId }, select: { id: true } });
    // A live job owns its reservation, including unknown provider outcomes
    // waiting for operator reconciliation.
    if (job) return null;
    return candidate.attachedAt
      ? { action: "finalized", reason: "generation_subject_deleted" }
      : { action: "released", reason: "generated_media_admission_orphan_reconciled" };
  }
  const dub = await tx.clipDub.findUnique({
    where: { id: candidate.jobId },
    select: { status: true, projectId: true, errorCode: true },
  });
  // The dub was deleted with its Clip or Project while counted. Provider work
  // may have run, so the count is kept rather than refunded.
  if (!dub) return { action: "finalized", reason: "generation_subject_deleted" };
  if (dub.status === "completed") return { action: "finalized", reason: "dub_completed_reconciled" };
  if (dub.status !== "failed") return null;
  // A failed dub under a live run may still be requeued by its retry.
  const liveRun = await tx.workflowRun.findFirst({
    where: { projectId: dub.projectId, stage: "dubbing", status: { in: [...LIVE_RUN] } },
    select: { id: true },
  });
  if (liveRun) return null;
  return { action: "released", reason: dub.errorCode ?? "dub_failed" };
}

/**
 * Settles reservations the request paths could not: image admissions that
 * crashed before their job existed, dubs whose terminal failure was not yet
 * released, and subjects deleted while counted (kept as used). Queued,
 * running, and waiting requests are never touched, however old.
 */
export async function reconcileGenerationUsageReservations(now = new Date(), graceMs = 10 * 60_000) {
  const prisma = requirePrisma();
  const cutoff = new Date(now.getTime() - Math.max(60_000, graceMs));
  let settled = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const candidates = await prisma.generatedMediaUsageReservation.findMany({
      where: { status: "reserved", createdAt: { lt: cutoff } },
      select: { id: true, jobId: true, kind: true, workspaceId: true, attachedAt: true },
      orderBy: { id: "asc" },
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (candidates.length === 0) break;
    cursor = candidates.at(-1)!.id;
    for (const candidate of candidates) {
      const outcome = await prisma.$transaction(async (tx) => {
        await lockGenerationUsage(tx, candidate.workspaceId);
        const decision = await settleCandidate(tx, candidate);
        if (!decision) return null;
        const result = await tx.generatedMediaUsageReservation.updateMany({
          where: { id: candidate.id, status: "reserved" },
          data: {
            status: decision.action,
            reason: decision.reason,
            settledAt: now,
            ...(decision.action === "finalized" ? { actualUnits: candidate.kind === "dub" ? 1 : null } : {}),
          },
        });
        return result.count === 1 ? decision : null;
      });
      if (!outcome) continue;
      settled += 1;
      console.warn(JSON.stringify({
        level: "info",
        message: "generation_usage_reconciled",
        reservationId: candidate.id,
        jobId: candidate.jobId,
        kind: candidate.kind,
        workspaceId: candidate.workspaceId,
        action: outcome.action,
        reason: outcome.reason,
      }));
    }
    if (candidates.length < 100) break;
  }
  return settled;
}
