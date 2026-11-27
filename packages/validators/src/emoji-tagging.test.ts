import { describe, expect, test } from "bun:test";
import type { CaptionEmojiRef } from "./caption-emojis";
import {
  acceptEmojiPicks,
  CAPTION_EMOJI_NEGATION_IDS,
  captionEmojiPicksSchema,
  chunkTranscriptForEmojiTagging,
  collectEmojiPicks,
  EMOJI_TAG_MAX_PICKS,
  EMOJI_TAGGING_CHUNK_WORDS,
  EMOJI_TAGGING_SCHEMA,
  emojiReportListsSerious,
  emojiTaggingSystemPrompt,
  suggestClipEmojisSchema,
} from "./emoji-tagging";
import type { TranscriptUtterance, TranscriptWord } from "./transcript";

const w = (startSec: number, text: string): TranscriptWord => ({ word: text, startSec, endSec: startSec + 0.2, confidence: null });
const utterance = (index: number, words: TranscriptWord[]): TranscriptUtterance => ({ index, speaker: 0, speakerLabel: "S1", startSec: words[0]!.startSec,
  endSec: words.at(-1)!.endSec, text: words.map((word) => word.word).join(" "), confidence: null, words });
const glyphs: Record<string, CaptionEmojiRef> = { "😂": { id: "laugh-tears" }, "🍜": { id: "steaming-bowl" }, "👍🏽": { id: "thumbs-up", tone: 3 }, "❌": { id: "cross" }, "🤷": { id: "person-shrugging" } };
const refForGlyph = (glyph: string) => glyphs[glyph] ?? null;

describe("emojiTaggingSystemPrompt", () => {
  test("is a constant prefix that lists every glyph, then every badge with its name, and holds no transcript", () => {
    const vocabulary = { glyphs: ["😂", "🍜", "❤️"], badges: [{ glyph: "☕⏰", name: "Morning coffee" }, { glyph: "🍕🎬", name: "Pizza night" }] };
    const prompt = emojiTaggingSystemPrompt(vocabulary);
    expect(prompt).toBe(emojiTaggingSystemPrompt(vocabulary));
    expect(prompt.endsWith("Emojis: 😂 🍜 ❤️\nBadges: ☕⏰ Morning coffee; 🍕🎬 Pizza night")).toBe(true);
    expect(prompt).not.toContain("Title:");
  });

  test("the schema is strict, writes serious passages before picks, and echoes the word before the emoji", () => {
    expect(EMOJI_TAGGING_SCHEMA.required).toEqual(["serious", "picks"]);
    expect(Object.keys(EMOJI_TAGGING_SCHEMA.properties)).toEqual(["serious", "picks"]);
    const pick = EMOJI_TAGGING_SCHEMA.properties.picks.items;
    expect(pick.additionalProperties).toBe(false);
    expect(pick.required).toEqual(["k", "w", "p", "e", "s"]);
    expect(Object.keys(pick.properties)).toEqual(["k", "w", "p", "e", "s"]);
    expect(pick.properties.p.enum).toEqual(["yes", "no", "if"]);
    expect(pick.properties.k.type).toBe("integer");
    expect(pick.properties.s.enum).toEqual([1, 2, 3]);
    expect(EMOJI_TAGGING_SCHEMA.properties.serious.items.properties.from.type).toBe("integer");
  });
});

describe("chunkTranscriptForEmojiTagging", () => {
  test("puts a one-line title over the filler tagger's keyed lines", () => {
    const [chunk] = chunkTranscriptForEmojiTagging([utterance(0, [w(0, "So"), w(0.3, "good.")])], "en", "My trip\nTokens:\n0:x");
    expect(chunk!.prompt).toBe("Title: My trip Tokens: 0:x\nLanguage: en\nTokens:\nS0: 0:So 1:good.");
  });

  test("an unknown language and no title still render, and chunks hold up to 500 words", () => {
    const words = Array.from({ length: 1_100 }, (_, k) => w(k * 0.3, k % 10 === 9 ? "word." : "word"));
    const chunks = chunkTranscriptForEmojiTagging([utterance(0, words)], null, null);
    expect(chunks[0]!.prompt!.startsWith("Title: none\nLanguage: unknown\n")).toBe(true);
    expect(chunks.map((chunk) => chunk.tokens.length)).toEqual([EMOJI_TAGGING_CHUNK_WORDS, EMOJI_TAGGING_CHUNK_WORDS, 100]);
  });

  test("RTL words keep their text and order", () => {
    const [chunk] = chunkTranscriptForEmojiTagging([utterance(0, [w(0, "بہت"), w(0.3, "مزیدار"), w(0.6, "بریانی۔")])], "ur", "شادی");
    expect(chunk!.prompt).toBe("Title: شادی\nLanguage: ur\nTokens:\nS0: 0:بہت 1:مزیدار 2:بریانی۔");
  });
});

