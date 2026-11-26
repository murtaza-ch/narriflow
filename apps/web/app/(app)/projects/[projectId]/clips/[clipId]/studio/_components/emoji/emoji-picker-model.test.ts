import { describe, expect, test } from "bun:test";
import { CAPTION_EMOJI_GROUPS, CAPTION_EMOJI_INDEX, emojiRefForGlyph } from "@narriflow/caption-emoji/index";
import {
  buildEmojiSearch,
  captionEmojiPickerGroups,
  captionEmojiQueryTone,
  moveInGrid,
  pickedEmojiRef,
  pickerLayout,
  pickerStartTone,
  searchCaptionEmojis,
  searchableText,
  visibleRows,
  withRecentEmoji,
} from "./emoji-picker-model";

const search = buildEmojiSearch(CAPTION_EMOJI_INDEX, CAPTION_EMOJI_GROUPS);
const ids = (query: string) => searchCaptionEmojis(search, query, emojiRefForGlyph).map((entry) => entry.id);

describe("picker search", () => {
  test("an empty query lists every design", () => {
    expect(ids("  ").length).toBe(1412);
  });

  test("matches the name, as a prefix while typing", () => {
    expect(ids("money bag")[0]).toBe("money-bag");
    expect(ids("mon")).toContain("money-bag");
  });

  test("matches keywords, not only names", () => {
    const entry = CAPTION_EMOJI_INDEX.find((candidate) => candidate.kind === "phrase" && candidate.keywords.includes("coffee"))!;
    expect(ids("coffee")).toContain(entry.id);
  });

  test("a pasted glyph finds its design first, then the phrase badges that contain it", () => {
    const found = ids("🔥");
    expect(found[0]).toBe("flame");
    expect(found.length).toBeGreaterThan(1);
    expect(found.slice(1).every((id) => CAPTION_EMOJI_INDEX.find((entry) => entry.id === id)!.kind === "phrase")).toBe(true);
  });

  test("a glyph with a skin tone or a gender sign maps to its design", () => {
    expect(ids("👍🏽")[0]).toBe(emojiRefForGlyph("👍")!.id);
    expect(ids("🏃‍♂️")[0]).toBe(emojiRefForGlyph("🏃")!.id);
  });

  test("a skin-tone variant's own name finds its design and names the tone", () => {
    expect(ids("Waving hand: dark skin tone")[0]).toBe("waving-hand");
    expect(captionEmojiQueryTone("Waving hand: dark skin tone", emojiRefForGlyph)).toBe(5);
    expect(captionEmojiQueryTone("thumbs up medium-light skin tone", emojiRefForGlyph)).toBe(2);
    expect(captionEmojiQueryTone("medium skin tone", emojiRefForGlyph)).toBe(3);
    // A tone alone lists every design that has tones.
    expect(ids("dark skin tone").length).toBe(CAPTION_EMOJI_INDEX.filter((entry) => entry.hasTones).length);
    expect(captionEmojiQueryTone("waving hand", emojiRefForGlyph)).toBeNull();
  });

  test("a pasted glyph with a skin-tone modifier names its tone; a badge's pair finds the badge", () => {
    expect(captionEmojiQueryTone("👋🏿", emojiRefForGlyph)).toBe(5);
    expect(captionEmojiQueryTone("👋", emojiRefForGlyph)).toBeNull();
    expect(ids("☕⏰")[0]).toBe("morning-coffee");
  });

  test("a badge is found by its caption's words", () => {
    expect(ids("time for my morning coffee")[0]).toBe("morning-coffee");
  });

  test("an exact name ranks first even when other names share its words", () => {
    for (const entry of CAPTION_EMOJI_INDEX) expect(ids(entry.name)[0]).toBe(entry.id);
  });

  test("stop words are ignored unless they are all there is", () => {
    expect(ids("the money bag")[0]).toBe("money-bag");
    expect(ids("zzqx")).toEqual([]);
  });

  test("normalises case, apostrophes and punctuation", () => {
    expect(searchableText("Don’t   STOP!")).toBe("dont stop");
  });
});

describe("picker layout and keys", () => {
  const sections = [
    { id: "a", label: "A", items: CAPTION_EMOJI_INDEX.slice(0, 10) },
    { id: "empty", label: "Empty", items: [] },
    { id: "b", label: "B", items: CAPTION_EMOJI_INDEX.slice(10, 13) },
  ];
  const layout = pickerLayout(sections, 8, { header: 30, row: 40 });

  test("headers and cell rows stack; empty sections are skipped", () => {
    expect(layout.rows.map((row) => row.kind)).toEqual(["header", "cells", "cells", "header", "cells"]);
    expect(layout.height).toBe(30 + 40 + 40 + 30 + 40);
    expect([...layout.sectionTops]).toEqual([["a", 0], ["b", 110]]);
  });

  test("only rows near the viewport are drawn", () => {
    expect(visibleRows(layout, 0, 50, 0)).toEqual([0, 2]);
    expect(visibleRows(layout, 120, 30, 0)).toEqual([3, 5]);
  });

  test("arrows keep the column across rows and sections, clamped to short rows", () => {
    expect(moveInGrid(layout, 1, "down")).toBe(9);
    expect(moveInGrid(layout, 9, "down")).toBe(11);
    expect(moveInGrid(layout, 7, "down")).toBe(9);
    expect(moveInGrid(layout, 12, "up")).toBe(9);
    expect(moveInGrid(layout, 0, "left")).toBe(0);
    expect(moveInGrid(layout, 12, "right")).toBe(12);
    expect(moveInGrid(layout, 5, "end")).toBe(12);
  });
});

describe("picked refs and recents", () => {
  test("a pick stores its tone for designs with skin, the default yellow included, and none for others", () => {
    const hand = CAPTION_EMOJI_INDEX.find((entry) => entry.hasTones)!;
    const plain = CAPTION_EMOJI_INDEX.find((entry) => !entry.hasTones)!;
    expect(pickedEmojiRef(hand, 3)).toEqual({ id: hand.id, tone: 3 });
    expect(pickedEmojiRef(hand, 0)).toEqual({ id: hand.id, tone: 0 });
    expect(pickedEmojiRef(plain, 3)).toEqual({ id: plain.id });
  });

  test("the picker opens at the emoji's own tone, else the clip's Skin tone", () => {
    expect(pickerStartTone(null, undefined)).toBe(0);
    expect(pickerStartTone(null, 4)).toBe(4);
    expect(pickerStartTone({}, 4)).toBe(4);
    expect(pickerStartTone({ tone: 0 }, 4)).toBe(0);
    expect(pickerStartTone({ tone: 2 }, 4)).toBe(2);
  });

  test("the groups hold every design once, in the picker's order with phrases last", () => {
    const groups = captionEmojiPickerGroups(CAPTION_EMOJI_INDEX, CAPTION_EMOJI_GROUPS);
    expect(groups.map((group) => group.id)).toEqual(["smileys", "people", "hands", "animals-and-nature", "food-and-drink", "activities", "travel-and-places", "objects", "symbols", "phrases"]);
    expect(groups.reduce((sum, group) => sum + group.items.length, 0)).toBe(1412);
    expect(groups.at(-1)!.items).toHaveLength(400);
  });

  test("recents move a pick to the front and keep sixteen", () => {
    const many = Array.from({ length: 16 }, (_, at) => `e${at}`);
    expect(withRecentEmoji(many, "e5").slice(0, 2)).toEqual(["e5", "e0"]);
    expect(withRecentEmoji(many, "new")).toHaveLength(16);
  });
});
