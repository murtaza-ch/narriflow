import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assignCaptionRoles,
  baselineCaptionHero,
  CAPTION_EMPHASIS_WEIGHTS,
  captionWordKey,
  CLIP_EMPHASIS_WORDS_LIMIT,
  clipEmphasisWords,
  type CaptionEmphasisOverride,
  type CaptionEmphasisWeights,
  type CaptionEmphasisWord,
} from "./caption-emphasis";

interface Spec {
  readonly raw: string;
  /** Seconds; defaults to 0.07 s per letter, letters clamped to 3..12, so no word stretches. */
  readonly dur?: number;
  /** Gap before the word; defaults to 0.05 s. */
  readonly pause?: number;
  readonly final?: boolean;
  readonly masked?: boolean;
  readonly utt?: number;
}

function defaultDuration(raw: string): number {
  const letters = Array.from(raw.replace(/[^\p{L}\p{N}]/gu, "")).length;
  return 0.07 * Math.min(12, Math.max(3, letters));
}

/** Builds timed cues; a plain string is a word with default timing in utterance 0. */
function build(cues: readonly (readonly (string | Spec)[])[]): CaptionEmphasisWord[][] {
  let clock = 0;
  return cues.map((cue) =>
    cue.map((entry) => {
      const spec = typeof entry === "string" ? { raw: entry } : entry;
      const pause = spec.pause ?? 0.05;
      const start = clock + pause;
      const end = start + (spec.dur ?? defaultDuration(spec.raw));
      clock = end;
      return {
        key: captionWordKey(start),
        raw: spec.raw,
        sourceStartSec: start,
        sourceEndSec: end,
        utteranceIndex: spec.utt ?? 0,
        utteranceFinal: spec.final ?? false,
        pauseBeforeSec: pause,
        masked: spec.masked ?? false,
      };
    }),
  );
}

/**
 * The gate and length values the logic tests were written against. Shipped
 * defaults are tuned on the G1 sheet (ticket 01) and tested separately below.
 */
const LOGIC_WEIGHTS: CaptionEmphasisWeights = {
  ...CAPTION_EMPHASIS_WEIGHTS,
  lengthPerLetter: 0.05,
  lengthMax: 0.5,
  gateMinScore: 1.5,
  gateMargin: 0.5,
};

function roles(
  cues: CaptionEmphasisWord[][],
  options: {
    language?: string | null;
    overrides?: Record<string, CaptionEmphasisOverride>;
    policy?: "auto" | "never";
    weights?: CaptionEmphasisWeights;
  } = {},
) {
  return assignCaptionRoles({
    cues,
    language: options.language === undefined ? "en" : options.language,
    overrides: options.overrides ?? {},
    policy: options.policy ?? "auto",
    weights: options.weights ?? LOGIC_WEIGHTS,
  });
}

/** Weights with every signal off except the given ones, and a gate of `gate`. */
function only(signals: Partial<CaptionEmphasisWeights>, gate: number): CaptionEmphasisWeights {
  const zero = Object.fromEntries(Object.keys(CAPTION_EMPHASIS_WEIGHTS).map((key) => [key, 0])) as Record<
    keyof CaptionEmphasisWeights,
    number
  >;
  return {
    ...zero,
    stretchFloor: CAPTION_EMPHASIS_WEIGHTS.stretchFloor,
    pauseMinSec: CAPTION_EMPHASIS_WEIGHTS.pauseMinSec,
    topicMinCount: CAPTION_EMPHASIS_WEIGHTS.topicMinCount,
    lengthMax: LOGIC_WEIGHTS.lengthMax,
    gateMinScore: gate,
    gateMargin: 0.1,
    ...signals,
  };
}

function heroes(cues: CaptionEmphasisWord[][], result: ReturnType<typeof roles>): (string | null)[] {
  return result.map((cue, index) =>
    cue.heroSpan === null
      ? null
      : cues[index]!.slice(cue.heroSpan[0], cue.heroSpan[1] + 1).map((word) => word.raw).join(" "),
  );
}

function heroOf(cue: readonly (string | Spec)[], options: Parameters<typeof roles>[1] = {}): string | null {
  const cues = build([cue]);
  return heroes(cues, roles(cues, options))[0]!;
}