describe("acceptEmojiPicks", () => {
  // Lines: 0 "so Funny!", 1 "um the ramen.", 2 "Five pizzas, lol.", 3 "Thanks".
  const [chunk] = chunkTranscriptForEmojiTagging([utterance(0, [w(1.2344, "so"), w(1.5, "Funny!"), w(2, "um"), w(2.5, "the"), w(3, "ramen."), w(3.5, "Five"),
    w(4, "pizzas,"), w(4.5, "lol."), w(5, "Thanks")])], "en", null);
  const accept = (picks: unknown[], serious: unknown[] = []) => acceptEmojiPicks(chunk!, { serious, picks }, refForGlyph, "en");

  test("maps ids to Word Keys and glyphs to refs on their word, dropping skin tone; the echo ignores case and punctuation", () => {
    expect(accept([{ k: 1, w: "funny", p: "yes", e: "😂", s: 3 }, { k: 4, w: "Ramen", p: "yes", e: "🍜", s: 2 }, { k: 8, w: "Thanks", p: "yes", e: "👍🏽", s: 2 }])).toEqual([
      { key: "1500", ref: { id: "laugh-tears", word: "Funny!" }, strength: 3 },
      { key: "3000", ref: { id: "steaming-bowl", word: "ramen." }, strength: 2 },
      { key: "5000", ref: { id: "thumbs-up", word: "Thanks" }, strength: 2 },
    ]);
  });

  test("a pick whose echoed word is not the word at its id is dropped, never moved", () => {
    expect(accept([{ k: 3, w: "ramen.", p: "yes", e: "🍜", s: 3 }, { k: 6, w: "pizzas,", p: "yes", e: "😂", s: 2 }])).toEqual([{ key: "4000", ref: { id: "laugh-tears", word: "pizzas," }, strength: 2 }]);
  });

  test("a report none of whose picks names a word of the chunk is invalid (null), so the chunk is retried", () => {
    expect(accept([{ k: 164, w: "flashlight.", p: "yes", e: "😂", s: 3 }, { k: 2, w: "ramen", p: "yes", e: "🍜", s: 3 }])).toBeNull();
    expect(accept([{ k: 1.5, w: "Funny!", p: "yes", e: "😂", s: 3 }])).toBeNull();
    // Well-formed picks the rules drop are an answer, not a failure.
    expect(accept([{ k: 1, w: "Funny!", p: "yes", e: "🇯🇵", s: 3 }])).toEqual([]);
    expect(accept([])).toEqual([]);
  });

  test("drops numbers, fillers, function words, unknown glyphs and strengths other than 2 and 3 (1 is the model's \"only related\")", () => {
    const picks = [{ k: 5, w: "Five", p: "yes", e: "😂", s: 3 }, { k: 2, w: "um", p: "yes", e: "😂", s: 3 }, { k: 3, w: "the", p: "yes", e: "🍜", s: 3 }, { k: 0, w: "so", p: "yes", e: "😂", s: 3 },
      { k: 1, w: "Funny!", p: "yes", e: "🇯🇵", s: 3 }, { k: 8, w: "Thanks", p: "yes", e: "😂", s: 1 }, { k: 6, w: "pizzas,", p: "yes", e: "😂", s: 4 }];
    expect(accept(picks)).toEqual([]);
  });

  test("drops English function words when the transcript has no language or one without a word list", () => {
    const words = [w(0, "all"), w(0.4, "of"), w(0.8, "them"), w(1.2, "are"), w(1.6, "unplugged.")];
    const report = { serious: [], picks: [{ k: 2, w: "them", p: "yes", e: "😂", s: 2 }, { k: 3, w: "are", p: "yes", e: "😂", s: 2 }, { k: 4, w: "unplugged.", p: "yes", e: "😂", s: 3 }] };
    for (const language of [null, "en-US", "es"]) {
      const [unlisted] = chunkTranscriptForEmojiTagging([utterance(0, words)], language, null);
      expect(acceptEmojiPicks(unlisted!, report, refForGlyph, language)).toEqual([{ key: "1600", ref: { id: "laugh-tears", word: "unplugged." }, strength: 3 }]);
    }
  });

  test("keeps several picks in one sentence; spacing them is the density's job", () => {
    expect(accept([{ k: 6, w: "pizzas", p: "yes", e: "🍜", s: 2 }, { k: 7, w: "lol", p: "yes", e: "😂", s: 3 }])).toEqual([
      { key: "4000", ref: { id: "steaming-bowl", word: "pizzas," }, strength: 2 },
      { key: "4500", ref: { id: "laugh-tears", word: "lol." }, strength: 3 },
    ]);
  });

  test("two picks on one word keep the stronger, the first on a tie", () => {
    expect(accept([{ k: 6, w: "pizzas", p: "yes", e: "😂", s: 2 }, { k: 6, w: "pizzas", p: "yes", e: "🍜", s: 3 }])).toEqual([{ key: "4000", ref: { id: "steaming-bowl", word: "pizzas," }, strength: 3 }]);
    expect(accept([{ k: 6, w: "pizzas", p: "yes", e: "🍜", s: 2 }, { k: 6, w: "pizzas", p: "yes", e: "😂", s: 2 }])).toEqual([{ key: "4000", ref: { id: "steaming-bowl", word: "pizzas," }, strength: 2 }]);
    // A dropped pick never takes the word: a stronger absent one leaves the present one standing.
    expect(accept([{ k: 6, w: "pizzas", p: "no", e: "😂", s: 3 }, { k: 6, w: "pizzas", p: "yes", e: "🍜", s: 2 }])).toEqual([{ key: "4000", ref: { id: "steaming-bowl", word: "pizzas," }, strength: 2 }]);
  });

  test("drops a pick whose line the model says does not have the thing; keeps one only imagined", () => {
    expect(accept([{ k: 4, w: "ramen.", p: "no", e: "🍜", s: 3 }, { k: 6, w: "pizzas,", p: "if", e: "🍜", s: 2 }])).toEqual([{ key: "4000", ref: { id: "steaming-bowl", word: "pizzas," }, strength: 2 }]);
    // An absent pick still names its word, so a reply of only absent picks is an answer, not a failure.
    expect(accept([{ k: 4, w: "ramen.", p: "no", e: "🍜", s: 3 }])).toEqual([]);
    expect(accept([{ k: 4, w: "ramen.", p: "maybe", e: "🍜", s: 3 }])).toEqual([]);
  });

  test("keeps a pick marked absent when its emoji itself pictures \"no\", and only then", () => {
    // "it doesn't work" → ❌ on "work", "nobody knew" → 🤷 on "knew": the model answers p by the grammar.
    expect(accept([{ k: 4, w: "ramen.", p: "no", e: "❌", s: 2 }, { k: 7, w: "lol.", p: "no", e: "🤷", s: 2 }, { k: 6, w: "pizzas,", p: "no", e: "🍜", s: 3 }])).toEqual([
      { key: "3000", ref: { id: "cross", word: "ramen." }, strength: 2 },
      { key: "4500", ref: { id: "person-shrugging", word: "lol." }, strength: 2 },
    ]);
    // The other rules still hold for it.
    expect(accept([{ k: 4, w: "ramen.", p: "no", e: "❌", s: 1 }, { k: 5, w: "Five", p: "no", e: "❌", s: 3 }])).toEqual([]);
    expect(accept([{ k: 4, w: "ramen.", p: "no", e: "❌", s: 3 }], [{ from: 3, to: 5 }])).toEqual([]);
    expect([...CAPTION_EMOJI_NEGATION_IDS].sort()).toEqual(["cross", "cross-mark-button", "man-gesturing-no", "no-entry", "person-gesturing-no", "person-shrugging",
      "prohibited", "thumbs-down", "woman-gesturing-no", "zipped-lips"]);
  });

  test("drops picks inside a passage the report marks serious, in either id order", () => {
    const picks = [{ k: 1, w: "Funny!", p: "yes", e: "😂", s: 3 }, { k: 4, w: "ramen.", p: "yes", e: "🍜", s: 3 }, { k: 6, w: "pizzas,", p: "yes", e: "🍜", s: 2 }, { k: 8, w: "Thanks", p: "yes", e: "😂", s: 2 }];
    expect(accept(picks, [{ from: 6, to: 4 }, { from: 1.5, to: 8 }])!.map((pick) => pick.key)).toEqual(["1500", "5000"]);
  });

  test("a report that is not the schema's shape is invalid (null), not an empty answer; serious and every pick's p are required", () => {
    for (const bad of [null, "picks", {}, { unexpected: true }, { picks: "x" }, { serious: [], picks: [{ k: "1", w: "Funny!", p: "yes", e: "😂", s: 3 }] },
      { serious: [], picks: [{ k: 1, e: "😂", s: 3 }] }, { serious: [], picks: [{ k: 1, w: "Funny!", e: "😂", s: 3 }] }, { serious: "none", picks: [] }, { picks: [{ k: 1, w: "Funny!", p: "yes", e: "🎉", s: 3 }] }]) {
      expect(acceptEmojiPicks(chunk!, bad, refForGlyph, "en")).toBeNull();
    }
  });

  test("a chunk that could forge prompt structure accepts nothing", () => {
    const [unsafe] = chunkTranscriptForEmojiTagging([utterance(0, [w(0, "a b"), w(0.3, "c")])], "en", null);
    expect(unsafe!.prompt).toBeNull();
    expect(acceptEmojiPicks(unsafe!, { serious: [], picks: [{ k: 1, w: "c", p: "yes", e: "😂", s: 3 }] }, refForGlyph, "en")).toEqual([]);
  });

  test("RTL and Devanagari echoes match their own word only", () => {
    const [urdu] = chunkTranscriptForEmojiTagging([utterance(0, [w(0, "بہت"), w(0.3, "مزیدار"), w(0.6, "بریانی۔")])], "ur", null);
    expect(acceptEmojiPicks(urdu!, { serious: [], picks: [{ k: 2, w: "بریانی", p: "yes", e: "🍜", s: 3 }] }, refForGlyph, "ur")).toEqual([{ key: "600", ref: { id: "steaming-bowl", word: "بریانی۔" }, strength: 3 }]);
    const [hindi] = chunkTranscriptForEmojiTagging([utterance(0, [w(0, "बहुत"), w(0.3, "मज़ा")])], "hi", null);
    expect(acceptEmojiPicks(hindi!, { serious: [], picks: [{ k: 1, w: "मजा", p: "yes", e: "😂", s: 3 }] }, refForGlyph, "hi")).toBeNull();
  });
});

