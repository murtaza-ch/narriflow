import { describe, expect, test } from "bun:test";
import { PRICING_TIER_ORDER, brandPlanRequirement, hasFeature, type PlanFeature } from "@narriflow/validators";
import {
  assertBrandMutationAllowed,
  brandCountRequirement,
  type BrandActorScope,
} from "./brand-ownership";
import { PlanRequirementError } from "./plan-features";

const FEATURES: PlanFeature[] = ["brand.profiles", "brand.customTemplates", "brand.scenes"];

function scope(pricingTier: string, isPersonalWorkspace: boolean): BrandActorScope {
  return {
    actorUserId: "user",
    workspaceId: "workspace",
    workspaceOwnerUserId: "user",
    role: "owner",
    status: "active",
    pricingTier,
    isPersonalWorkspace,
  };
}

describe("brand plan requirement", () => {
  test("a shared Free workspace is offered Business, not Creator", () => {
    expect(brandPlanRequirement({ pricingTier: "free", isPersonalWorkspace: true }, "brand.profiles")?.requiredTier).toBe("creator");
    const shared = brandPlanRequirement({ pricingTier: "free", isPersonalWorkspace: false }, "brand.profiles");
    expect(shared?.requiredTier).toBe("business");
    expect(shared?.message).toBe("Branding in a shared Workspace needs the Business plan.");
  });

  for (const feature of FEATURES) {
    for (const isPersonalWorkspace of [true, false]) {
      for (const tier of PRICING_TIER_ORDER) {
        test(`${feature} on ${tier} in a ${isPersonalWorkspace ? "personal" : "shared"} workspace: the offered tier passes the same policy`, () => {
          const current = { pricingTier: tier, isPersonalWorkspace };
          const requirement = brandPlanRequirement(current, feature);
          if (!requirement) {
            expect(hasFeature(tier, feature)).toBe(true);
            expect(() => assertBrandMutationAllowed(scope(tier, isPersonalWorkspace), feature)).not.toThrow();
            return;
          }
          expect(requirement.requiredTier).not.toBeNull();
          expect(brandPlanRequirement({ pricingTier: requirement.requiredTier!, isPersonalWorkspace }, feature)).toBeNull();
          const refusal = (() => {
            try {
              assertBrandMutationAllowed(scope(tier, isPersonalWorkspace), feature);
            } catch (error) {
              return error;
            }
          })();
          expect(refusal).toBeInstanceOf(PlanRequirementError);
          expect((refusal as PlanRequirementError).details).toMatchObject({
            feature,
            currentTier: tier,
            requiredTier: requirement.requiredTier,
          });
          expect(() => assertBrandMutationAllowed(scope(requirement.requiredTier!, isPersonalWorkspace), feature)).not.toThrow();
        });
      }
    }
  }
});

describe("brand count requirement", () => {
  test("never offers a tier below the shared-workspace requirement", () => {
    // Shared Creator at its profile count: Pro has room but still lacks team branding.
    for (const tier of PRICING_TIER_ORDER) {
      for (const used of [0, 1, 4, 10]) {
        const current = { pricingTier: tier, isPersonalWorkspace: false };
        const requirement = brandCountRequirement(current, "brand.profiles", "brandProfiles", used);
        if (!requirement?.requiredTier) continue;
        expect(brandPlanRequirement({ pricingTier: requirement.requiredTier, isPersonalWorkspace: false }, "brand.profiles")).toBeNull();
        expect(brandCountRequirement({ pricingTier: requirement.requiredTier, isPersonalWorkspace: false }, "brand.profiles", "brandProfiles", used)).toBeNull();
      }
    }
  });

  test("personal workspaces follow the count limit alone", () => {
    const personal = { pricingTier: "creator", isPersonalWorkspace: true };
    expect(brandCountRequirement(personal, "brand.profiles", "brandProfiles", 0)).toBeNull();
    const full = brandCountRequirement(personal, "brand.profiles", "brandProfiles", 1);
    expect(full?.requiredTier).toBe("pro");
  });

  test("a full top-tier allowance has no purchasable tier", () => {
    const top = PRICING_TIER_ORDER[PRICING_TIER_ORDER.length - 1]!;
    const requirement = brandCountRequirement({ pricingTier: top, isPersonalWorkspace: false }, "brand.profiles", "brandProfiles", 1_000);
    expect(requirement?.requiredTier).toBeNull();
  });
});
