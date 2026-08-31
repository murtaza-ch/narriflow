import { resolvePricingTier } from "@narriflow/validators";
import { hasFeature } from "./plan-features";

export type GeneratedMediaKind = "image" | "video";
export type GenerationUsagePolicy = "trial_metered" | "metered";

export type GenerationUsageQuotaWindow = {
  period: "lifetime" | "calendar_day_utc";
  limitUnits: number;
  startsAt: Date | null;
  endsAt: Date | null;
};

export type GenerationUsageWindow = {
  policy: GenerationUsagePolicy;
  allowance: GenerationUsageQuotaWindow;
  dailyAbuse: GenerationUsageQuotaWindow & { period: "calendar_day_utc" };
};

export type GenerationUsageAvailability = {
  policy: GenerationUsagePolicy;
  allowance: {
    period: GenerationUsageQuotaWindow["period"];
    limitUnits: number;
    committedUnits: number;
    availableUnits: number;
    resetsAt: string | null;
  };
  dailyAbuse: {
    limitUnits: number;
    admittedUnits: number;
    availableUnits: number;
    resetsAt: string;
  };
  settlement: {
    reservedUnits: number;
    finalizedUnits: number;
    releasedUnits: number;
  };
};

export type GenerationUsageSummary = Record<
  GeneratedMediaKind,
  GenerationUsageAvailability
>;

export const DEFAULT_GENERATION_DAILY_LIMIT_UNITS: Readonly<
  Record<GeneratedMediaKind, number>
> = {
  image: 20,
  video: 60,
};

export const DEFAULT_GENERATION_DAILY_ABUSE_LIMIT_UNITS: Readonly<
  Record<GeneratedMediaKind, number>
> = {
  image: 40,
  video: 120,
};

export function generationAccessForTier(
  tier: string | null | undefined,
  kind: GeneratedMediaKind,
): { entitled: boolean; usage: GenerationUsagePolicy } {
  const resolvedTier = resolvePricingTier(tier);
  return {
    entitled: hasFeature(
      resolvedTier,
      kind === "image" ? "generated.images" : "generated.video",
    ),
    usage: resolvedTier === "free" && kind === "image" ? "trial_metered" : "metered",
  };
}

export function generationUsageWindow(input: {
  tier: string | null | undefined;
  kind: GeneratedMediaKind;
  usageUnits: number;
  dailyLimitUnits?: number;
  dailyAbuseLimitUnits?: number;
  now: Date;
}): GenerationUsageWindow {
  const access = generationAccessForTier(input.tier, input.kind);
  const startsAt = new Date(input.now);
  startsAt.setUTCHours(0, 0, 0, 0);
  const endsAt = new Date(startsAt.getTime() + 24 * 60 * 60 * 1000);
  return {
    policy: access.usage,
    allowance:
      access.usage === "trial_metered"
        ? {
            period: "lifetime",
            limitUnits: input.usageUnits,
            startsAt: null,
            endsAt: null,
          }
        : {
            period: "calendar_day_utc",
            limitUnits:
              input.dailyLimitUnits ?? DEFAULT_GENERATION_DAILY_LIMIT_UNITS[input.kind],
            startsAt,
            endsAt,
          },
    dailyAbuse: {
      period: "calendar_day_utc",
      limitUnits:
        input.dailyAbuseLimitUnits ??
        DEFAULT_GENERATION_DAILY_ABUSE_LIMIT_UNITS[input.kind],
      startsAt,
      endsAt,
    },
  };
}

export function generationUsageAvailability(
  window: GenerationUsageWindow,
  totals: {
    admittedUnits: number;
    committedUnits: number;
    reservedUnits: number;
    finalizedUnits: number;
    releasedUnits: number;
  },
): GenerationUsageAvailability {
  return {
    policy: window.policy,
    allowance: {
      period: window.allowance.period,
      limitUnits: window.allowance.limitUnits,
      committedUnits: totals.committedUnits,
      availableUnits: Math.max(
        0,
        window.allowance.limitUnits - totals.committedUnits,
      ),
      resetsAt: window.allowance.endsAt?.toISOString() ?? null,
    },
    dailyAbuse: {
      limitUnits: window.dailyAbuse.limitUnits,
      admittedUnits: totals.admittedUnits,
      availableUnits: Math.max(
        0,
        window.dailyAbuse.limitUnits - totals.admittedUnits,
      ),
      resetsAt: window.dailyAbuse.endsAt!.toISOString(),
    },
    settlement: {
      reservedUnits: totals.reservedUnits,
      finalizedUnits: totals.finalizedUnits,
      releasedUnits: totals.releasedUnits,
    },
  };
}
