import { resolvePricingTier } from "@narriflow/validators";
import { hasFeature } from "./plan-features";
import type { BrandActorScope } from "./brand-ownership";
import { isProgramWriteEnabled } from "./program-rollout";

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

export type GeneratedImageCapability = {
  available: boolean;
  reason: "available" | "rollout_disabled" | "entitlement_required";
  usage: GenerationUsagePolicy;
};

/** One policy seam shared by admission and Studio's server-rendered capability. */
export function generatedImageCapability(
  scope: BrandActorScope,
  environment: Record<string, string | undefined> = process.env,
): GeneratedImageCapability {
  const access = generationAccessForTier(scope.pricingTier, "image");
  if (!access.entitled) return { available: false, reason: "entitlement_required", usage: access.usage };
  if (!isProgramWriteEnabled("generated_media", environment)) {
    return { available: false, reason: "rollout_disabled", usage: access.usage };
  }
  return { available: true, reason: "available", usage: access.usage };
}
