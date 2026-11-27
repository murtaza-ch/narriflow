import { describe, expect, test } from "bun:test";
import {
  CAPTION_EMOJI_DENSITIES,
  CAPTION_EMOJI_DENSITY_MIN_STRENGTH,
  CAPTION_EMOJI_INK,
  CAPTION_EMOJI_LIMIT,
  CAPTION_EMOJI_MIN_BODY_CHROMA,
  CAPTION_EMOJI_MIN_BODY_DETAIL,
  CAPTION_EMOJI_MIN_BODY_INK,
  CAPTION_EMOJI_MIN_DETAIL_INK,
  CAPTION_EMOJI_MIN_RIM_APART,
  CAPTION_EMOJI_MIN_RIM_BODY,
  CAPTION_EMOJI_MIN_BODY_WHITE,
  CAPTION_EMOJI_PALETTES,
  CAPTION_EMOJI_REPEAT_GAP_SEC,
  CAPTION_EMOJI_STICKER_WHITE,
  captionEmojiColourDistance,
  captionEmojiDrawnTone,
  captionEmojiColourLch,
  captionEmojiPalette,
  captionEmojiTemplateColours,
  captionEmojiPaletteSchema,
  captionEmojiRefOnWord,
  captionEmojiRefSchema,
  CAPTION_EMOJI_WORD_MAX_LENGTH,
  captionEmojisSchema,
  captionWordComparable,
  resolveCaptionEmojiAnchors,
  resolveCaptionEmojiPalette,
  selectCaptionEmojiPicks,
  type CaptionEmojiAnchorWord,
  type CaptionEmojiPick,
} from "./caption-emojis";
import { CAPTION_PRESETS, getCaptionPresetById } from "./caption-preset";