describe("classification", () => {
  test("closed-class words are minor and never the hero", () => {
    const cues = build([["the", "plan", "is", { raw: "of", pause: 0.6, final: true }]]);
    const [cue] = roles(cues, { weights: only({ pause: 1, sentenceFinal: 1 }, 0.5) });
    expect(cue!.roles).toEqual(["minor", "body", "minor", "minor"]);
    expect(cue!.heroSpan).toBeNull();
  });

  test("filler renders as body and cannot be the hero", () => {
    const cues = build([["we", "planned", { raw: "basically", final: true, pause: 0.5 }]]);
    const [cue] = roles(cues, { weights: only({ pause: 1, sentenceFinal: 1 }, 0.5) });
    expect(cue!.roles).toEqual(["minor", "body", "body"]);
    expect(cue!.heroSpan).toBeNull();
  });

  test("digits, percent, currency, number words, negations and power words are never minor", () => {
    const cues = build([["5", "%", "$", "two", "no", "not", "never", "secret"]]);
    expect(roles(cues, { policy: "never" })[0]!.roles.every((role) => role === "body")).toBe(true);
  });

  test("a language with no list makes spaced words of 2 letters or fewer minor, except numbers", () => {
    const cues = build([["ja", "das", "10", "€", "Haus"]]);
    expect(roles(cues, { language: "de", policy: "never" })[0]!.roles).toEqual(["minor", "body", "body", "body", "body"]);
  });

  test("Roman Urdu applies token by token to Latin tokens, with the English lists", () => {
    const cues = build([["yaar", "ka", "nahi", "the", "Policy", "کا"]]);
    expect(roles(cues, { language: "ur", policy: "never" })[0]!.roles).toEqual(["body", "minor", "body", "minor", "body", "minor"]);
    // Filler is never the hero, whatever it scores.
    expect(heroOf([{ raw: "yaar", pause: 0.5 }, "kitab"], { language: "ur", weights: only({ pause: 2 }, 1) })).toBeNull();
  });

  test("regional language tags use the base language's lists", () => {
    const cues = build([["the", "plan"]]);
    expect(roles(cues, { language: "en-US", policy: "never" })[0]!.roles).toEqual(["minor", "body"]);
  });
});

