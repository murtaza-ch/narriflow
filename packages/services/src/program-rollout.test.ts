import { describe, expect, test } from "bun:test";
import {
  assertProgramWriteEnabled,
  isProgramWriteEnabled,
  ProgramWriteDisabledError,
} from "./program-rollout";

describe("program rollout controls", () => {
  test("defaults to fail-closed writes while keeping reads available", () => {
    expect(isProgramWriteEnabled("brand_profiles", {})).toBe(false);
    expect(() => assertProgramWriteEnabled("brand_profiles", {})).toThrow(
      ProgramWriteDisabledError,
    );
  });

  test("enables only the named release group", () => {
    const env = { NARRIFLOW_WRITES_BRAND_PROFILES: "1" };
    expect(isProgramWriteEnabled("brand_profiles", env)).toBe(true);
    expect(isProgramWriteEnabled("visual_assets", env)).toBe(false);
  });
});
