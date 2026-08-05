import { describe, expect, test } from "bun:test";
import type { PricingTier } from "@narriflow/validators";
import { hasFeature, type PlanFeature } from "./billing.service";

// Pure entitlement matrix behind `hasFeature` (vizard-parity Phase C export
// options): watermark presence and 1080p access derive from the owner's tier
// through this single helper, never a raw `tier === "free"` check.

const ALL_TIERS: PricingTier[] = ["free", "starter", "creator", "pro"];
const ALL_FEATURES: PlanFeature[] = ["export.1080p", "export.noWatermark"];

describe("hasFeature (PLAN_FEATURES matrix)", () => {
  test("free has neither export feature", () => {
    for (const feature of ALL_FEATURES) {
      expect(hasFeature("free", feature)).toBe(false);
    }
  });

  test("every paid tier has both export features", () => {
    for (const tier of ["starter", "creator", "pro"] as const) {
      for (const feature of ALL_FEATURES) {
        expect(hasFeature(tier, feature)).toBe(true);
      }
    }
  });

  test("is a total function over every tier x feature pair (no undefined/throw)", () => {
    for (const tier of ALL_TIERS) {
      for (const feature of ALL_FEATURES) {
        expect(typeof hasFeature(tier, feature)).toBe("boolean");
      }
    }
  });
});
