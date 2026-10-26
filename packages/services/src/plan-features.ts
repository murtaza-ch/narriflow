import {
  planCountRequirement,
  planFeatureRequirement,
  resolvePricingTier,
  type PlanCountLimit,
  type PlanFeature,
  type PlanLimits,
  type PricingTier,
} from "@narriflow/validators";
import { ExpectedDomainFailureError } from "./expected-domain-failure";

export { hasFeature, planLimits, type PlanCountLimit, type PlanFeature } from "@narriflow/validators";

export type PlanRequirementCode = "plan_feature_required" | "plan_limit_reached";

/**
 * The one refusal every surface uses when the Workspace's plan is the reason.
 * `requiredTier` is the cheapest tier that would allow the action, or `null`
 * when no plan does (for example a full monthly allowance on the top tier).
 */
export class PlanRequirementError extends ExpectedDomainFailureError<
  PlanRequirementCode,
  {
    feature?: PlanFeature;
    limit?: PlanCountLimit | "generatedImages" | "dubs";
    used?: number;
    max?: number;
    currentTier: PricingTier;
    requiredTier: PricingTier | null;
  }
> {
  constructor(input: {
    code: PlanRequirementCode;
    message: string;
    currentTier: PricingTier;
    requiredTier: PricingTier | null;
    feature?: PlanFeature;
    limit?: PlanCountLimit | "generatedImages" | "dubs";
    used?: number;
    max?: number;
  }) {
    super({
      code: input.code,
      kind: "payment_required",
      message: input.message,
      details: {
        currentTier: input.currentTier,
        requiredTier: input.requiredTier,
        ...(input.feature ? { feature: input.feature } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
        ...(input.used === undefined ? {} : { used: input.used }),
        ...(input.max === undefined ? {} : { max: input.max }),
      },
    });
    this.name = "PlanRequirementError";
  }
}


/** Throws `plan_feature_required` unless the tier includes `feature`. */
export function requirePlanFeature(
  tier: string | null | undefined,
  feature: PlanFeature,
): void {
  const requirement = planFeatureRequirement(tier, feature);
  if (!requirement) return;
  throw new PlanRequirementError({
    code: "plan_feature_required",
    message: requirement.message,
    currentTier: resolvePricingTier(tier),
    requiredTier: requirement.requiredTier,
    feature,
  });
}

/**
 * Throws `plan_limit_reached` when adding `adding` more objects would exceed
 * the tier's count limit. Call it inside the transaction that writes the object,
 * after serializing on the owner, with `used` counted in that transaction.
 */
export function requireWithinPlanLimit(
  tier: string | null | undefined,
  limit: PlanCountLimit,
  used: number,
  adding = 1,
): void {
  const requirement = planCountRequirement(tier, limit, used, adding);
  if (!requirement) return;
  const { code, message, requiredTier, max } = requirement;
  throw new PlanRequirementError({
    code,
    message,
    currentTier: resolvePricingTier(tier),
    requiredTier,
    limit,
    used,
    max,
  });
}

export type { PlanLimits };
