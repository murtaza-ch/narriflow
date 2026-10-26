import { describe, expect, test } from "bun:test";
import {
  lowestTierWithFeature,
  PLAN_CATALOG,
  planFeatureSchema,
  PRICING_TIER_ORDER,
} from "@narriflow/validators";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import {
  hasFeature,
  PlanRequirementError,
  requirePlanFeature,
  requireWithinPlanLimit,
} from "./plan-features";

function refusal(action: () => void): PlanRequirementError {
  try {
    action();
  } catch (error) {
    if (error instanceof PlanRequirementError) return error;
    throw error;
  }
  throw new Error("expected a plan refusal");
}

describe("hasFeature", () => {
  test("is a total function over every tier x feature pair, failing closed for unknown tiers", () => {
    for (const tier of [...PRICING_TIER_ORDER, "starter", "enterprise", null]) {
      for (const feature of planFeatureSchema.options) {
        expect(typeof hasFeature(tier, feature)).toBe("boolean");
      }
    }
    expect(hasFeature("starter", "integrations.mcp")).toBe(false);
    expect(hasFeature(null, "export.noWatermark")).toBe(false);
  });

  test("Free exports carry the watermark; every paid tier removes it", () => {
    expect(hasFeature("free", "export.noWatermark")).toBe(false);
    for (const tier of ["creator", "pro", "business"]) expect(hasFeature(tier, "export.noWatermark")).toBe(true);
  });
});

describe("requirePlanFeature", () => {
  test("allows an included feature", () => {
    for (const tier of PRICING_TIER_ORDER)
      for (const feature of planFeatureSchema.options)
        if (PLAN_CATALOG[tier].features[feature]) expect(() => requirePlanFeature(tier, feature)).not.toThrow();
  });

  test("refuses with the shared payment_required shape naming the cheapest tier", () => {
    const failure = refusal(() => requirePlanFeature("free", "integrations.api"));
    expect(failure).toBeInstanceOf(ExpectedDomainFailureError);
    expect(failure).toMatchObject({
      code: "plan_feature_required",
      kind: "payment_required",
      details: {
        feature: "integrations.api",
        currentTier: "free",
        requiredTier: lowestTierWithFeature("integrations.api"),
      },
    });
    expect(failure.message).toContain(PLAN_CATALOG[lowestTierWithFeature("integrations.api")!].name);
  });

  test("an unknown tier is refused as Free", () => {
    expect(refusal(() => requirePlanFeature("enterprise", "review.rooms")).details).toMatchObject({
      currentTier: "free",
    });
  });
});

describe("requireWithinPlanLimit", () => {
  test("allows up to the limit and refuses the next object with used/max details", () => {
    const max = PLAN_CATALOG.creator.limits.brandProfiles;
    expect(() => requireWithinPlanLimit("creator", "brandProfiles", max - 1)).not.toThrow();
    const failure = refusal(() => requireWithinPlanLimit("creator", "brandProfiles", max));
    expect(failure).toMatchObject({
      code: "plan_limit_reached",
      kind: "payment_required",
      details: { limit: "brandProfiles", used: max, max, currentTier: "creator" },
    });
    const required = failure.details?.requiredTier;
    expect(required).not.toBeNull();
    expect(PLAN_CATALOG[required!].limits.brandProfiles).toBeGreaterThan(max);
  });

  test("a zero limit refuses as a missing feature", () => {
    expect(refusal(() => requireWithinPlanLimit("free", "socialDestinations", 0))).toMatchObject({
      code: "plan_feature_required",
      details: { limit: "socialDestinations", max: 0, currentTier: "free" },
    });
  });

  test("a batch that no plan can hold has no required tier", () => {
    const top = PLAN_CATALOG.business.limits.autopilotRules;
    expect(refusal(() => requireWithinPlanLimit("business", "autopilotRules", top, 1)).details).toMatchObject({
      requiredTier: null,
    });
  });

  test("an over-limit Workspace (after a downgrade) is refused more, never less", () => {
    const max = PLAN_CATALOG.creator.limits.brandTemplates;
    expect(refusal(() => requireWithinPlanLimit("creator", "brandTemplates", max + 5)).details).toMatchObject({
      used: max + 5,
      max,
    });
  });
});