describe("signals", () => {
  test("number: a digit, %, currency or number word", () => {
    const weights = only({ number: 2 }, 2);
    expect(heroOf(["we", "made", "7", "sales"], { weights })).toBe("7");
    expect(heroOf(["we", "lost", "50%", "overnight"], { weights })).toBe("50%");
    expect(heroOf(["it", "costs", "$40", "now"], { weights })).toBe("$40");
    expect(heroOf(["we", "hired", "seven", "people"], { weights })).toBe("seven");
    expect(heroOf(["we", "hired", "people"], { weights })).toBeNull();
  });

  test("negation", () => {
    expect(heroOf(["i", "will", "never", "stop"], { weights: only({ negation: 1 }, 1) })).toBe("never");
    expect(heroOf(["main", "nahi", "jaunga"], { language: "hi", weights: only({ negation: 1 }, 1) })).toBe("nahi");
    expect(heroOf(["وہ", "نہیں", "آئے"], { language: "ur", weights: only({ negation: 1 }, 1) })).toBe("نہیں");
  });

  test("power word", () => {
    expect(heroOf(["this", "is", "a", "secret", "plan"], { weights: only({ power: 1 }, 1) })).toBe("secret");
  });

  test("stretch: a word held well past the utterance's pace", () => {
    const weights = only({ stretchMax: 1.5 }, 1.2);
    // 0.84 s for "growth" against 0.42 s expected: ratio 2, score 1.275.
    expect(heroOf(["our", "growth", "came", "from", "people"], { weights })).toBeNull();
    expect(heroOf(["our", { raw: "growth", dur: 0.84 }, "came", "from", "people"], { weights })).toBe("growth");
    // Ratio 1.1 stays under the 1.15 floor.
    expect(heroOf(["our", { raw: "growth", dur: 0.462 }, "came", "from", "people"], { weights: only({ stretchMax: 1.5 }, 0.01) })).toBeNull();
  });

  test("pause of 0.25 s or more, except before an utterance's first word", () => {
    const weights = only({ pause: 1 }, 1);
    expect(heroOf(["and", "then", { raw: "everything", pause: 0.3 }, "changed"], { weights })).toBe("everything");
    expect(heroOf(["and", "then", { raw: "everything", pause: 0.2 }, "changed"], { weights })).toBeNull();
    expect(heroOf(["we", "left", { raw: "Monday", pause: 0.5, utt: 1 }, "morning", { raw: "x", utt: 1 }], { weights })).toBeNull();
  });

  test("ALL CAPS of 2 letters or more", () => {
    const weights = only({ allCaps: 1 }, 1);
    expect(heroOf(["this", "is", "HUGE", "news"], { weights })).toBe("HUGE");
    expect(heroOf(["we", "said", "A", "word"], { weights })).toBeNull();
  });

  test("utterance-final, or sentence punctuation in raw", () => {
    const weights = only({ sentenceFinal: 1 }, 1);
    expect(heroOf(["we", "won", "big", { raw: "today", final: true }], { weights })).toBe("today");
    expect(heroOf(["we", "won.", "big", "today"], { weights })).toBe("won.");
    expect(heroOf(["وہ", "میچ", "جیتے۔"], { language: "ur", weights })).toBe("جیتے۔");
  });

  test("topic word: the same normalised word 3 or more times in the clip", () => {
    const weights = only({ topic: 1 }, 1);
    const three = build([["growth", "matters"], ["real", "Growth"], ["growth,", "again"]]);
    expect(heroes(three, roles(three, { weights }))).toEqual(["growth", "Growth", "growth,"]);
    const two = build([["growth", "matters"], ["real", "growth"]]);
    expect(heroes(two, roles(two, { weights }))).toEqual([null, null]);
  });

  test("cue-final", () => {
    expect(heroOf(["we", "planned", "everything"], { weights: only({ cueFinal: 1 }, 1) })).toBe("everything");
  });

  test("capitalised, not sentence-initial, in a cased script", () => {
    const weights = only({ capitalised: 1 }, 1);
    expect(heroOf(["we", "met", "John", "there"], { weights })).toBe("John");
    expect(heroOf(["Today", "we", "won"], { weights })).toBeNull();
    expect(heroOf(["done.", "Then", "we", "won"], { weights })).toBeNull();
  });

  test("length: 0.05 per letter up to 0.5", () => {
    expect(heroOf(["cat", "elephants"], { weights: only({ lengthPerLetter: 0.05 }, 0.4) })).toBe("elephants");
    // 20 and 16 letters both cap at 0.5: a tie, so the gate refuses.
    expect(heroOf(["internationalisation", "characterisation"], { weights: only({ lengthPerLetter: 0.05 }, 0.4) })).toBeNull();
  });

  test("masked words are not eligible", () => {
    expect(heroOf(["we", "made", { raw: "7", masked: true }, "sales"], { weights: only({ number: 2 }, 2) })).toBeNull();
    const cues = build([["we", "made", { raw: "7", masked: true }, "sales"]]);
    expect(roles(cues, { overrides: { [cues[0]![2]!.key!]: "hero" } })[0]!.heroSpan).toBeNull();
  });
});

describe("units", () => {
  test("a number and a unit word form one hero that scores as the number", () => {
    expect(heroOf(["we", "grew", "20", "percent"])).toBe("20 percent");
    expect(heroOf(["almost", "twenty", "million", "dollars"])).toBe("twenty million");
    expect(heroOf(["main", "ne", "5", "lakh", "kamaye"], { language: "ur" })).toBe("5 lakh");
  });

  test("two adjacent capitalised words that are not sentence-initial form one hero", () => {
    expect(heroOf(["we", "moved", "to", "New", { raw: "York", final: true }])).toBe("New York");
    // "New" opens the utterance, so it is not part of a unit.
    expect(heroOf(["New", "York", "is", "loud"], { weights: only({ capitalised: 1 }, 1) })).toBe("York");
  });
});

describe("confidence gate", () => {
  test("picks a clear winner", () => {
    const cues = build([["we", "made", "7", "sales"]]);
    expect(roles(cues)[0]).toEqual({ roles: ["minor", "body", "hero", "body"], heroSpan: [2, 2] });
  });

  test("no hero when nothing reaches 1.5", () => {
    expect(heroOf(["they", "really", "want", "this"])).toBeNull();
  });

  test("no hero when the runner-up is within 0.5", () => {
    // secret 1.3, truth 1.5.
    expect(heroOf(["the", "secret", "truth"])).toBeNull();
    expect(heroOf(["the", "truth"])).toBe("truth");
  });

  test("policy never gives no cue a hero, overrides included", () => {
    const cues = build([["we", "made", "7", "sales"]]);
    const [cue] = roles(cues, { policy: "never", overrides: { [cues[0]![1]!.key!]: "hero" } });
    expect(cue).toEqual({ roles: ["minor", "body", "body", "body"], heroSpan: null });
  });
});

