import { getPrismaClient } from "@narriflow/db/client";
import {
  PROCESSING_CAPACITY_DEFAULTS,
  pricingTierSchema,
  type PricingTier,
} from "@narriflow/validators";
import { ProcessingUsage } from "./processing-usage";

/** Validated Processing Capacity per tier, overridable with
 * PROCESSING_CAPACITY_FREE, _CREATOR, _PRO, and _BUSINESS. */
export function processingCapacityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Readonly<Record<PricingTier, number>> {
  const limits = { ...PROCESSING_CAPACITY_DEFAULTS };
  for (const tier of pricingTierSchema.options) {
    const name = `PROCESSING_CAPACITY_${tier.toUpperCase()}`;
    const raw = env[name]?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000)
      throw new Error(`${name} must be an integer from 1 through 1000.`);
    limits[tier] = value;
  }
  return Object.freeze(limits);
}

let runtime: { prisma: object; usage: ProcessingUsage } | undefined;
/** Production Processing Usage bound to the current database client. */
export function getProcessingUsage(): ProcessingUsage {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  if (runtime?.prisma !== prisma) {
    runtime = {
      prisma,
      usage: new ProcessingUsage({
        prisma,
        capacityLimits: processingCapacityFromEnv(),
      }),
    };
  }
  return runtime.usage;
}
