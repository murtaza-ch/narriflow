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

export type BrandOwner =
  | { userId: string; workspaceId: null }
  | { userId: null; workspaceId: string };

export type BrandOwnerWhere = { userId: string } | { workspaceId: string };

export function resolveBrandOwnerForWorkspace(input: {
  workspaceId: string;
  personalOwnerUserId: string | null;
}): BrandOwner {
  return input.personalOwnerUserId
    ? { userId: input.personalOwnerUserId, workspaceId: null }
    : { userId: null, workspaceId: input.workspaceId };
}

export function resolveBrandOwner(scope: BrandActorScope): BrandOwner {
  return resolveBrandOwnerForWorkspace({
    workspaceId: scope.workspaceId,
    personalOwnerUserId: scope.isPersonalWorkspace ? scope.workspaceOwnerUserId : null,
  });
}

export function brandOwnerWhereForWorkspace(input: {
  workspaceId: string;
  personalOwnerUserId: string | null;
}): BrandOwnerWhere {
  const owner = resolveBrandOwnerForWorkspace(input);
  return owner.userId !== null
    ? { userId: owner.userId }
    : { workspaceId: owner.workspaceId };
}

export function brandOwnerWhere(scope: BrandActorScope) {
  return brandOwnerWhereForWorkspace({
    workspaceId: scope.workspaceId,
    personalOwnerUserId: scope.isPersonalWorkspace ? scope.workspaceOwnerUserId : null,
  });
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