describe("overrides", () => {
  const cues = build([["we", "made", "7", "sales"]]);
  const key = (index: number) => cues[0]![index]!.key!;

  test("hero wins over the gate and the scores, even on a minor word", () => {
    expect(heroes(cues, roles(cues, { overrides: { [key(1)]: "hero" } }))).toEqual(["made"]);
    expect(heroes(cues, roles(cues, { overrides: { [key(0)]: "hero" } }))).toEqual(["we"]);
  });

  test("pair spans the word and the next word of the cue", () => {
    expect(heroes(cues, roles(cues, { overrides: { [key(1)]: "pair" } }))).toEqual(["made 7"]);
    // The cue's last word has no next word, so it is a single hero.
    expect(heroes(cues, roles(cues, { overrides: { [key(3)]: "pair" } }))).toEqual(["sales"]);
  });

  test("several overrides in a cue: the highest-scoring overridden word wins, ties to the later word", () => {
    expect(heroes(cues, roles(cues, { overrides: { [key(1)]: "hero", [key(2)]: "pair" } }))).toEqual(["7 sales"]);
    expect(heroes(cues, roles(cues, { overrides: { [key(2)]: "hero", [key(3)]: "pair" } }))).toEqual(["7"]);
    const even = build([["plan", "work"]]);
    const overrides = { [even[0]![0]!.key!]: "hero", [even[0]![1]!.key!]: "hero" } as const;
    expect(heroes(even, roles(even, { overrides, weights: only({}, 1) }))).toEqual(["work"]);
  });

  test("plain removes a word from the automatic pick; the rest must still pass the gate", () => {
    expect(heroes(cues, roles(cues, { overrides: { [key(2)]: "plain" } }))).toEqual([null]);
    const strong = build([["we", "made", "7", { raw: "sales", final: true, pause: 0.4 }]]);
    // sales: 1 + 1 + 0.25 + 0.25 = 2.5 beats 7 (2.05) by too little; plain on 7 leaves sales alone.
    expect(heroes(strong, roles(strong))).toEqual([null]);
    expect(heroes(strong, roles(strong, { overrides: { [strong[0]![2]!.key!]: "plain" } }))).toEqual(["sales"]);
  });

  test("no emphasis writes plain on every word", () => {
    const overrides = Object.fromEntries(cues[0]!.map((word) => [word.key!, "plain" as const]));
    expect(roles(cues, { overrides })[0]!.heroSpan).toBeNull();
  });

  test("a plain word inside a unit removes the unit", () => {
    const unit = build([["we", "grew", "20", "percent"]]);
    expect(heroes(unit, roles(unit, { overrides: { [unit[0]![3]!.key!]: "plain" } }))).toEqual([null]);
  });

  test("overrides whose key matches no word are ignored", () => {
    expect(heroes(cues, roles(cues, { overrides: { "999999": "hero", [key(2)]: "hero" } }))).toEqual(["7"]);
    expect(heroes(cues, roles(cues, { overrides: { "999999": "plain" } }))).toEqual(["7"]);
  });

  test("dub words without keys cannot be overridden", () => {
    const dub = build([["we", "made", "7", "sales"]]).map((cue) => cue.map((word) => ({ ...word, key: null })));
    expect(heroes(dub, roles(dub, { overrides: { [key(1)]: "hero" } }))).toEqual(["7"]);
  });
});

describe("repeat penalty", () => {
  test("the previous cue's automatic hero scores 1.0 lower", () => {
    const pair = build([["we", "made", "7", "sales"], ["only", "7", "left"]]);
    expect(heroes(pair, roles(pair))).toEqual(["7", null]);
    const alone = build([["only", "7", "left"]]);
    expect(heroes(alone, roles(alone))).toEqual(["7"]);
  });

  test("compares against automatic picks only, so an override never changes the next cue", () => {
    const pair = build([["we", "made", "7", "sales"], ["only", "7", "left"]]);
    const first = pair[0]!;
    const heroOnSales = { [first[3]!.key!]: "hero" } as const;
    expect(heroes(pair, roles(pair, { overrides: heroOnSales }))).toEqual(["sales", null]);
    const noEmphasis = Object.fromEntries(first.map((word) => [word.key!, "plain" as const]));
    expect(heroes(pair, roles(pair, { overrides: noEmphasis }))).toEqual([null, null]);
  });
});

