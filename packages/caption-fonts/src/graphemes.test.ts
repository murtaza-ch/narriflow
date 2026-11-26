import { describe, expect, test } from "bun:test";
import { captionGraphemes, isCaptionEmojiCluster } from "./graphemes";

describe("caption graphemes", () => {
  test("clusters keep sequences intact", () => {
    expect(captionGraphemes("a👨‍👩‍👧🇵🇰👍🏽❤️b")).toEqual(["a", "👨‍👩‍👧", "🇵🇰", "👍🏽", "❤️", "b"]);
    expect(captionGraphemes("é")).toEqual(["é"]);
  });

  test("emoji clusters include flags and keycaps, not letters", () => {
    expect(isCaptionEmojiCluster("🇵🇰")).toBe(true);
    expect(isCaptionEmojiCluster("1️⃣")).toBe(true);
    expect(isCaptionEmojiCluster("👍🏽")).toBe(true);
    expect(isCaptionEmojiCluster("A")).toBe(false);
    expect(isCaptionEmojiCluster("ب")).toBe(false);
  });
});
