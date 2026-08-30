import { describe, expect, test } from "bun:test";
import { generationAccessForTier } from "./generation-usage";

describe("generation access", () => {
  test("separates entitlement from metered usage settlement", () => {
    expect(generationAccessForTier("free", "image")).toEqual({
      entitled: true,
      usage: "trial_metered",
    });
    expect(generationAccessForTier("creator", "image")).toEqual({
      entitled: true,
      usage: "metered",
    });
    expect(generationAccessForTier("creator", "video")).toEqual({
      entitled: false,
      usage: "metered",
    });
    expect(generationAccessForTier("pro", "video")).toEqual({
      entitled: true,
      usage: "metered",
    });
  });
});
