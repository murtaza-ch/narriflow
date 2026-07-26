import { describe, expect, test } from "bun:test";
import { captionPresetSchema, CAPTION_PRESETS } from ".";

describe("captionPresetSchema defaults (preview == export)", () => {
  test("fills letterSpacing + textTransform to match the studio preview fallbacks", () => {
    // The studio preview falls back to 0.04 / "uppercase" when unset; the schema
    // must apply the same defaults so the burned export looks identical.
    const parsed = captionPresetSchema.parse({});
    expect(parsed.letterSpacing).toBe(0.04);
    expect(parsed.textTransform).toBe("uppercase");
  });

  test("every built-in preset sets both fields explicitly", () => {
    for (const { preset } of CAPTION_PRESETS) {
      expect(preset.letterSpacing).toBeDefined();
      expect(preset.textTransform).toBeDefined();
    }
  });
});
