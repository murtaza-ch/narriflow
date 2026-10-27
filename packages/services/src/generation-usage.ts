import { planLimits, resolvePricingTier } from "@narriflow/validators";
import { hasFeature } from "./plan-features";
import type { BrandActorScope } from "./brand-ownership";
import { GeneratedMediaProviderError } from "./generated-media";
import {
  GeneratedMediaPromptProtectionError,
  generatedMediaPromptProtectionFromEnv,
} from "./generated-media-prompt-protection";
import { openAiImageProviderFromEnv } from "./openai-image-provider";

/** `trial_metered` is Free's lifetime image sample; `metered` is a UTC-month allowance. */
export type GenerationUsagePolicy = "trial_metered" | "metered";

export function generatedImagePolicy(tier: string | null | undefined): GenerationUsagePolicy {
  return planLimits(resolvePricingTier(tier)).generatedImages.period === "lifetime"
    ? "trial_metered"
    : "metered";
}

export type GeneratedImageCapability = {
  available: boolean;
  reason: "available" | "entitlement_required" | "provider_unavailable";
  usage: GenerationUsagePolicy;
};

/**
 * Whether this process can build the image provider and prompt protection
 * that generation needs. Missing or malformed settings make generation
 * temporarily unavailable rather than failing each request.
 */
export function generatedImageProviderConfigured(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  try {
    openAiImageProviderFromEnv(environment);
    generatedMediaPromptProtectionFromEnv(environment);
    return true;
  } catch (error) {
    if (error instanceof GeneratedMediaProviderError || error instanceof GeneratedMediaPromptProtectionError) {
      return false;
    }
    throw error;
  }
}

/** One policy seam shared by admission and Studio's server-rendered capability. */
export function generatedImageCapability(
  scope: BrandActorScope,
  environment: Record<string, string | undefined> = process.env,
): GeneratedImageCapability {
  const usage = generatedImagePolicy(scope.pricingTier);
  if (!hasFeature(scope.pricingTier, "generated.images")) {
    return { available: false, reason: "entitlement_required", usage };
  }
  if (!generatedImageProviderConfigured(environment)) {
    return { available: false, reason: "provider_unavailable", usage };
  }
  return { available: true, reason: "available", usage };
}
