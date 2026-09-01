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
  reason: "available" | "rollout_disabled" | "trial_disabled" | "tier_not_enabled" | "entitlement_required";
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
  const internalUsers = new Set((environment.GENERATED_IMAGE_INTERNAL_USER_IDS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean));
  if (internalUsers.has(scope.actorUserId)) return { available: true, reason: "available", usage: access.usage };
  const tier = resolvePricingTier(scope.pricingTier);
  if (tier === "free") {
    return environment.GENERATED_IMAGE_FREE_TRIAL_ENABLED === "true"
      ? { available: true, reason: "available", usage: access.usage }
      : { available: false, reason: "trial_disabled", usage: access.usage };
  }
  // Closed by default: release to paid tiers is always an explicit deployment choice.
  const allowedTiers = new Set((environment.GENERATED_IMAGE_ALLOWED_TIERS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean));
  return allowedTiers.has(tier)
    ? { available: true, reason: "available", usage: access.usage }
    : { available: false, reason: "tier_not_enabled", usage: access.usage };
}
