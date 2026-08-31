import { describe, expect, test } from "bun:test";
import {
  formatFractionalDuration,
  formatFractionalDurationRange,
} from "./format";

describe("fractional duration formatting", () => {
  test("keeps fractional seconds consistent across labels and ranges", () => {
    expect(formatFractionalDuration(0.4)).toBe("0.40s");
    expect(formatFractionalDuration(3.45, 1)).toBe("3.5s");
    expect(formatFractionalDurationRange(1.234, 5.678)).toBe("1.23–5.68s");
  });

  test("clamps invalid durations and precision", () => {
    expect(formatFractionalDuration(-1, 1)).toBe("0.0s");
    expect(formatFractionalDuration(Number.NaN)).toBe("0.00s");
    expect(formatFractionalDuration(1.23456, 99)).toBe("1.235s");
  });
});
