import { resolvePricingTier } from "@narriflow/validators";
import { hasFeature } from "./plan-features";

export type GeneratedMediaKind = "image" | "video";
export type GenerationUsagePolicy = "trial_metered" | "metered";

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
