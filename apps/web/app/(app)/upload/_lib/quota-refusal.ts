import { PLAN_CATALOG, PRICING_TIER_ORDER, type PlanDefinition, type PricingTier } from "@narriflow/validators";

export interface QuotaRefusalRecovery {
  /** Why the import stopped, true for the current plan. */
  message: string;
  /** Set when some higher plan raises the limit that stopped it. */
  higherPlanNote: string | null;
}

function higherPlanRaises(tier: PricingTier, raises: (plan: PlanDefinition, current: PlanDefinition) => boolean): boolean {
  const current = PLAN_CATALOG[tier];
  return PRICING_TIER_ORDER.slice(PRICING_TIER_ORDER.indexOf(tier) + 1).some((next) => raises(PLAN_CATALOG[next], current));
}

/**
 * Copy for an import Processing Usage refused for credits or length when only
 * the failure code survives (a failed ingest). Without the video's duration no
 * single plan can be promised, so the note only says whether any higher plan
 * raises the limit; at the top of that limit it names the real next step.
 */
export function quotaRefusalRecovery(tier: PricingTier, code: string | null): QuotaRefusalRecovery | null {
  if (code === "credits_exhausted") {
    const raised = higherPlanRaises(tier, (plan, current) => plan.limits.monthlyCredits > current.limits.monthlyCredits);
    return {
      message: "This video needs more credits than your workspace has left this month. Credits renew on the 1st (UTC); retry the import then.",
      higherPlanNote: raised ? "Higher plans include more credits." : null,
    };
  }
  if (code === "upload_too_long") {
    const raised = higherPlanRaises(tier, (plan, current) => plan.limits.maxSourceSeconds > current.limits.maxSourceSeconds);
    return {
      message: `This video is longer than the ${PLAN_CATALOG[tier].name} plan allows per video. Upload a shorter video${raised ? " or change plan" : ""}.`,
      higherPlanNote: raised ? "Higher plans allow longer videos." : null,
    };
  }
  return null;
}
