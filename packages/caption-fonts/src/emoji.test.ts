import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CAPTION_EMOJI_MAP } from "@narriflow/validators";
import {
  CAPTION_EMOJI_ATLAS,
  CAPTION_EMOJI_HEIGHT_EM,
  CAPTION_EMOJI_MOTION,
  captionEmojiKey,
  captionEmojiMotionTiming,
  captionEmojiPose,
  captionEmojiScaleExpression,
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

  // Noto's 2D PNG set has no flags (the font builds them from region-flags), so flags are not vendored.
  // That is safe only while no plan emoji is a flag; this fails the day the map gains one.
  test("the keyword map holds no flag, so no plan emoji needs flag artwork", () => {
    for (const emoji of Object.values(CAPTION_EMOJI_MAP)) {
      expect(emoji).not.toMatch(/\p{Regional_Indicator}/u);
      expect(emoji).not.toContain("\u{1F3F4}");
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

describe("emoji motion", () => {
  test("pops in from 0.6 with a slight overshoot, settles at 1 and fades out at the end", () => {
    expect(captionEmojiPose(0, 0.6).scale).toBeCloseTo(CAPTION_EMOJI_MOTION.fromScale, 9);
    expect(captionEmojiPose(0, 0.6).alpha).toBe(0);
    const peak = Math.max(...Array.from({ length: 151 }, (_, i) => captionEmojiPose(i / 1000, 0.6).scale));
    expect(peak).toBeGreaterThan(1.02);
    expect(peak).toBeLessThan(1.06);
    expect(captionEmojiPose(0.15, 0.6).scale).toBeCloseTo(1, 9);
    expect(captionEmojiPose(0.3, 0.6)).toEqual({ scale: 1, alpha: 1 });
    expect(captionEmojiPose(0.56, 0.6).alpha).toBeCloseTo(0.5, 6);
    expect(captionEmojiPose(0.6, 0.6).alpha).toBe(0);
  });

  test("short windows shrink both ramps so they never overlap", () => {
    for (const windowSec of [0.05, 0.12, 0.3, 0.6, 2]) {
      const { enterSec, exitSec } = captionEmojiMotionTiming(windowSec);
      expect(enterSec + exitSec).toBeLessThanOrEqual(windowSec * 0.75 + 1e-9);
      expect(enterSec).toBeLessThanOrEqual(CAPTION_EMOJI_MOTION.enterSec);
      expect(exitSec).toBeLessThanOrEqual(CAPTION_EMOJI_MOTION.exitSec);
    }
  });

  // The export evaluates this string inside FFmpeg; it must be the same curve Studio plays.
  test("the FFmpeg scale expression is the pose curve", () => {
    for (const windowSec of [0.12, 0.6, 1.4]) {
      const startSec = 3.25;
      const expression = captionEmojiScaleExpression({ time: "t", startSec, windowSec });
      const evaluate = new Function("t", "clip", `return ${expression};`) as (t: number, clip: (x: number, lo: number, hi: number) => number) => number;
      const clip = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
      for (let elapsed = 0; elapsed <= windowSec; elapsed += windowSec / 40) {
        expect(evaluate(startSec + elapsed, clip)).toBeCloseTo(captionEmojiPose(elapsed, windowSec).scale, 4);
      }
    }
  });
});
