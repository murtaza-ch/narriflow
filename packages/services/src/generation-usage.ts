import { planLimits, resolvePricingTier } from "@narriflow/validators";
import { hasFeature } from "./plan-features";
import type { BrandActorScope } from "./brand-ownership";
import { isProgramWriteEnabled } from "./program-rollout";

/** `trial_metered` is Free's lifetime image sample; `metered` is a UTC-month allowance. */
export type GenerationUsagePolicy = "trial_metered" | "metered";

export function generatedImagePolicy(tier: string | null | undefined): GenerationUsagePolicy {
  return planLimits(resolvePricingTier(tier)).generatedImages.period === "lifetime"
    ? "trial_metered"
    : "metered";
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
  const usage = generatedImagePolicy(scope.pricingTier);
  if (!hasFeature(scope.pricingTier, "generated.images")) {
    return { available: false, reason: "entitlement_required", usage };
  }
  if (!isProgramWriteEnabled("generated_media", environment)) {
    return { available: false, reason: "rollout_disabled", usage };
  }
  return { available: true, reason: "available", usage };
}
