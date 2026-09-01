import {
  resolvePricingTier,
  workspaceAllowsCapability,
  type WorkspaceAccessRole,
  type WorkspaceAccessStatus,
} from "@narriflow/validators";
import { hasFeature, type PlanFeature } from "./plan-features";
import { analyticsService } from "./analytics.service";

export interface BrandActorScope {
  actorUserId: string;
  workspaceId: string;
  workspaceOwnerUserId: string;
  role: WorkspaceAccessRole;
  status: WorkspaceAccessStatus;
  pricingTier: string;
  isPersonalWorkspace: boolean;
}

export class BrandAccessError extends Error {
  readonly code: "brand_forbidden" | "brand_entitlement_required";

  constructor(code: BrandAccessError["code"]) {
    super(code === "brand_forbidden" ? "Brand management is not allowed" : "This plan does not include that brand capability");
    this.name = "BrandAccessError";
    this.code = code;
  }
}

export function resolveBrandOwner(scope: BrandActorScope): {
  userId: string | null;
  workspaceId: string | null;
} {
  return scope.isPersonalWorkspace && scope.pricingTier !== "business"
    ? { userId: scope.workspaceOwnerUserId, workspaceId: null }
    : { userId: null, workspaceId: scope.workspaceId };
}

export function brandOwnerWhere(scope: BrandActorScope) {
  const owner = resolveBrandOwner(scope);
  return owner.workspaceId ? { workspaceId: owner.workspaceId } : { userId: owner.userId! };
}

export function brandOwnerStoragePrefix(
  scope: BrandActorScope,
  collection: "visual-assets" | "brand-fonts",
): string {
  const owner = resolveBrandOwner(scope);
  return owner.workspaceId
    ? `workspaces/${owner.workspaceId}/${collection}/`
    : `${collection}/${owner.userId}/`;
}

export function assertBrandMutationAllowed(
  scope: BrandActorScope,
  feature: PlanFeature,
): void {
  if (!workspaceAllowsCapability({ role: scope.role, status: scope.status }, "brand.manage")) {
    throw new BrandAccessError("brand_forbidden");
  }
  if (!hasFeature(scope.pricingTier, feature)) {
    throw new BrandAccessError("brand_entitlement_required");
  }
  if (
    !scope.isPersonalWorkspace &&
    resolvePricingTier(scope.pricingTier) !== "business"
  ) {
    throw new BrandAccessError("brand_entitlement_required");
  }
}

export async function assertBrandMutationAllowedWithAnalytics(
  scope: BrandActorScope,
  feature: PlanFeature,
  assetKind: "profile" | "font" | "scene",
): Promise<void> {
  try {
    assertBrandMutationAllowed(scope, feature);
  } catch (error) {
    if (error instanceof BrandAccessError) {
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
  if (!hasFeature(scope.pricingTier, "brand.profiles")) {
    throw new BrandAccessError("brand_entitlement_required");
  }
  if (
    !scope.isPersonalWorkspace &&
    resolvePricingTier(scope.pricingTier) !== "business"
  ) {
    throw new BrandAccessError("brand_entitlement_required");
  }
}
