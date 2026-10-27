import {
  PRICING_TIER_ORDER,
  lowestTier,
  planFeatureRequirement,
  planLimits,
  planUpgradeHighlight,
  resolvePricingTier,
  type PlanFeature,
  type PricingTier,
} from "@narriflow/validators";
import type { UpgradePrompt } from "@/app/(app)/_components/upgrade";

/**
 * The upgrade dialog's content for each Studio tool the plan locks. A null
 * entry means the tool is available, or that no purchasable plan would unlock
 * it. Derived on the server from the catalog; the browser only opens it.
 */
export interface StudioUpgradePrompts {
  export1080p: UpgradePrompt | null;
  watermark: UpgradePrompt | null;
  motion: UpgradePrompt | null;
  scenes: UpgradePrompt | null;
  censoring: UpgradePrompt | null;
}

export const NO_STUDIO_UPGRADE_PROMPTS: StudioUpgradePrompts = {
  export1080p: null,
  watermark: null,
  motion: null,
  scenes: null,
  censoring: null,
};

function featurePrompt(
  requirement: { requiredTier: PricingTier | null } | null,
  feature: PlanFeature,
  headline: string,
): UpgradePrompt | null {
  if (!requirement?.requiredTier) return null;
  return {
    tier: requirement.requiredTier,
    headline,
    highlight: planUpgradeHighlight(requirement.requiredTier, feature),
  };
}

/**
 * The cheapest paid tier whose monthly image allowance has room for one more
 * after `used`, or null when none does. Mirrors the generation ledger's
 * refusal tier: only monthly allowances can be bought, so Free's lifetime
 * sample is never a candidate. `used` must be this month's images under any
 * policy (the summary's `monthUsed`), since that is what a monthly plan counts.
 */
export function generatedImagesUpgradePrompt(tier: string | null | undefined, used: number): UpgradePrompt | null {
  const current = resolvePricingTier(tier);
  const next = lowestTier((plan) => plan.limits.generatedImages.period === "month" && plan.limits.generatedImages.count > used);
  if (!next || PRICING_TIER_ORDER.indexOf(next) <= PRICING_TIER_ORDER.indexOf(current)) return null;
  const allowance = planLimits(next).generatedImages;
  return {
    tier: next,
    headline: "Upgrade to create more AI images",
    highlight: `${allowance.count} AI images / month`,
  };
}

/**
 * `scenesRequirement` comes from the brand scope policy (a shared Workspace
 * needs more than the feature alone), so the offered tier always unlocks it.
 */
export function studioUpgradePrompts(
  tier: string | null | undefined,
  scenesRequirement: { requiredTier: PricingTier | null } | null,
): StudioUpgradePrompts {
  return {
    export1080p: featurePrompt(planFeatureRequirement(tier, "export.1080p"), "export.1080p", "Upgrade to export in 1080p"),
    watermark: featurePrompt(planFeatureRequirement(tier, "export.noWatermark"), "export.noWatermark", "Upgrade to remove the watermark"),
    motion: featurePrompt(planFeatureRequirement(tier, "editor.motion"), "editor.motion", "Upgrade to save and export motion"),
    scenes: featurePrompt(scenesRequirement, "brand.scenes", "Upgrade to add scenes"),
    censoring: featurePrompt(planFeatureRequirement(tier, "editor.censoring"), "editor.censoring", "Upgrade to apply Auto Censor"),
  };
}

/** What a click on a resolution choice does: only an entitled 1080p is selectable. */
export function resolutionAction(value: "720p" | "1080p", can1080pExport: boolean): "select" | "upgrade" {
  return value === "1080p" && !can1080pExport ? "upgrade" : "select";
}

/**
 * Why Generate is disabled once the allowance is spent. Free's sample is
 * lifetime and never renews; a paid month renews at `renewsAt`. `upgrade` is
 * true only when a higher tier has more images to offer.
 */
export function generatedImagesExhaustedCopy(
  usage: { period: "lifetime" | "month"; renewsAt: string | null },
  prompt: UpgradePrompt | null,
): { message: string; upgrade: boolean } {
  const upgrade = Boolean(prompt?.tier);
  if (usage.period === "lifetime") {
    return { message: "You've used your free AI image sample.", upgrade };
  }
  const renews = usage.renewsAt
    ? new Date(usage.renewsAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    : null;
  return {
    message: renews ? `You've used this month's AI images. They renew on ${renews}.` : "You've used this month's AI images.",
    upgrade,
  };
}
