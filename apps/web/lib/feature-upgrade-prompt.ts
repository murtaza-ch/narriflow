import {
  PRICING_TIER_ORDER,
  hasFeature,
  lowestTier,
  lowestTierWithFeature,
  planLimits,
  planUpgradeHighlight,
  resolvePricingTier,
  type PlanFeature,
} from "@narriflow/validators";
import type { UpgradePrompt } from "@/app/(app)/_components/upgrade";

/**
 * The upgrade dialog's prompt for the first of `features` that `tier` lacks,
 * or `null` when it has them all (or no plan carries the missing one). Derived
 * from the catalog, so the required plan and its lead benefit never drift from
 * what the service refuses with.
 */
export function featureUpgradePrompt(
  tier: string | null | undefined,
  features: PlanFeature | readonly PlanFeature[],
  headline: string,
): UpgradePrompt | null {
  const missing = ([] as readonly PlanFeature[]).concat(features).find((feature) => !hasFeature(tier, feature));
  if (!missing) return null;
  const required = lowestTierWithFeature(missing);
  if (!required) return null;
  return { tier: required, headline, highlight: planUpgradeHighlight(required, missing) };
}

/**
 * The upgrade prompt for an exhausted monthly dub allowance: the cheapest plan
 * whose monthly allowance has room for one more after the `used` dubs already
 * counted this month (the same rule the ledger refuses with), or `null` when
 * none does (the allowance renews instead). Actual usage matters after a
 * downgrade, when it can exceed the current plan's allowance.
 */
export function dubAllowanceUpgradePrompt(tier: string | null | undefined, used: number): UpgradePrompt | null {
  const current = resolvePricingTier(tier);
  const next = lowestTier((plan) => plan.limits.dubs.perMonth > used);
  if (!next || PRICING_TIER_ORDER.indexOf(next) <= PRICING_TIER_ORDER.indexOf(current)) return null;
  return {
    tier: next,
    headline: "Upgrade for more dubs",
    highlight: `${planLimits(next).dubs.perMonth} dubs a month`,
  };
}
