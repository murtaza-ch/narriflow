import type { Prisma } from "@prisma/client";
import {
  hasFeature,
  lowestTier,
  planCountRequirement,
  planFeatureRequirement,
  PLAN_CATALOG,
  PRICING_TIER_ORDER,
  resolvePricingTier,
  workspaceAllowsCapability,
  type PlanCountLimit,
  type PricingTier,
  type WorkspaceAccessRole,
  type WorkspaceAccessStatus,
} from "@narriflow/validators";
import { PlanRequirementError, type PlanFeature } from "./plan-features";
import { analyticsService } from "./analytics.service";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";

export interface BrandActorScope {
  actorUserId: string;
  workspaceId: string;
  workspaceOwnerUserId: string;
  role: WorkspaceAccessRole;
  status: WorkspaceAccessStatus;
  pricingTier: string;
  isPersonalWorkspace: boolean;
}

const brandAccessFailureCatalog = {
  brand_forbidden: "forbidden",
} as const satisfies ExpectedDomainFailureCatalog<string>;

type BrandAccessFailureCode = keyof typeof brandAccessFailureCatalog;

/** A role refusal. Plan refusals are `PlanRequirementError`. */
export class BrandAccessError extends ExpectedDomainFailureError<BrandAccessFailureCode> {
  constructor(code: BrandAccessFailureCode) {
    super({
      code,
      kind: brandAccessFailureCatalog[code],
      message: "Brand management is not allowed",
    });
    this.name = "BrandAccessError";
  }
}

export type BrandOwner =
  | { userId: string; workspaceId: null }
  | { userId: null; workspaceId: string };

/**
 * Who owns branding is a property of the Workspace kind, never of its plan:
 * a personal Workspace's branding belongs to its owner, and a collaborative
 * Workspace's branding belongs to the Workspace. A plan change therefore never
 * changes which profiles, fonts, or assets a Workspace sees.
 */
export function brandOwnerForWorkspace(workspace: {
  id: string;
  personalOwnerUserId: string | null;
}): BrandOwner {
  return workspace.personalOwnerUserId
    ? { userId: workspace.personalOwnerUserId, workspaceId: null }
    : { userId: null, workspaceId: workspace.id };
}

export function resolveBrandOwner(
  scope: Pick<BrandActorScope, "workspaceId" | "workspaceOwnerUserId" | "isPersonalWorkspace">,
): BrandOwner {
  return brandOwnerForWorkspace({
    id: scope.workspaceId,
    personalOwnerUserId: scope.isPersonalWorkspace ? scope.workspaceOwnerUserId : null,
  });
}

/** The row filter for an owner's branding objects. */
export function brandOwnerWhereFor(owner: BrandOwner): { workspaceId: string } | { userId: string } {
  return owner.workspaceId ? { workspaceId: owner.workspaceId } : { userId: owner.userId! };
}

export function brandOwnerWhere(
  scope: Pick<BrandActorScope, "workspaceId" | "workspaceOwnerUserId" | "isPersonalWorkspace">,
) {
  return brandOwnerWhereFor(resolveBrandOwner(scope));
}

export function brandOwnerStoragePrefix(
  scope: Pick<BrandActorScope, "workspaceId" | "workspaceOwnerUserId" | "isPersonalWorkspace">,
  collection: "visual-assets" | "brand-fonts",
): string {
  const owner = resolveBrandOwner(scope);
  return owner.workspaceId
    ? `workspaces/${owner.workspaceId}/${collection}/`
    : `${collection}/${owner.userId}/`;
}

/** Serializes count-limited creation for one owner and collection inside `tx`. */
export async function lockBrandOwner(
  tx: Prisma.TransactionClient,
  collection: "brand-profiles" | "brand-templates",
  owner: { userId: string | null; workspaceId: string | null },
): Promise<void> {
  const key = `${collection}:${owner.workspaceId ? `workspace:${owner.workspaceId}` : `user:${owner.userId}`}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"`;
}

/** Role-only check for cleanup (delete, unlink, disable), which stays possible
 * on every plan and over every limit. */
export function assertBrandManageAllowed(
  scope: Pick<BrandActorScope, "role" | "status">,
): void {
  if (!workspaceAllowsCapability({ role: scope.role, status: scope.status }, "brand.manage")) {
    throw new BrandAccessError("brand_forbidden");
  }
}

