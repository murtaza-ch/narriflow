import { getPrismaClient } from "@narriflow/db/client";
import { resolvePricingTier } from "@narriflow/validators";
import {
  GeneratedMediaJobError,
  type GenerationUsageLedger,
} from "./generated-media";
import { withSerializableTransaction } from "./serializable-transaction";

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function limitsForTier(tier: string, environment: NodeJS.ProcessEnv) {
  const resolved = resolvePricingTier(tier);
  if (resolved === "free") {
    return {
      daily: positiveInteger(environment.GENERATED_IMAGE_FREE_TRIAL_LIMIT, 1),
      concurrent: positiveInteger(environment.GENERATED_IMAGE_FREE_CONCURRENCY, 1),
    };
  }
  if (resolved === "creator") {
    return {
      daily: positiveInteger(environment.GENERATED_IMAGE_CREATOR_DAILY_LIMIT, 50),
      concurrent: positiveInteger(environment.GENERATED_IMAGE_CREATOR_CONCURRENCY, 2),
    };
  }
  return {
    daily: positiveInteger(environment.GENERATED_IMAGE_PRO_DAILY_LIMIT, 200),
    concurrent: positiveInteger(environment.GENERATED_IMAGE_PRO_CONCURRENCY, 4),
  };
}

export interface GeneratedImageUsageSummary {
  policy: "trial_metered" | "metered";
  dailyLimit: number;
  reserved: number;
  finalized: number;
  remaining: number;
  trial: { consumed: boolean } | null;
}

export async function getGeneratedImageUsageSummary(
  workspaceId: string,
  pricingTier: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<GeneratedImageUsageSummary> {
  const tier = resolvePricingTier(pricingTier);
  const policy = tier === "free" ? "trial_metered" as const : "metered" as const;
  const limits = limitsForTier(tier, environment);
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const where = {
    workspaceId,
    ...(policy === "trial_metered" ? {} : { createdAt: { gte: dayStart } }),
  };
  const [reserved, finalized] = await Promise.all([
    requirePrisma().generatedMediaUsageReservation.count({ where: { ...where, status: "reserved" } }),
    requirePrisma().generatedMediaUsageReservation.count({ where: { ...where, status: "finalized" } }),
  ]);
  const used = reserved + finalized;
  return {
    policy,
    dailyLimit: limits.daily,
    reserved,
    finalized,
    remaining: Math.max(0, limits.daily - used),
    trial: policy === "trial_metered" ? { consumed: used > 0 } : null,
  };
}

export function createPrismaGenerationUsageLedger(
  environment: NodeJS.ProcessEnv = process.env,
): GenerationUsageLedger {
  return {
    async reserve(input) {
      const prisma = requirePrisma();
      return withSerializableTransaction(prisma, async (tx) => {
        const existing = await tx.generatedMediaUsageReservation.findUnique({
          where: { jobId: input.jobId },
          select: { id: true },
        });
        if (existing) return { reservationId: existing.id };

        const limits = limitsForTier(input.pricingTier, environment);
        const dayStart = new Date();
        dayStart.setUTCHours(0, 0, 0, 0);
        const [usedInPeriod, active] = await Promise.all([
          tx.generatedMediaUsageReservation.count({
            where: {
              workspaceId: input.workspaceId,
              ...(input.policy === "trial_metered" ? {} : { createdAt: { gte: dayStart } }),
              status: { in: ["reserved", "finalized"] },
            },
          }),
          tx.generatedMediaUsageReservation.count({
            where: { workspaceId: input.workspaceId, status: "reserved" },
          }),
        ]);
        if (usedInPeriod >= limits.daily) {
          throw new GeneratedMediaJobError(
            input.policy === "trial_metered"
              ? "generated_media_trial_limit_reached"
              : "generated_media_daily_limit_reached",
          );
        }
        if (active >= limits.concurrent) {
          throw new GeneratedMediaJobError("generated_media_concurrency_limit_reached");
        }
        const reservation = await tx.generatedMediaUsageReservation.create({
          data: {
            jobId: input.jobId,
            workspaceId: input.workspaceId,
            actorUserId: input.actorUserId,
            policy: input.policy,
          },
          select: { id: true },
        });
        return { reservationId: reservation.id };
      });
    },

    async finalize(input) {
      const prisma = requirePrisma();
      const result = await prisma.generatedMediaUsageReservation.updateMany({
        where: { id: input.reservationId, jobId: input.jobId, status: "reserved" },
        data: { status: "finalized", actualUnits: input.images, settledAt: new Date() },
      });
      if (result.count === 1) return;
      const existing = await prisma.generatedMediaUsageReservation.findUnique({
        where: { id: input.reservationId },
        select: { jobId: true, status: true },
      });
      if (existing?.jobId === input.jobId && existing.status === "finalized") return;
      throw new GeneratedMediaJobError("generated_media_usage_reconciliation_required");
    },

    async release(input) {
      const prisma = requirePrisma();
      const result = await prisma.generatedMediaUsageReservation.updateMany({
        where: { id: input.reservationId, jobId: input.jobId, status: "reserved" },
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

export async function reconcileOrphanGeneratedMediaReservations(
  now = new Date(),
  graceMs = 10 * 60_000,
) {
  const prisma = requirePrisma();
  const candidates = await prisma.generatedMediaUsageReservation.findMany({
    where: {
      status: "reserved",
      createdAt: { lt: new Date(now.getTime() - Math.max(60_000, graceMs)) },
    },
    select: { id: true, jobId: true },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  if (candidates.length === 0) return 0;
  let released = 0;
  for (const candidate of candidates) {
    released += await withSerializableTransaction(prisma, async (tx) => {
      const job = await tx.generatedMediaJob.findUnique({ where: { id: candidate.jobId }, select: { id: true } });
      if (job) return 0;
      return (await tx.generatedMediaUsageReservation.updateMany({
        where: { id: candidate.id, jobId: candidate.jobId, status: "reserved" },
        data: {
          status: "released",
          reason: "generated_media_admission_orphan_reconciled",
          settledAt: now,
        },
      })).count;
    });
  }
  return released;
}