describe("caption emoji schemas", () => {
  test("an emoji is drawn in its own tone, else the preset's Skin tone, else the default yellow", () => {
    expect(captionEmojiDrawnTone({}, {})).toBe(0);
    expect(captionEmojiDrawnTone({}, { emojiTone: 4 })).toBe(4);
    expect(captionEmojiDrawnTone({ tone: 2 }, { emojiTone: 4 })).toBe(2);
    // A hand pick of the default yellow keeps it whatever the setting says.
    expect(captionEmojiDrawnTone({ tone: 0 }, { emojiTone: 4 })).toBe(0);
  });

  test("a ref is a kebab slug with an optional tone 0 to 5 (0: the default yellow chosen by hand)", () => {
    expect(captionEmojiRefSchema.safeParse({ id: "heart-eyes" }).success).toBe(true);
    expect(captionEmojiRefSchema.safeParse({ id: "thumbs-up", tone: 5 }).success).toBe(true);
    expect(captionEmojiRefSchema.safeParse({ id: "thumbs-up", tone: 0 }).success).toBe(true);
    for (const bad of [{ id: "" }, { id: "Heart" }, { id: "heart_eyes" }, { id: "-heart" }, { id: "a".repeat(81) }, { id: "ok", tone: -1 }, { id: "ok", tone: 6 }, { id: "ok", tone: 1.5 }, { id: "ok", extra: 1 }]) {
      expect(captionEmojiRefSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("a ref may store the text of its word; every writer stores it through captionEmojiRefOnWord", () => {
    expect(captionEmojiRefSchema.safeParse({ id: "party", word: "party!" }).success).toBe(true);
    expect(captionEmojiRefSchema.safeParse({ id: "party", word: "" }).success).toBe(false);
    expect(captionEmojiRefSchema.safeParse({ id: "party", word: "a".repeat(CAPTION_EMOJI_WORD_MAX_LENGTH + 1) }).success).toBe(false);
    expect(captionEmojiRefOnWord({ id: "party", tone: 2, word: "old" }, "دعوت")).toEqual({ id: "party", tone: 2, word: "دعوت" });
    // A text the schema cannot hold is left out, and the entry attaches by time.
    expect(captionEmojiRefOnWord({ id: "party", word: "old" }, "")).toEqual({ id: "party" });
    expect(captionEmojiRefOnWord({ id: "party" }, "a".repeat(CAPTION_EMOJI_WORD_MAX_LENGTH + 1))).toEqual({ id: "party" });
  });

  test("emojis are keyed by whole-millisecond Word Keys, at most 500", () => {
    expect(captionEmojisSchema.safeParse({ "1200": { id: "fire" } }).success).toBe(true);
    expect(captionEmojisSchema.safeParse({ "1.2": { id: "fire" } }).success).toBe(false);
    const entries = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [String(index), { id: "fire" }]));
    expect(captionEmojisSchema.safeParse(entries(CAPTION_EMOJI_LIMIT)).success).toBe(true);
    expect(captionEmojisSchema.safeParse(entries(CAPTION_EMOJI_LIMIT + 1)).success).toBe(false);
  });

  test("a palette is three hex colours", () => {
    expect(captionEmojiPaletteSchema.safeParse({ a: "#FFE45C", b: "#ff4f9a", c: "#ffffff" }).success).toBe(true);
    expect(captionEmojiPaletteSchema.safeParse({ a: "#FFE45C", b: "#ff4f9a" }).success).toBe(false);
    expect(captionEmojiPaletteSchema.safeParse({ a: "yellow", b: "#ff4f9a", c: "#ffffff" }).success).toBe(false);
  });
});

describe("captionEmojiPalette", () => {
  test("maps highlight, accent and primary to a, b and c when they separate", () => {
    expect(captionEmojiPalette({ primary: "#FFFFFF", highlight: "#FFE45C", accent: "#FF4F9A", shadow: "#000000" }))
      .toEqual({ a: "#ffe45c", b: "#ff4f9a", c: "#ffffff" });
  });

  test("the owner's palettes clear every threshold", () => {
    for (const { palette } of CAPTION_EMOJI_PALETTES) {
      expect(captionEmojiPaletteSchema.parse(palette)).toEqual(palette);
      expect(captionEmojiColourDistance(palette.a, CAPTION_EMOJI_INK)).toBeGreaterThanOrEqual(CAPTION_EMOJI_MIN_BODY_INK);
      expect(captionEmojiColourDistance(palette.a, palette.c)).toBeGreaterThanOrEqual(CAPTION_EMOJI_MIN_BODY_DETAIL);
      expect(captionEmojiColourDistance(palette.b, palette.a)).toBeGreaterThanOrEqual(CAPTION_EMOJI_MIN_RIM_BODY);
    }
  });

  test("a body equal to the detail takes the accent; a body on the ink takes a fallback", () => {
    expect(captionEmojiPalette({ primary: "#FFFFFF", highlight: "#FFFFFF", accent: "#FF4F9A", shadow: "#000000" }).a).toBe("#ff4f9a");
    const dark = captionEmojiPalette({ primary: "#FFFFFF", highlight: "#271E35", accent: "#1A1A1A", shadow: "#000000" });
    expect(dark.a).toBe("#ffe45c");
  });

  test("a rim equal to the body is derived as a clean shade of it: darker, as saturated, its hue turned warm to red and cool to blue-violet", () => {
    const shade = (body: string) => {
      const palette = captionEmojiPalette({ primary: "#FFFFFF", highlight: body, accent: body, shadow: "#000000" });
      expect(palette.a).toBe(body.toLowerCase());
      expect(captionEmojiColourDistance(palette.b, palette.a)).toBeGreaterThanOrEqual(CAPTION_EMOJI_MIN_RIM_BODY);
      const [from, to] = [captionEmojiColourLch(palette.a), captionEmojiColourLch(palette.b)];
      expect(to.l).toBeLessThan(from.l - 0.15);
      return { from, to };
    };
    // A yellow body gets an orange rim, never an olive one (ticket 12's rule made #ffd248 into #b3963e).
    const yellow = shade("#FFD248");
    expect(yellow.to.h).toBeGreaterThan(50);
    expect(yellow.to.h).toBeLessThan(75);
    expect(yellow.to.c).toBeGreaterThanOrEqual(yellow.from.c);
    // A pink turns toward red, a red stays red and goes deep.
    const pink = shade("#FF4FA3");
    const turn = (pink.to.h - pink.from.h + 360) % 360;
    expect(turn).toBeGreaterThan(5);
    expect(turn).toBeLessThanOrEqual(35);
    const red = shade("#D7263D");
    expect(Math.abs(red.to.h - red.from.h)).toBeLessThan(10);
    // Cool bodies turn toward blue-violet: lime toward green, cyan and blue toward violet.
    const lime = shade("#A3FF12");
    expect(lime.to.h).toBeGreaterThan(lime.from.h + 20);
    const blue = shade("#2F6BFF");
    expect(blue.to.h).toBeGreaterThan(blue.from.h);
    expect(blue.to.h).toBeLessThanOrEqual(285);
  });

  test("a body with too little colour, or near the sticker's white, is not used", () => {
    // Grey (Punch-like), silver-blue (Chrome) and cream (Premiere) highlights.
    for (const highlight of ["#9A9A9A", "#B4CEF2", "#FFF1D6"]) {
      expect(captionEmojiPalette({ primary: "#111111", highlight, accent: "#2F6BFF", shadow: "#000000" }).a).toBe("#2f6bff");
      expect(captionEmojiPalette({ primary: "#111111", highlight, accent: highlight, shadow: "#000000" }).a).toBe("#ffe45c");
    }
  });

  test("a white rim on white text is derived from the body: it would merge with the sticker outline", () => {
    // Electric and Reveal: white primary and accent.
    const palette = captionEmojiPalette({ primary: "#FFFFFF", highlight: "#FFFFFF", accent: "#FFFFFF", shadow: "#000000" });
    expect(palette.a).toBe("#ffe45c");
    expect(captionEmojiColourDistance(palette.b, CAPTION_EMOJI_STICKER_WHITE)).toBeGreaterThanOrEqual(CAPTION_EMOJI_MIN_RIM_APART);
    expect(captionEmojiColourDistance(palette.b, palette.c)).toBeGreaterThanOrEqual(CAPTION_EMOJI_MIN_RIM_APART);
    // Darker than the body, as the rim-from-body rule makes it, and orange.
    expect(captionEmojiColourDistance(palette.b, "#000000")).toBeLessThan(captionEmojiColourDistance(palette.a, "#000000"));
    expect(captionEmojiColourLch(palette.b).h).toBeLessThan(captionEmojiColourLch(palette.a).h - 20);
    // A near-white accent on a dark detail is moved off white too.
    const cream = captionEmojiPalette({ primary: "#111111", highlight: "#D7263D", accent: "#F4EFE6", shadow: "#000000" });
    expect(captionEmojiColourDistance(cream.b, CAPTION_EMOJI_STICKER_WHITE)).toBeGreaterThanOrEqual(CAPTION_EMOJI_MIN_RIM_APART);
  });

  test("dark caption text never becomes the detail: eye whites and teeth stay white so ink pupils show", () => {
    expect(captionEmojiPalette(captionEmojiTemplateColours(getCaptionPresetById("dossier")!.preset)).c).toBe("#ffffff");
    expect(captionEmojiPalette({ primary: "#22123C", highlight: "#FF8ADB", accent: "#8B9BFF", shadow: "#000000" }).c).toBe("#ffffff");
    // Light or coloured text still is the detail.
    expect(captionEmojiPalette({ primary: "#EF5849", highlight: "#F4B33D", accent: "#9E4B00", shadow: "#000000" }).c).toBe("#ef5849");
  });

  test("the owner's palettes and a preset's own palette are never altered (Candy keeps its white rim)", () => {
    const colours = { primary: "#FFFFFF", highlight: "#FFFFFF", accent: "#FFFFFF", shadow: "#000000" };
    for (const { palette } of CAPTION_EMOJI_PALETTES) expect(resolveCaptionEmojiPalette({ emojiPalette: palette }, colours)).toEqual(palette);
    expect(CAPTION_EMOJI_PALETTES[2].palette.b).toBe("#ffffff");
  });

  test("the separation invariants hold for every catalog preset", () => {
    const worst = { bodyWhite: { id: "", value: Infinity }, bodyChroma: { id: "", value: Infinity }, bodyInk: { id: "", value: Infinity }, bodyDetail: { id: "", value: Infinity }, rimBody: { id: "", value: Infinity }, rimDetail: { id: "", value: Infinity }, rimWhite: { id: "", value: Infinity } };
    const note = (slot: keyof typeof worst, id: string, value: number) => {
      if (value < worst[slot].value) worst[slot] = { id, value };
    };
    for (const named of CAPTION_PRESETS) {
      const colours = captionEmojiTemplateColours(named.preset);
      const palette = captionEmojiPalette(colours);
      expect(captionEmojiPalette(colours)).toEqual(palette);
      expect(captionEmojiPaletteSchema.safeParse(palette).success).toBe(true);
      const bodyInk = captionEmojiColourDistance(palette.a, CAPTION_EMOJI_INK);
      const bodyDetail = captionEmojiColourDistance(palette.a, palette.c);
      const rimBody = captionEmojiColourDistance(palette.b, palette.a);
      const bodyWhite = captionEmojiColourDistance(palette.a, CAPTION_EMOJI_STICKER_WHITE);
      const bodyChroma = captionEmojiColourLch(palette.a).c;
      expect(bodyWhite).toBeGreaterThanOrEqual(CAPTION_EMOJI_MIN_BODY_WHITE);
      expect(bodyChroma).toBeGreaterThanOrEqual(CAPTION_EMOJI_MIN_BODY_CHROMA);
      note("bodyWhite", named.id, bodyWhite);
      note("bodyChroma", named.id, bodyChroma);
      expect(bodyInk).toBeGreaterThanOrEqual(CAPTION_EMOJI_MIN_BODY_INK);
      expect(bodyDetail).toBeGreaterThanOrEqual(CAPTION_EMOJI_MIN_BODY_DETAIL);
      expect(captionEmojiColourDistance(palette.c, CAPTION_EMOJI_INK)).toBeGreaterThanOrEqual(CAPTION_EMOJI_MIN_DETAIL_INK);
      expect(rimBody).toBeGreaterThanOrEqual(CAPTION_EMOJI_MIN_RIM_BODY);
      const rimDetail = captionEmojiColourDistance(palette.b, palette.c);
      const rimWhite = captionEmojiColourDistance(palette.b, CAPTION_EMOJI_STICKER_WHITE);
      expect(rimDetail).toBeGreaterThanOrEqual(CAPTION_EMOJI_MIN_RIM_APART);
      expect(rimWhite).toBeGreaterThanOrEqual(CAPTION_EMOJI_MIN_RIM_APART);
      note("bodyInk", named.id, bodyInk);
      note("bodyDetail", named.id, bodyDetail);
      note("rimBody", named.id, rimBody);
      note("rimDetail", named.id, rimDetail);
      note("rimWhite", named.id, rimWhite);
    }
    expect(CAPTION_PRESETS.length).toBe(125);
    if (process.env.CAPTION_EMOJI_PALETTE_REPORT) console.log(JSON.stringify(worst));
  });

  test("under Match template every design takes the template palette, faces included; a named or Custom palette applies as given", () => {
    for (const named of CAPTION_PRESETS) {
      const colours = captionEmojiTemplateColours(named.preset);
      expect(resolveCaptionEmojiPalette({}, colours)).toEqual(captionEmojiPalette(colours));
    }
    const colours = { primary: "#FFFFFF", highlight: "#00FF88", accent: "#000000", shadow: "#000000" };
    expect(resolveCaptionEmojiPalette({}, colours)).toEqual({ a: "#00ff88", b: "#000000", c: "#ffffff" });
    expect(resolveCaptionEmojiPalette({ emojiPalette: { a: "#00ff00", b: "#003300", c: "#ffffff" } }, colours)).toEqual({ a: "#00ff00", b: "#003300", c: "#ffffff" });
  });

  test("a preset's own palette wins over the template's", () => {
    const colours = { primary: "#FFFFFF", highlight: "#FFE45C", accent: "#FF4F9A", shadow: "#000000" };
    const retro = CAPTION_EMOJI_PALETTES[3].palette;
    expect(resolveCaptionEmojiPalette({ emojiPalette: retro }, colours)).toEqual(retro);
    expect(resolveCaptionEmojiPalette({}, colours)).toEqual(captionEmojiPalette(colours));
  });
});

describe("selectCaptionEmojiPicks", () => {
  const words = Array.from({ length: 100 }, (_, index) => ({ key: String(1000 + index * 500), editedStartSec: index * 0.5 }));
  const pick = (index: number, id: string, strength: number): CaptionEmojiPick => ({ key: words[index]!.key, ref: { id }, strength });

  test("drops picks on words the clip does not keep", () => {
    expect(selectCaptionEmojiPicks([{ key: "999999", ref: { id: "fire" }, strength: 3 }, pick(10, "rocket", 2)], words, "balanced"))
      .toEqual({ [words[10]!.key]: { id: "rocket" } });
  });

  test("keeps one pick per minimum gap: the stronger wins, the earlier wins a tie", () => {
    expect(CAPTION_EMOJI_DENSITIES).toEqual({ light: 3.5, balanced: 2, expressive: 1.2 });
    // 8 s and 9 s are 1 s apart, inside the 2 s balanced gap.
    expect(Object.keys(selectCaptionEmojiPicks([pick(16, "fire", 2), pick(18, "rocket", 3)], words, "balanced"))).toEqual([words[18]!.key]);
    expect(Object.keys(selectCaptionEmojiPicks([pick(18, "rocket", 2), pick(16, "fire", 2)], words, "balanced"))).toEqual([words[16]!.key]);
    // Expressive (1.2 s) keeps 8 s and 9.5 s; Balanced keeps one.
    expect(Object.keys(selectCaptionEmojiPicks([pick(16, "fire", 2), pick(19, "rocket", 3)], words, "expressive"))).toHaveLength(2);
    expect(Object.keys(selectCaptionEmojiPicks([pick(16, "fire", 2), pick(19, "rocket", 3)], words, "balanced"))).toEqual([words[19]!.key]);
    // Light (3.5 s) keeps one of 8 s and 11 s, and both of 8 s and 12 s.
    expect(Object.keys(selectCaptionEmojiPicks([pick(16, "fire", 3), pick(22, "rocket", 3)], words, "light"))).toEqual([words[16]!.key]);
    expect(Object.keys(selectCaptionEmojiPicks([pick(16, "fire", 3), pick(24, "rocket", 3)], words, "light"))).toHaveLength(2);
  });

  test("density is a strength gate first: Light keeps strengths 2 and 3, Balanced and Expressive every strength", () => {
    expect(CAPTION_EMOJI_DENSITY_MIN_STRENGTH).toEqual({ light: 2, balanced: 1, expressive: 1 });
    // 2 s, 8 s and 14 s: far enough apart for every density's gap.
    const picks = [pick(4, "wave", 1), pick(16, "fire", 2), pick(28, "rocket", 3)];
    expect(Object.values(selectCaptionEmojiPicks(picks, words, "light")).map((ref) => ref.id)).toEqual(["fire", "rocket"]);
    expect(Object.values(selectCaptionEmojiPicks(picks, words, "balanced")).map((ref) => ref.id)).toEqual(["wave", "fire", "rocket"]);
    expect(Object.values(selectCaptionEmojiPicks(picks, words, "expressive")).map((ref) => ref.id)).toEqual(["wave", "fire", "rocket"]);
    // The gate holds with nothing near: a lone strength-1 pick is not kept at Light.
    expect(selectCaptionEmojiPicks([pick(14, "wave", 1)], words, "light")).toEqual({});
  });

  test("the same emoji does not repeat within 6 s", () => {
    expect(CAPTION_EMOJI_REPEAT_GAP_SEC).toBe(6);
    const kept = selectCaptionEmojiPicks([pick(8, "fire", 3), pick(18, "fire", 3), pick(22, "fire", 3)], words, "balanced");
    // 4 s, 9 s and 11 s: 9 s is 5 s after 4 s, 11 s is 7 s after it, so 4 s and 11 s stay.
    expect(Object.keys(kept)).toEqual([words[8]!.key, words[22]!.key]);
    // Another design 5 s later is kept.
    expect(Object.keys(selectCaptionEmojiPicks([pick(8, "fire", 3), pick(18, "rocket", 3)], words, "balanced"))).toEqual([words[8]!.key, words[18]!.key]);
  });

  test("the opening pick wins only a tie: a weaker hook never displaces a stronger neighbour", () => {
    // 2.5 s and 4 s are inside one balanced gap (2 s).
    expect(Object.keys(selectCaptionEmojiPicks([pick(8, "rocket", 3), pick(5, "wave", 2)], words, "balanced"))).toEqual([words[8]!.key]);
    expect(Object.keys(selectCaptionEmojiPicks([pick(8, "rocket", 2), pick(5, "wave", 2)], words, "balanced"))).toEqual([words[5]!.key]);
  });

  test("is deterministic and independent of input order", () => {
    const picks = [pick(1, "wave", 2), pick(7, "fire", 3), pick(12, "brain", 2), pick(13, "rocket", 2), pick(30, "fire", 2), pick(39, "trophy", 3)];
    const once = selectCaptionEmojiPicks(picks, words, "balanced");
    expect(selectCaptionEmojiPicks([...picks].reverse(), words, "balanced")).toEqual(once);
    // 6.5 s is inside brain's gap; the second fire is 11.5 s after the first.
    expect(once).toEqual({
      [words[1]!.key]: { id: "wave" },
      [words[7]!.key]: { id: "fire" },
      [words[12]!.key]: { id: "brain" },
      [words[30]!.key]: { id: "fire" },
      [words[39]!.key]: { id: "trophy" },
    });
  });
});

describe("captionWordComparable", () => {
  test("case, punctuation and compatibility forms do not make a different word; letters and marks do", () => {
    expect(captionWordComparable("Party!")).toBe(captionWordComparable("party"));
    expect(captionWordComparable("ＰＡＲＴＹ")).toBe("party");
    expect(captionWordComparable("hospital")).not.toBe(captionWordComparable("party"));
    // Hindi "कि" and "की" differ only in a vowel sign (a mark).
    expect(captionWordComparable("कि")).not.toBe(captionWordComparable("की"));
    expect(captionWordComparable("کیا؟")).toBe("کیا");
  });
});

describe("resolveCaptionEmojiAnchors", () => {
  const word = (key: string, sourceStartSec: number, utteranceIndex: number, span: [number, number], text?: string): CaptionEmojiAnchorWord =>
    ({ key, sourceStartSec, utteranceIndex, utteranceStartSec: span[0], utteranceEndSec: span[1], ...(text === undefined ? {} : { text }) });
  /** Entries without a stored word: they attach by time alone. */
  const entries = (...keys: string[]) => Object.fromEntries(keys.map((key) => [key, { id: "flame" }]));
  const words = [
    word("1000", 1, 0, [1, 2], "We"),
    word("1400", 1.4, 0, [1, 2], "party"),
    word("1800", 1.8, 0, [1, 2], "tonight."),
    word("2100", 2.1, 1, [2.1, 3], "Hospital"),
    word("2600", 2.6, 1, [2.1, 3], "visit."),
  ];

  test("an exact key wins", () => {
    expect(resolveCaptionEmojiAnchors(entries("1400"), words)).toEqual(new Map([["1400", 1]]));
  });

  test("a re-timed word is found by the nearest start within 400 ms", () => {
    expect(resolveCaptionEmojiAnchors(entries("1450"), words)).toEqual(new Map([["1450", 1]]));
    expect(resolveCaptionEmojiAnchors(entries("2950"), words)).toEqual(new Map([["2950", 4]]));
    expect(resolveCaptionEmojiAnchors(entries("5000"), words).size).toBe(0);
  });

  test("stays inside the utterance whose span holds the key", () => {
    // 1990 ms is 110 ms from 2100 (the next line) but inside utterance 0: it takes 1800.
    expect(resolveCaptionEmojiAnchors(entries("1990"), words)).toEqual(new Map([["1990", 2]]));
  });

  test("overlapping speakers: every utterance whose span holds the key counts", () => {
    // Utterance 0 spans 1.0-3.0 s; utterance 1 starts inside it. Key 2100 (re-timed from 2050) is 50 ms
    // from utterance 1's word and 800 ms from utterance 0's nearest.
    const overlapping = [word("1000", 1, 0, [1, 3]), word("2900", 2.9, 0, [1, 3]), word("2050", 2.05, 1, [2.05, 4])];
    expect(resolveCaptionEmojiAnchors(entries("2100"), overlapping)).toEqual(new Map([["2100", 2]]));
  });

  test("two entries on one word: the nearer keeps it", () => {
    expect(resolveCaptionEmojiAnchors(entries("1500", "1420"), words)).toEqual(new Map([["1420", 1]]));
    expect(resolveCaptionEmojiAnchors(entries("1400", "1420"), words)).toEqual(new Map([["1400", 1]]));
  });

  test("an entry that stores its word re-attaches only to a word with that text, its exact key's word included", () => {
    // Re-timed by 50 ms, same word: found. Case and punctuation do not matter.
    expect(resolveCaptionEmojiAnchors({ "1450": { word: "Party!" } }, words)).toEqual(new Map([["1450", 1]]));
    // The word at 1.4 s was rewritten: nothing within 400 ms says "dancing", so it draws nowhere (it used to move to "party").
    expect(resolveCaptionEmojiAnchors({ "1450": { word: "dancing" } }, words).size).toBe(0);
    // A rewrite in place keeps the key but not the word: the entry does not draw on the new word.
    expect(resolveCaptionEmojiAnchors({ "2100": { word: "party" } }, words).size).toBe(0);
    // It skips a nearer word with other text for the same word further away, still within 400 ms and its utterance.
    expect(resolveCaptionEmojiAnchors({ "1600": { word: "tonight" } }, words)).toEqual(new Map([["1600", 2]]));
    // A word with no text to check (an untimed utterance) is matched by time.
    const untimed = [word("5000", 5, 3, [5, 9])];
    expect(resolveCaptionEmojiAnchors({ "5000": { word: "anything" } }, untimed)).toEqual(new Map([["5000", 0]]));
  });
});
