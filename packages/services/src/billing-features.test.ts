import { describe, expect, test } from "bun:test";
import type { PricingTier } from "@narriflow/validators";
import { hasFeature, type PlanFeature } from "./billing.service";

// Pure entitlement matrix behind `hasFeature` (vizard-parity Phase C export
// options): watermark presence and 1080p access derive from the owner's tier
// through this single helper, never a raw `tier === "free"` check.

const ALL_TIERS: PricingTier[] = ["free", "creator", "pro", "business"];
const EXPORT_FEATURES: PlanFeature[] = ["export.1080p", "export.noWatermark"];
const INTEGRATION_FEATURES: PlanFeature[] = ["integrations.api", "integrations.mcp"];
const ALL_FEATURES: PlanFeature[] = [...EXPORT_FEATURES, ...INTEGRATION_FEATURES];

describe("hasFeature (PLAN_FEATURES matrix)", () => {
  test("free has neither export feature", () => {
    for (const feature of EXPORT_FEATURES) {
      expect(hasFeature("free", feature)).toBe(false);
    }
  });

  test("every paid tier has both export features", () => {
    for (const tier of ["creator", "pro", "business"] as const) {
      for (const feature of EXPORT_FEATURES) {
        expect(hasFeature(tier, feature)).toBe(true);
      }
    }
  });

  test("normalizes the legacy starter tier before checking entitlements", () => {
    expect(hasFeature("starter", "export.1080p")).toBe(true);
    expect(hasFeature("starter", "integrations.mcp")).toBe(false);
  });

  test("API and MCP integrations are Business capabilities", () => {
    for (const tier of ["free", "creator", "pro"] as const) {
      for (const feature of INTEGRATION_FEATURES) {
        expect(hasFeature(tier, feature)).toBe(false);
      }
    }
    for (const feature of INTEGRATION_FEATURES) {
      expect(hasFeature("business", feature)).toBe(true);
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
