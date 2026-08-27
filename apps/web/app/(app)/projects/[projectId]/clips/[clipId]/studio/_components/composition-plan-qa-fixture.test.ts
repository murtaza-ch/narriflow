import { describe, expect, test } from "bun:test";
import {
  applyCompositionPlanQaFixture,
  resolveCompositionPlanQaFixture,
} from "./composition-plan-qa-fixture";

describe("Clip Composition Plan browser fixture", () => {
  test("is available only outside production", () => {
    expect(resolveCompositionPlanQaFixture("invalid", "development")).toBe(
      "invalid",
    );
    expect(resolveCompositionPlanQaFixture("invalid", "test")).toBe("invalid");
    expect(resolveCompositionPlanQaFixture("invalid", "production")).toBeNull();
    expect(resolveCompositionPlanQaFixture("anything-else", "development")).toBeNull();
  });

  test("replaces a plan result with a deterministic invalid-plan result", () => {
    const ready = {
      status: "ready" as const,
      plan: { fingerprint: "ready-plan" },
    };

    expect(applyCompositionPlanQaFixture(ready, null)).toBe(ready);
    expect(applyCompositionPlanQaFixture(ready, "invalid")).toEqual({
      status: "invalid",
      error: { code: "invalid_target" },
    });
  });
});
