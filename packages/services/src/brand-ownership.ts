import {
  workspaceAllowsCapability,
  type WorkspaceAccessRole,
  type WorkspaceAccessStatus,
} from "@narriflow/validators";
import { hasFeature, type PlanFeature } from "./plan-features";

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
}
