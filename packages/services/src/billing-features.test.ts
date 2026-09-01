import { describe, expect, test } from "bun:test";
import type { PricingTier } from "@narriflow/validators";
import { hasFeature, type PlanFeature } from "./billing.service";

// Pure entitlement matrix behind `hasFeature` (vizard-parity Phase C export
// options): watermark presence and 1080p access derive from the owner's tier
// through this single helper, never a raw `tier === "free"` check.

const ALL_TIERS: PricingTier[] = ["free", "creator", "pro", "business"];
const EXPORT_FEATURES: PlanFeature[] = ["export.1080p", "export.noWatermark"];
const INTEGRATION_FEATURES: PlanFeature[] = ["integrations.api", "integrations.mcp"];
const PROGRAM_FEATURES: PlanFeature[] = [
  "brand.profiles",
  "brand.customFonts",
  "brand.scenes",
  "editor.censoring",
  "editor.motion",
  "publishing.assistedCopy",
  "campaign.operations",
  "export.bundles",
  "review.rooms",
  "generated.images",
  "generated.video",
];
const ALL_FEATURES: PlanFeature[] = [
  ...EXPORT_FEATURES,
  ...INTEGRATION_FEATURES,
  ...PROGRAM_FEATURES,
];

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

  test("fails closed for removed pricing tiers", () => {
    expect(hasFeature("starter", "export.1080p")).toBe(false);
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

  test("matches the Vizard expansion packaging matrix", () => {
    for (const feature of [
      "brand.profiles",
      "brand.customFonts",
      "brand.scenes",
      "editor.censoring",
      "editor.motion",
      "publishing.assistedCopy",
    ] as const) {
      expect(hasFeature("free", feature)).toBe(false);
      expect(hasFeature("creator", feature)).toBe(true);
      expect(hasFeature("pro", feature)).toBe(true);
      expect(hasFeature("business", feature)).toBe(true);
    }

    for (const feature of [
      "campaign.operations",
      "export.bundles",
      "generated.video",
    ] as const) {
      expect(hasFeature("creator", feature)).toBe(false);
      expect(hasFeature("pro", feature)).toBe(true);
      expect(hasFeature("business", feature)).toBe(true);
    }

    expect(hasFeature("free", "generated.images")).toBe(true);
    expect(hasFeature("business", "review.rooms")).toBe(true);
    expect(hasFeature("pro", "review.rooms")).toBe(false);
  });

  test("unknown and removed tiers fail closed", () => {
    expect(hasFeature("enterprise", "brand.profiles")).toBe(false);
    expect(hasFeature("starter", "brand.profiles")).toBe(false);
    expect(hasFeature("starter", "campaign.operations")).toBe(false);
  });
});