describe("untimed utterances and scripts", () => {
  /** A cue holding one caption word that stands for a whole utterance. */
  function untimedCue(raw: string, utt: number): CaptionEmphasisWord[] {
    return build([[{ raw, dur: 3, utt }]]).map((cue) => cue.map((word) => ({ ...word, untimed: true })))[0]!;
  }

  test("one caption word holding a whole utterance gets no hero", () => {
    const cues = [untimedCue("this whole line had no word timings 2026", 0), ...build([["we", "made", "7", "sales"]])];
    expect(roles(cues)).toEqual([
      { roles: ["body"], heroSpan: null },
      { roles: ["minor", "body", "hero", "body"], heroSpan: [2, 2] },
    ]);
    expect(baselineCaptionHero({ cues, language: "en" })[0]).toBeNull();
  });

  test("a one-word untimed utterance does not change the next cue's hero", () => {
    const timed = build([["so", "money", "talks", "loud."], ["money", "is", "power"]]);
    const run = (cues: CaptionEmphasisWord[][]) =>
      assignCaptionRoles({ cues, language: "en", overrides: {}, policy: "auto" });
    const without = run(timed);
    const between = [timed[0]!, untimedCue("money", 1), timed[1]!];
    const withUntimed = run(between);
    expect(withUntimed[1]).toEqual({ roles: ["body"], heroSpan: null });
    expect(withUntimed[2]).toEqual(without[1]);
    expect(withUntimed[0]).toEqual(without[0]);
    expect(baselineCaptionHero({ cues: between, language: "en" })[1]).toBeNull();
  });

  test("Urdu in Arabic script, with Arabic letter forms folded", () => {
    const cues = build([["ہم", "نے", "20", "فیصد", "كا", "فائدہ", "اٹھایا"]]);
    const [cue] = roles(cues, { language: "ur" });
    expect(cue!.roles).toEqual(["minor", "minor", "hero", "hero", "minor", "body", "body"]);
  });

  test("Hindi in Devanagari", () => {
    const cues = build([["यह", "मेरी", "कहानी", "है"]]);
    expect(roles(cues, { language: "hi", policy: "never" })[0]!.roles).toEqual(["minor", "minor", "body", "minor"]);
  });

  test("no-space scripts do not crash and are not minor by length", () => {
    const japanese = build([["今", "日", "は", "最", "高", "で", "す"]]);
    const result = roles(japanese, { language: "ja" });
    expect(result[0]!.roles).toHaveLength(7);
    expect(result[0]!.roles.includes("minor")).toBe(false);
    const thai = build([["วันนี้", "ดี", "มาก"]]);
    expect(roles(thai, { language: "th" })[0]!.roles).toHaveLength(3);
    expect(roles(build([[]]), { language: null })).toEqual([{ roles: [], heroSpan: null }]);
  });
});

describe("baseline", () => {
  test("digits win, else the last non-minor word", () => {
    const cues = build([["we", "made", "7", "sales"], ["it", "was", "fine", "for", "us"], ["the", "of", "and"], ["2", "or", "3", "times"]]);
    expect(baselineCaptionHero({ cues, language: "en" })).toEqual([[2, 2], [2, 2], null, [2, 2]]);
  });
});

describe("source rules", () => {
  const dir = import.meta.dir;
  const files = ["caption-emphasis.ts", "caption-emphasis-words-en.ts", "caption-emphasis-words-ur.ts", "caption-emphasis-words-hi.ts", "caption-emphasis-words-roman.ts"];

  test("no Intl or locale API", () => {
    for (const file of files) {
      expect(readFileSync(join(dir, file), "utf8")).not.toMatch(/Intl\.|toLocale|localeCompare/);
    }
  });

  test("the word lists stay under 20 KB", () => {
    const bytes = files.slice(1).reduce((total, file) => total + readFileSync(join(dir, file)).byteLength, 0);
    expect(bytes).toBeLessThan(20 * 1024);
  });
});

describe("shipped weights (tuned on the G1 tuning sheet)", () => {
  test("a weak but clear candidate still becomes the hero", () => {
    const cues = build([["and", "then", "we", "talked"]]);
    const result = assignCaptionRoles({ cues, language: "en", overrides: {}, policy: "auto" });
    expect(heroes(cues, result)).toEqual(["talked"]);
  });
});