export interface BrandPlanRequirement {
  requiredTier: PricingTier | null;
  message: string;
}

/**
 * Why this Workspace's plan can't use a branding `feature`, or `null` when it
 * can. Branding in a collaborative Workspace is part of team collaboration, so
 * there the plan needs the feature and `workspace.members`. The service refusal
 * and every upgrade prompt read this one policy, so an offered tier always
 * unlocks the action.
 */
export function brandPlanRequirement(
  scope: Pick<BrandActorScope, "pricingTier" | "isPersonalWorkspace">,
  feature: PlanFeature,
): BrandPlanRequirement | null {
  if (scope.isPersonalWorkspace) return planFeatureRequirement(scope.pricingTier, feature);
  if (hasFeature(scope.pricingTier, feature) && hasFeature(scope.pricingTier, "workspace.members")) {
    return null;
  }
  const requiredTier = lowestTier((plan) => plan.features[feature] && plan.features["workspace.members"]);
  return {
    requiredTier,
    message: requiredTier
      ? `Branding in a shared Workspace needs the ${PLAN_CATALOG[requiredTier].name} plan.`
      : "Branding in a shared Workspace is not available on any plan.",
  };
}

/**
 * `brandPlanRequirement` combined with a count limit: the tier to offer is the
 * higher of the two requirements, or `null` when none qualifies, so a count
 * upgrade never lands below the Workspace requirement.
 */
export function brandCountRequirement(
  scope: Pick<BrandActorScope, "pricingTier" | "isPersonalWorkspace">,
  feature: PlanFeature,
  limit: PlanCountLimit,
  used: number,
  adding = 1,
): BrandPlanRequirement | null {
  const scopeRequirement = brandPlanRequirement(scope, feature);
  const count = planCountRequirement(scope.pricingTier, limit, used, adding);
  if (!scopeRequirement || !count) return scopeRequirement ?? count;
  if (!scopeRequirement.requiredTier) return scopeRequirement;
  const { requiredTier, message } = count;
  if (!requiredTier) return { requiredTier, message };
  return PRICING_TIER_ORDER.indexOf(requiredTier) > PRICING_TIER_ORDER.indexOf(scopeRequirement.requiredTier)
    ? { requiredTier, message }
    : scopeRequirement;
}

function requireBrandPlan(scope: BrandActorScope, feature: PlanFeature): void {
  const requirement = brandPlanRequirement(scope, feature);
  if (!requirement) return;
  throw new PlanRequirementError({
    code: "plan_feature_required",
    message: requirement.message,
    currentTier: resolvePricingTier(scope.pricingTier),
    requiredTier: requirement.requiredTier,
    feature,
  });
}

export function assertBrandMutationAllowed(
  scope: BrandActorScope,
  feature: PlanFeature,
): void {
  assertBrandManageAllowed(scope);
  requireBrandPlan(scope, feature);
}

export async function assertBrandMutationAllowedWithAnalytics(
  scope: BrandActorScope,
  feature: PlanFeature,
  assetKind: "profile" | "font" | "scene",
): Promise<void> {
  try {
    assertBrandMutationAllowed(scope, feature);
  } catch (error) {
    if (error instanceof PlanRequirementError) {
      await analyticsService.recordBrandProgramEventBestEffort({
        type: "brand_premium_mutation_blocked",
        workspaceId: scope.workspaceId,
        actorUserId: scope.actorUserId,
        metadata: {
          assetKind,
          planTier: resolvePricingTier(scope.pricingTier),
          outcome: "blocked",
        },
      });
    }
    throw error;
  }
}

export function assertBrandApplicationAllowed(scope: BrandActorScope): void {
  if (
    !workspaceAllowsCapability(
      { role: scope.role, status: scope.status },
      "content.edit",
    )
  ) {
    throw new BrandAccessError("brand_forbidden");
  }
  requireBrandPlan(scope, "brand.profiles");
}

/** A refusal to apply branding: the actor's role, or a plan without the
 * brand feature. Callers that pause automation on brand problems use it. */
export function isBrandAccessRefusal(error: unknown): boolean {
  return (
    error instanceof BrandAccessError ||
    (error instanceof PlanRequirementError &&
      typeof error.details?.feature === "string" &&
      error.details.feature.startsWith("brand."))
  );
}
