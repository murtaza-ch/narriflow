import { describe, expect, test } from "bun:test";
import {
  canSubmitStudioExport,
  studioExportBlockReason,
} from "./studio-export-policy";

describe("Studio export policy", () => {
  test("blocks an invalid Clip Composition Plan", () => {
    expect(
      canSubmitStudioExport({
        compositionPlanStatus: "invalid",
        exportState: "idle",
        selectedVariantCount: 1,
      }),
    ).toBe(false);
    expect(studioExportBlockReason("invalid")).toBe(
      "Fix the invalid composition before exporting.",
    );
  });

  test("allows ready, pending, and not-yet-resolved plans", () => {
    for (const compositionPlanStatus of [
      "unresolved",
      "ready",
      "pending",
    ] as const) {
      expect(
        canSubmitStudioExport({
          compositionPlanStatus,
          exportState: "idle",
          selectedVariantCount: 1,
        }),
      ).toBe(true);
    }
  });

	test("blocks unavailable frozen Scene assets and Brand fonts", () => {
		expect(canSubmitStudioExport({ compositionPlanStatus: "blocked", exportState: "idle", selectedVariantCount: 1 })).toBe(false);
		expect(studioExportBlockReason("blocked")).toContain("unavailable Scene asset or Brand font");
	});

  test("still blocks empty selections and in-flight exports", () => {
    expect(
      canSubmitStudioExport({
        compositionPlanStatus: "ready",
        exportState: "idle",
        selectedVariantCount: 0,
      }),
    ).toBe(false);
    expect(
      canSubmitStudioExport({
        compositionPlanStatus: "ready",
        exportState: "exporting",
        selectedVariantCount: 1,
      }),
    ).toBe(false);
  });
});