describe("Clip Emphasis Words", () => {
  const shipped = (cues: CaptionEmphasisWord[][], emphasisWords?: readonly string[]) =>
    assignCaptionRoles({ cues, language: "en", overrides: {}, policy: "auto", ...(emphasisWords ? { emphasisWords } : {}) });

  test("a matching single word becomes the hero, matched by case and edge punctuation", () => {
    const cues = build([["we", "lost", "the", "contract", { raw: "yesterday.", final: true }]]);
    expect(heroes(cues, shipped(cues))).toEqual(["yesterday."]);
    expect(heroes(cues, shipped(cues, ["Contract"]))).toEqual(["contract"]);
  });

  test("a 2-word suggestion forms a unit, with the bonus counted once", () => {
    const cues = build([["this", "is", "really", "important", "stuff"]]);
    const result = shipped(cues, ["really important", "important"]);
    expect(heroes(cues, result)).toEqual(["really important"]);
    expect(result[0]!.roles).toEqual(["minor", "minor", "hero", "hero", "body"]);
    // With only the LLM signal, a pair that also holds a single suggestion
    // scores 3, not 6, so it ties a lone suggested word and the gate refuses.
    const scored = assignCaptionRoles({ cues, language: "en", overrides: {}, policy: "auto",
      emphasisWords: ["really important", "important", "stuff"], weights: only({ llm: 3 }, 0.5) });
    expect(scored[0]!.heroSpan).toBeNull();
  });

  test("a pair with one minor word still forms a unit; a masked word never does", () => {
    const cues = build([["it", "changed", "my", "life"]]);
    expect(heroes(cues, shipped(cues, ["my life"]))).toEqual(["my life"]);
    const masked = build([["it", "changed", "my", { raw: "life", masked: true }]]);
    expect(heroes(masked, shipped(masked, ["my life"]))).not.toEqual(["my life"]);
  });

  test("no match, or no words at all, scores exactly as today", () => {
    const cues = build([
      ["we", "made", "7", "sales"],
      ["and", "then", "we", "talked"],
      ["NEVER", "give", { raw: "up", pause: 0.4, final: true }],
    ]);
    const today = shipped(cues);
    expect(shipped(cues, [])).toEqual(today);
    expect(shipped(cues, ["banana", "three words here", ""])).toEqual(today);
  });

  test("a minor or filler suggestion cannot make a word the hero", () => {
    const cues = build([["the", "plan", "basically"]]);
    expect(shipped(cues, ["the", "basically"])).toEqual(shipped(cues));
  });
});

describe("clipEmphasisWords", () => {
  test("matches precomposed and decomposed spellings (Urdu madda, Hindi nukta)", () => {
    const urduSlice = [{ words: [{ word: "\u0627\u0653\u062C" }, { word: "\u06A9\u0627\u0645" }] }];
    expect(clipEmphasisWords(["\u0622\u062C"], urduSlice as never)).toEqual(["\u0622\u062C"]);
    const hindiSlice = [{ words: [{ word: "\u0915\u093C\u093E\u0928\u0942\u0928" }] }];
    expect(clipEmphasisWords(["\u0958\u093E\u0928\u0942\u0928"], hindiSlice as never)).toEqual(["\u0958\u093E\u0928\u0942\u0928"]);
  });

  const slice = [
    { text: "We grew 50 percent, not by luck.", words: ["We", "grew", "50", "percent,", "not", "by", "luck."].map((word) => ({ word })) },
    { text: "یہ بہت اہم ہے", words: ["یہ", "بہت", "اہم", "ہے"].map((word) => ({ word })) },
    { text: "untimed fallback text", words: [] },
  ];

  test("keeps suggestions found in the clip's text and drops invented ones", () => {
    expect(clipEmphasisWords(["LUCK", "50 percent", "اہم", "fallback", "million", "grew luck", "percent not"], slice))
      .toEqual(["LUCK", "50 percent", "اہم", "fallback", "percent not"]);
  });

  test("trims, de-duplicates by normalised text, and bounds count, words and length", () => {
    expect(clipEmphasisWords(["  grew  ", "Grew", "grew 50 percent", "", "x".repeat(41)], slice)).toEqual(["grew"]);
    const many = Array.from({ length: 12 }, (_, index) => `w${index}`);
    expect(clipEmphasisWords(many, [{ text: many.join(" "), words: [] }])).toHaveLength(CLIP_EMPHASIS_WORDS_LIMIT);
  });

  test("a 2-word unit must be adjacent inside one utterance", () => {
    expect(clipEmphasisWords(["luck. یہ", "fallback text"], slice)).toEqual(["fallback text"]);
  });
});