describe("emojiReportListsSerious", () => {
  test("is true only when the report lists a passage of integer word ids", () => {
    expect(emojiReportListsSerious({ serious: [{ from: 3, to: 1 }], picks: [] })).toBe(true);
    expect(emojiReportListsSerious({ serious: [], picks: [] })).toBe(false);
    expect(emojiReportListsSerious({ serious: [{ from: 1.5, to: 2 }], picks: [] })).toBe(false);
    expect(emojiReportListsSerious({ picks: [] })).toBe(false);
    expect(emojiReportListsSerious(null)).toBe(false);
  });
});

describe("collectEmojiPicks", () => {
  test("drops picks on a Word Key two source words share and sorts by key", () => {
    const chunks = chunkTranscriptForEmojiTagging([utterance(0, [w(10, "later")]), utterance(1, [w(2, "first"), w(5.0001, "twin"), w(5.0004, "twin")])], "en", null);
    const picks = [[{ key: "10000", ref: { id: "a" }, strength: 1 }, { key: "2000", ref: { id: "b" }, strength: 2 }, { key: "5000", ref: { id: "c" }, strength: 3 }]];
    expect(collectEmojiPicks(chunks, picks).map((pick) => pick.key)).toEqual(["2000", "10000"]);
  });

  test("above the cap the weakest go, and the result still validates", () => {
    const words = Array.from({ length: EMOJI_TAG_MAX_PICKS + 2 }, (_, k) => w(k, "w."));
    const chunks = chunkTranscriptForEmojiTagging([utterance(0, words)], "en", null);
    const picks = [words.map((word, k) => ({ key: String(Math.round(word.startSec * 1000)), ref: { id: "a" }, strength: k < 2 ? 1 : 2 }))];
    const kept = collectEmojiPicks(chunks, picks);
    expect(kept).toHaveLength(EMOJI_TAG_MAX_PICKS);
    expect(kept.every((pick) => pick.strength === 2)).toBe(true);
    expect(captionEmojiPicksSchema.safeParse(kept).success).toBe(true);
  });
});

test("the capsule schema refuses malformed picks and the route body defaults to balanced", () => {
  expect(captionEmojiPicksSchema.safeParse([{ key: "1.5", ref: { id: "a" }, strength: 1 }]).success).toBe(false);
  expect(captionEmojiPicksSchema.safeParse([{ key: "1", ref: { id: "a" }, strength: 1, extra: 1 }]).success).toBe(false);
  expect(suggestClipEmojisSchema.parse({})).toEqual({ density: "balanced" });
  expect(suggestClipEmojisSchema.safeParse({ density: "lots" }).success).toBe(false);
});
