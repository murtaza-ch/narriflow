import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  CAPTION_EMOJI_DEFAULT_PALETTE,
  CAPTION_EMOJI_GROUPS,
  CAPTION_EMOJI_INDEX,
  CAPTION_EMOJI_INK,
  CAPTION_EMOJI_SKIN_TONES,
  CAPTION_EMOJI_AI_BADGES,
  CAPTION_EMOJI_AI_GLYPHS,
  CAPTION_EMOJI_COUNT,
  captionEmojiById,
  emojiRefForGlyph,
  resolveCaptionEmojiColour,
} from "./index";

describe("caption emoji index", () => {
  test("holds every base design once, with kebab ids", () => {
    // The pack's 1,408 designs and Narriflow's own four: kitchen knife, bird, auto rickshaw, handshake.
    expect(CAPTION_EMOJI_INDEX.length).toBe(1412);
    expect(new Set(CAPTION_EMOJI_INDEX.map((e) => e.id)).size).toBe(1412);
    for (const entry of CAPTION_EMOJI_INDEX) expect(entry.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(CAPTION_EMOJI_INDEX.filter((e) => e.kind === "single").length).toBe(1012);
    expect(CAPTION_EMOJI_INDEX.filter((e) => e.kind === "phrase").length).toBe(400);
    expect(CAPTION_EMOJI_INDEX.filter((e) => e.hasTones).length).toBe(181);
    expect(CAPTION_EMOJI_COUNT).toBe(2317);
  });

  test("the designs drawn after the pack are found by glyph and by name; the handshake has tones like the pack's two-hand designs", () => {
    for (const [glyph, id, name] of [["🔪", "kitchen-knife", "knife"], ["🐦", "bird", "bird"], ["🛺", "auto-rickshaw", "rickshaw"], ["🤝", "handshake", "handshake"]] as const) {
      expect(emojiRefForGlyph(glyph)).toEqual({ id });
      expect(captionEmojiById(id)?.kind).toBe("single");
      expect(captionEmojiById(id)?.keywords).toContain(name);
    }
    expect(captionEmojiById("auto-rickshaw")?.keywords).toContain("tuk");
    expect(captionEmojiById("handshake")?.hasTones).toBe(true);
    expect(captionEmojiById("clapping-hands")?.hasTones).toBe(true);
    expect(emojiRefForGlyph("🤝🏾")).toEqual({ id: "handshake", tone: 4 });
    expect(captionEmojiById("bird")?.hasTones).toBe(false);
  });

  test("groups cover every entry", () => {
    const groups = new Set(CAPTION_EMOJI_GROUPS.map((g) => g.id));
    expect(groups.size).toBe(10);
    for (const entry of CAPTION_EMOJI_INDEX) expect(groups.has(entry.group)).toBe(true);
  });

  test("keywords include the name, catalog keywords and caption words", () => {
    expect(captionEmojiById("money-bag")?.keywords).toContain("money");
    expect(captionEmojiById("mountain-peak")?.keywords).toContain("summit");
    expect(captionEmojiById("grinning-face-with-big-eyes")?.keywords).toContain("news");
    for (const entry of CAPTION_EMOJI_INDEX) expect(entry.keywords.length).toBeGreaterThan(0);
  });

  test("every design's glyph maps back to it, a phrase badge's by its two emojis", () => {
    for (const entry of CAPTION_EMOJI_INDEX) expect(emojiRefForGlyph(entry.glyph)).toEqual({ id: entry.id });
    expect(emojiRefForGlyph("☕⏰")).toEqual({ id: "morning-coffee" });
    expect(emojiRefForGlyph("☕\uFE0F⏰")).toEqual({ id: "morning-coffee" });
    expect(emojiRefForGlyph("⏰☕")).toBeNull();
  });

  test("glyph lookup ignores U+FE0F and surrounding space", () => {
    expect(emojiRefForGlyph("\u2764")).toEqual(emojiRefForGlyph("\u2764\uFE0F")!);
    expect(emojiRefForGlyph("\u2764")).not.toBeNull();
    expect(emojiRefForGlyph(" 🔥 ")).toEqual(emojiRefForGlyph("🔥")!);
    expect(emojiRefForGlyph("👍")).toEqual({ id: "thumbs-up" });
  });

  test("a skin-tone modifier becomes the tone when the design has tones", () => {
    expect(captionEmojiById("waving-hand")?.hasTones).toBe(true);
    for (const tone of CAPTION_EMOJI_SKIN_TONES) {
      if (tone.modifier === null) continue;
      expect(emojiRefForGlyph(`👋${tone.modifier}`)).toEqual({ id: "waving-hand", tone: tone.tone as 1 | 2 | 3 | 4 | 5 });
    }
    expect(emojiRefForGlyph("👋")).toEqual({ id: "waving-hand" });
    // A design without tones ignores the modifier.
    const plain = CAPTION_EMOJI_INDEX.find((e) => e.kind === "single" && !e.hasTones && e.id === "grin")!;
    expect(emojiRefForGlyph(`${plain.glyph}\u{1F3FD}`)).toEqual({ id: "grin" });
  });

  test("a gendered sequence without its own design falls back to the neutral one", () => {
    expect(emojiRefForGlyph("👨🏽‍🚀")).toEqual({ id: "man-astronaut", tone: 3 });
    expect(emojiRefForGlyph("🧑‍🚀")).toEqual({ id: "astronaut" });
    // No "Man running" design: the sign is dropped and the tone kept.
    expect(captionEmojiById("man-running")).toBeUndefined();
    expect(emojiRefForGlyph("🏃‍♂️")).toEqual({ id: "person-running" });
    expect(emojiRefForGlyph("🏃🏿‍♀️")).toEqual({ id: "person-running", tone: 5 });
  });

  test("unknown glyphs return null", () => {
    expect(emojiRefForGlyph("")).toBeNull();
    expect(emojiRefForGlyph("hello")).toBeNull();
    expect(emojiRefForGlyph("\u{1F004}")).toBeNull(); // Mahjong tile: no design
  });

  test("the AI vocabulary is every design: each single design's glyph and each badge's pair and name, once, in catalog order", () => {
    const singles = CAPTION_EMOJI_INDEX.filter((e) => e.kind === "single");
    const badges = CAPTION_EMOJI_INDEX.filter((e) => e.kind === "phrase");
    expect(CAPTION_EMOJI_AI_GLYPHS).toEqual(singles.map((e) => e.glyph));
    expect(new Set(CAPTION_EMOJI_AI_GLYPHS).size).toBe(1012);
    expect(CAPTION_EMOJI_AI_BADGES).toEqual(badges.map((e) => ({ glyph: e.glyph, name: e.name })));
    expect(new Set(CAPTION_EMOJI_AI_BADGES.map((badge) => badge.glyph)).size).toBe(400);
    expect(CAPTION_EMOJI_AI_GLYPHS).toContain("🤑");
    expect(Object.isFrozen(CAPTION_EMOJI_AI_GLYPHS)).toBe(true);
    expect(Object.isFrozen(CAPTION_EMOJI_AI_BADGES)).toBe(true);
  });

  test("resolves colours for roles, literals, skin and per-tone features", () => {
    const palette = { a: "#111111", b: "#222222", c: "#333333" };
    expect(resolveCaptionEmojiColour({ role: "a" }, palette)).toBe("#111111");
    expect(resolveCaptionEmojiColour({ role: "b" }, palette)).toBe("#222222");
    expect(resolveCaptionEmojiColour({ role: "c" }, palette)).toBe("#333333");
    expect(resolveCaptionEmojiColour({ role: "ink" }, palette)).toBe(CAPTION_EMOJI_INK);
    expect(resolveCaptionEmojiColour({ hex: "#abcdef" }, palette)).toBe("#abcdef");
    for (const tone of CAPTION_EMOJI_SKIN_TONES) expect(resolveCaptionEmojiColour({ role: "skin" }, palette, tone.tone)).toBe(tone.hex);
    expect(resolveCaptionEmojiColour({ role: "skin" }, palette, 9)).toBe(CAPTION_EMOJI_SKIN_TONES[0]!.hex);
    const rim = { tone: [null, null, null, null, "#e4b28d", "#e4b28d"] };
    expect(resolveCaptionEmojiColour(rim, CAPTION_EMOJI_DEFAULT_PALETTE, 0)).toBeNull();
    expect(resolveCaptionEmojiColour(rim, CAPTION_EMOJI_DEFAULT_PALETTE, 5)).toBe("#e4b28d");
  });

  test("importing the index does not reach the art", () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/(?:from|import)\s*\(?\s*"(\.[^"]+)"/g)) visit(resolve(dirname(file), `${match[1]}.ts`));
    };
    visit(join(import.meta.dir, "index.ts"));
    const reached = [...seen].map((file) => file.slice(import.meta.dir.length + 1));
    expect(reached.some((file) => file.includes("art") || file.includes("shards"))).toBe(false);
    const bytes = reached.reduce((sum, file) => sum + readFileSync(join(import.meta.dir, file)).length, 0);
    expect(bytes).toBeLessThan(200_000);
  });
});
