import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CAPTION_EMOJI_MAP } from "@narriflow/validators";
import {
  CAPTION_EMOJI_ATLAS,
  CAPTION_EMOJI_HEIGHT_EM,
  captionEmojiKey,
  captionEmojiSpriteCss,
  captionGraphemes,
  isCaptionEmojiCluster,
  resolveCaptionEmoji,
} from "./emoji";
import { CAPTION_EMOJI_ATLAS_PATH } from "./paths";

describe("shared emoji atlas", () => {
  test("the sheet is the pinned artwork", () => {
    const sheet = readFileSync(CAPTION_EMOJI_ATLAS_PATH);
    expect(createHash("sha256").update(sheet).digest("hex")).toBe(CAPTION_EMOJI_ATLAS.sheet.sha256);
    // PNG IHDR: width and height of the sheet match the grid.
    expect(sheet.readUInt32BE(16)).toBe(CAPTION_EMOJI_ATLAS.sheet.width);
    expect(sheet.readUInt32BE(20)).toBe(CAPTION_EMOJI_ATLAS.sheet.height);
    expect(CAPTION_EMOJI_ATLAS.sheet.width).toBe(CAPTION_EMOJI_ATLAS.columns * CAPTION_EMOJI_ATLAS.cell.width);
    expect(CAPTION_EMOJI_ATLAS.source.tag).toMatch(/^v\d{4}-\d{2}-\d{2}/);
    expect(CAPTION_EMOJI_ATLAS.source.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  // Plan emoji come only from CAPTION_EMOJI_MAP (composition-plan: `emojiForWord`), so this
  // is the CI gate: a map addition without atlas artwork fails here, not at export time.
  test("every keyword emoji resolves, with or without its presentation selector", () => {
    for (const emoji of Object.values(CAPTION_EMOJI_MAP)) {
      const sprite = resolveCaptionEmoji(emoji);
      expect(sprite).not.toBeNull();
      expect(resolveCaptionEmoji(emoji.replace(/️/g, ""))).toEqual(sprite);
      expect(resolveCaptionEmoji(`${emoji.replace(/️/g, "")}️`)).toEqual(sprite);
    }
  });

  test("ZWJ family and skin-tone clusters resolve whole, never as their parts", () => {
    expect(resolveCaptionEmoji("👨‍👩‍👧")?.key).toBe("1f468_200d_1f469_200d_1f467");
    expect(resolveCaptionEmoji("👍🏽")?.key).toBe("1f44d_1f3fd");
    expect(resolveCaptionEmoji("👍")?.key).not.toBe("1f44d_1f3fd");
    // A tone the atlas lacks does not fall back to the base emoji: that would discard the tone.
    expect(resolveCaptionEmoji("👍🏿")).toBeNull();
    expect(resolveCaptionEmoji("👨‍👩")).toBeNull();
  });

  test("a text-presentation request and unknown sequences have no colour artwork", () => {
    expect(resolveCaptionEmoji("❤︎")).toBeNull();
    expect(resolveCaptionEmoji("🇵🇰")).toBeNull();
    expect(resolveCaptionEmoji("\u{1F600}")).toBeNull();
  });

  test("grapheme clusters keep sequences intact", () => {
    expect(captionGraphemes("a👨‍👩‍👧🇵🇰👍🏽❤️b")).toEqual(["a", "👨‍👩‍👧", "🇵🇰", "👍🏽", "❤️", "b"]);
    expect(captionGraphemes("é")).toEqual(["é"]);
    expect(isCaptionEmojiCluster("🇵🇰")).toBe(true);
    expect(isCaptionEmojiCluster("A")).toBe(false);
  });

  test("keys drop only the presentation selector and sprite CSS addresses its cell", () => {
    expect(captionEmojiKey("❤️")).toBe("2764");
    expect(captionEmojiKey("👍🏽")).toBe("1f44d_1f3fd");
    const sprite = resolveCaptionEmoji("🔥")!;
    const css = captionEmojiSpriteCss(sprite);
    expect(css.backgroundSize).toBe(`${CAPTION_EMOJI_ATLAS.columns * 100}% ${CAPTION_EMOJI_ATLAS.rows * 100}%`);
    expect(css.backgroundPosition).toMatch(/^[\d.]+% [\d.]+%$/);
    expect(CAPTION_EMOJI_HEIGHT_EM).toBeCloseTo(0.94, 2);
  });

  test("every atlas cell is a real picture (non-empty alpha) and its source hash is recorded", () => {
    for (const [key, cell] of Object.entries(CAPTION_EMOJI_ATLAS.sequences)) {
      expect(cell.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(cell.column).toBeLessThan(CAPTION_EMOJI_ATLAS.columns);
      expect(cell.row).toBeLessThan(CAPTION_EMOJI_ATLAS.rows);
      expect(key).toMatch(/^[0-9a-f]+(_[0-9a-f]+)*$/);
    }
  });
});
