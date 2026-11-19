import { describe, expect, test } from "bun:test";
import {
  applyCaptionTextTransform,
  assignCaptionRoles,
  CAPTION_DYNAMIC_STYLES,
  captionBlockSeed,
  captionPresetSchema,
  captionWordKey,
  editorDocumentSchema,
  getCaptionPresetById,
  studioEditsSchema,
  type CaptionWordRole,
} from "@narriflow/validators";
import manifest from "./__fixtures__/dynamic-captions/manifest.json";
import {
  captionCueBlock,
  deriveCaptionCues,
  planClipComposition,
  type CaptionOverride,
  type CompositionCaptionVisualLayer,
} from "./clip-composition-plan";

interface FixtureWord {
  readonly word: string;
  readonly key: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly spaceBefore?: boolean;
}

interface FixtureCase {
  readonly id: string;
  readonly presetId: string;
  readonly preset: Record<string, unknown>;
  readonly language: string;
  readonly words: readonly FixtureWord[];
  readonly overrides: Record<string, "hero" | "pair" | "plain">;
  readonly expected: { readonly roles: readonly CaptionWordRole[]; readonly rows: readonly (readonly number[])[] };
}

const CASES = manifest.cases as unknown as readonly FixtureCase[];

function utterance(words: readonly FixtureWord[], index = 0) {
  return {
    index, speaker: 0, speakerLabel: "Speaker 1",
    startSec: words[0]!.startSec, endSec: words[words.length - 1]!.endSec,
    text: words.map((word) => word.word).join(" "), confidence: 1,
    words: words.map(({ key: _key, ...word }) => ({ ...word, confidence: 1 })),
  };
}

function document(input: {
  readonly preset: Record<string, unknown>;
  readonly utterances: readonly ReturnType<typeof utterance>[];
  readonly captionEmphasis?: Record<string, "hero" | "pair" | "plain">;
}) {
  return editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 0,
    clipEndSec: 20,
    captionPreset: captionPresetSchema.parse(input.preset),
    transcriptSlice: input.utterances,
    studioEdits: studioEditsSchema.parse({
      framing: { mode: "center" },
      ...(input.captionEmphasis ? { captionEmphasis: input.captionEmphasis } : {}),
    }),
    brollUrl: null,
    deletedRanges: [],
  });
}

function captionLayers(doc: ReturnType<typeof document>, language: string | null, captionOverride?: CaptionOverride) {
  const result = planClipComposition({
    document: doc,
    captionLanguage: language,
    ...(captionOverride ? { captionOverride } : {}),
    source: { identity: "source:dynamic", kind: "video", width: 1920, height: 1080 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" }, music: { state: "missing" } },
    capabilities: { automaticSpeakerLayout: false, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan.targets[0]!.visualLayers.flatMap((layer): CompositionCaptionVisualLayer[] => (layer.kind === "caption" ? [layer] : []));
}

const headline = getCaptionPresetById("headline")!.preset;
const boldPop = getCaptionPresetById("bold-pop")!.preset;

describe("dynamic caption fixtures (spec section 9)", () => {
  test("the manifest holds the cases 03a can express", () => {
    const ids = CASES.map((entry) => entry.id);
    for (const id of ["headline-en", "headline-number-unit", "headline-gate-no-hero", "headline-urdu", "headline-japanese", "headline-short-words", "headline-long-hero-fit"]) {
      expect(ids).toContain(id);
    }
    for (const entry of CASES) {
      for (const word of entry.words) expect(word.key).toBe(captionWordKey(word.startSec));
    }
    const short = CASES.find((entry) => entry.id === "headline-short-words")!;
    const span = short.words.at(-1)!.endSec - short.words[0]!.startSec;
    expect(span / short.words.length).toBeLessThan(0.3);
    expect(CASES.find((entry) => entry.id === "headline-long-hero-fit")!.words).toHaveLength(5);
  });

  test.each(CASES.map((entry) => [entry.id, entry] as const))("%s: one cue with the expected roles, rows and keys", (_id, entry) => {
    const preset = { ...getCaptionPresetById(entry.presetId)!.preset, ...entry.preset };
    const layers = captionLayers(document({ preset, utterances: [utterance(entry.words)], captionEmphasis: entry.overrides }), entry.language);
    expect(layers).toHaveLength(1);
    const [layer] = layers;
    expect(layer!.block).toBeDefined();
    const block = layer!.block!;
    expect(block.style).toBe(entry.style);
    expect(block.roles).toEqual([...entry.expected.roles]);
    expect(block.rows).toEqual(entry.expected.rows.map((row) => [...row]));
    expect(block.keys).toEqual(entry.words.map((word) => word.key));
    expect(block.seed).toBe(captionBlockSeed(entry.words[0]!.key, 0));
    // Subtitle text keeps the preset's case (Groove's caps), never the roles'.
    expect(layer!.words.map((word) => word.text)).toEqual(entry.words.map((word) => applyCaptionTextTransform(word.word, preset.textTransform, entry.language)));
    expect(layer!.words.every((word) => word.emoji === null)).toBe(true);
  });
});

describe("phase 1 catalog in the plan", () => {
  test("every style has a fixture case, and Cutout has a long-word fit case", () => {
    const styles = new Set(CASES.map((entry) => entry.style));
    for (const style of ["headline", "editorial", "cutout", "marker", "stack", "groove"]) expect(styles).toContain(style);
    expect(CASES.map((entry) => entry.id)).toContain("cutout-long-word-fit");
  });

  test("a style without a hero ignores hero overrides: Cutout never picks one", () => {
    const cutout = getCaptionPresetById("cutout")!.preset;
    const entry = CASES.find((candidate) => candidate.id === "cutout-en")!;
    const overrides = { [entry.words[2]!.key]: "hero" as const, [entry.words[0]!.key]: "pair" as const };
    const [layer] = captionLayers(document({ preset: cutout, utterances: [utterance(entry.words)], captionEmphasis: overrides }), "en");
    expect(layer!.block!.roles).toEqual(["minor", "minor", "body", "minor", "body"]);
    expect(layer!.block!.rows).toEqual([[0, 1, 2, 3, 4]]);
  });

  test("Editorial's body words take the hero slot's lowercase; minor words the preset's case", () => {
    const editorial = { ...getCaptionPresetById("editorial")!.preset, textTransform: "uppercase" as const };
    const entry = CASES.find((candidate) => candidate.id === "editorial-en")!;
    const [layer] = captionLayers(document({ preset: editorial, utterances: [utterance(entry.words)] }), "en");
    expect(layer!.block!.texts).toEqual(["A", "big", "problem", "WITH"]);
    // Subtitles keep the preset transform.
    expect(layer!.words.map((word) => word.text)).toEqual(["A", "BIG", "PROBLEM", "WITH"]);
  });

  test("Marker defaults to its left guide", () => {
    const entry = CASES.find((candidate) => candidate.id === "marker-en")!;
    const [layer] = captionLayers(document({ preset: getCaptionPresetById("marker")!.preset, utterances: [utterance(entry.words)] }), "en");
    expect(layer!.anchor.xPct).toBe(8);
  });
});

describe("Caption Blocks in the plan", () => {
  const words: FixtureWord[] = [
    { word: "the", key: "0", startSec: 0, endSec: 0.25 },
    { word: "money", key: "300", startSec: 0.3, endSec: 0.55 },
    { word: "is", key: "600", startSec: 0.6, endSec: 0.85 },
    { word: "99%", key: "900", startSec: 0.9, endSec: 1.15 },
    { word: "real", key: "1200", startSec: 1.2, endSec: 1.45 },
  ];

  test("a dynamic preset gets a block; words[].text keeps the preset transform and emoji is null", () => {
    const preset = { ...headline, textTransform: "uppercase", emojis: true };
    const layers = captionLayers(document({ preset, utterances: [utterance(words)] }), "en");
    expect(layers.map((layer) => layer.words.length)).toEqual([4, 1]);
    const block = layers[0]!.block!;
    expect(layers[0]!.words.map((word) => word.text)).toEqual(["THE", "MONEY", "IS", "99%"]);
    expect(layers[0]!.words.map((word) => word.emoji)).toEqual([null, null, null, null]);
    // Text-slot roles inherit the preset's case; the hero takes the style's ("none").
    expect(block.roles).toEqual(["minor", "body", "minor", "hero"]);
    expect(block.texts).toEqual(["THE", "MONEY", "IS", "99%"]);
    expect(block.rows).toEqual([[0, 1, 2], [3]]);
  });

  test("the hero's case comes from the style, never the preset", () => {
    const cue = [
      { word: "the", key: "0", startSec: 0, endSec: 0.25 },
      { word: "Money", key: "300", startSec: 0.3, endSec: 0.55 },
      { word: "talks", key: "600", startSec: 0.6, endSec: 0.85 },
    ];
    const layers = captionLayers(document({ preset: { ...headline, textTransform: "uppercase" }, utterances: [utterance(cue)], captionEmphasis: { "300": "hero" } }), "en");
    expect(layers[0]!.block!.roles).toEqual(["minor", "hero", "body"]);
    expect(layers[0]!.block!.texts).toEqual(["THE", "Money", "TALKS"]);
    expect(layers[0]!.words.map((word) => word.text)).toEqual(["THE", "MONEY", "TALKS"]);
  });

  test("a classic preset gets no block and keeps its emoji", () => {
    const layers = captionLayers(document({ preset: { ...boldPop, emojis: true }, utterances: [utterance(words)] }), "en");
    expect(layers.every((layer) => layer.block === undefined)).toBe(true);
    expect(layers[0]!.words.find((word) => word.text === "MONEY")!.emoji).toBe("💰");
  });

  test("subtitle cues (which the clip timeline also reads) come from words[].text, unchanged by roles", () => {
    const preset = { ...headline, textTransform: "uppercase" };
    const doc = document({ preset, utterances: [utterance(words)] });
    const classicDoc = document({ preset: { ...preset, dynamic: undefined }, utterances: [utterance(words)] });
    expect(deriveCaptionCues(doc, { language: "en" })).toEqual(deriveCaptionCues(classicDoc, { language: "en" }));
    expect(deriveCaptionCues(doc, { language: "en" })[0]!.text).toBe("THE MONEY IS 99%");
  });

  test("roles run as a second pass over the whole target with the stored overrides", () => {
    const preset = headline;
    const automatic = captionLayers(document({ preset, utterances: [utterance(words)] }), "en");
    const overridden = captionLayers(document({ preset, utterances: [utterance(words)], captionEmphasis: { "300": "hero", "99999": "plain" } }), "en");
    expect(automatic[0]!.block!.roles[3]).toBe("hero");
    expect(overridden[0]!.block!.roles).toEqual(["minor", "hero", "minor", "body"]);
    const expected = assignCaptionRoles({
      cues: [words.slice(0, 4), words.slice(4)].map((cue) => cue.map((word, index) => ({
        key: word.key, raw: word.word, sourceStartSec: word.startSec, sourceEndSec: word.endSec, utteranceIndex: 0,
        utteranceFinal: word === words.at(-1), pauseBeforeSec: index === 0 && word === words[0] ? 0 : 0.05, masked: false,
      }))),
      language: "en",
      overrides: {},
      policy: "auto",
    });
    expect(automatic.map((layer) => layer.block!.roles)).toEqual(expected.map((cue) => cue.roles));
  });

  test("Clip Emphasis Words on the document lift the matching word; none, or none matching, is today's plan", () => {
    const plain = captionLayers(document({ preset: headline, utterances: [utterance(words)] }), "en");
    const lifted = captionLayers(editorDocumentSchema.parse({ ...document({ preset: headline, utterances: [utterance(words)] }), emphasisWords: ["Money"] }), "en");
    expect(plain[0]!.block!.roles[3]).toBe("hero");
    expect(lifted[0]!.block!.roles).toEqual(["minor", "hero", "minor", "body"]);
    const unmatched = captionLayers(editorDocumentSchema.parse({ ...document({ preset: headline, utterances: [utterance(words)] }), emphasisWords: ["rocket"] }), "en");
    expect(unmatched).toEqual(plain);
    // Subtitle cues never read roles.
    expect(deriveCaptionCues(editorDocumentSchema.parse({ ...document({ preset: headline, utterances: [utterance(words)] }), emphasisWords: ["Money"] }), { language: "en" }))
      .toEqual(deriveCaptionCues(document({ preset: headline, utterances: [utterance(words)] }), { language: "en" }));
  });

  test("dub captions ignore Clip Emphasis Words, which are in the source language", () => {
    const override: CaptionOverride = {
      language: "en",
      segments: [[
        { text: "we", startSec: 0, endSec: 0.3 },
        { text: "made", startSec: 0.3, endSec: 0.6 },
        { text: "20", startSec: 0.6, endSec: 0.9 },
        { text: "dollars.", startSec: 0.9, endSec: 1.2 },
      ]],
    };
    const base = document({ preset: headline, utterances: [utterance(words)] });
    expect(captionLayers(editorDocumentSchema.parse({ ...base, emphasisWords: ["made"] }), "en", override))
      .toEqual(captionLayers(base, "en", override));
  });

  test("wordsPerCue of a dynamic preset is clamped to 2..5", () => {
    const one = captionLayers(document({ preset: { ...headline, wordsPerCue: 1 }, utterances: [utterance(words)] }), "en");
    expect(one.map((layer) => layer.words.length)).toEqual([2, 2, 1]);
  });

  test("untimed utterances render as the classic line with no block", () => {
    const untimed = { ...utterance(words), text: "the money is real", words: [] };
    const layers = captionLayers(document({ preset: headline, utterances: [untimed] }), "en");
    expect(layers).toHaveLength(1);
    expect(layers[0]!.block).toBeUndefined();
  });

  test("a one-word untimed utterance leaves the next cue's block unchanged", () => {
    const next: FixtureWord[] = [
      { word: "money", key: "9000", startSec: 9, endSec: 9.4 },
      { word: "is", key: "9450", startSec: 9.45, endSec: 9.6 },
    ];
    const bare = captionLayers(document({ preset: headline, utterances: [utterance(next, 2)] }), "en");
    const untimed = { ...utterance(words, 1), startSec: 5, endSec: 6, text: "money", words: [] };
    const layers = captionLayers(document({ preset: headline, utterances: [untimed, utterance(next, 2)] }), "en");
    expect(layers).toHaveLength(2);
    expect(layers[0]!.block).toBeUndefined();
    expect(bare[0]!.block!.roles).toContain("hero");
    expect(layers[1]!.block!.roles).toEqual(bare[0]!.block!.roles);
  });

  test("dub captions get automatic roles with null keys and a cue-index seed", () => {
    const override: CaptionOverride = {
      language: "en",
      segments: [[
        { text: "we", startSec: 0, endSec: 0.3 },
        { text: "made", startSec: 0.3, endSec: 0.6 },
        { text: "20", startSec: 0.6, endSec: 0.9 },
        { text: "dollars.", startSec: 0.9, endSec: 1.2 },
      ]],
    };
    const layers = captionLayers(document({ preset: headline, utterances: [utterance(words)], captionEmphasis: { "300": "hero" } }), "en", override);
    expect(layers).toHaveLength(1);
    const block = layers[0]!.block!;
    expect(block.keys).toEqual([null, null, null, null]);
    expect(block.roles).toEqual(["minor", "body", "hero", "hero"]);
    expect(block.seed).toBe(captionBlockSeed(null, 0));
    expect(layers[0]!.words.every((word) => word.emoji === null)).toBe(true);
  });

  test("a left style defaults its anchor to the style's guide", () => {
    // Headline is centred; the anchor rule reads the style, so a centred style keeps 50%.
    const layers = captionLayers(document({ preset: headline, utterances: [utterance(words)] }), "en");
    expect(CAPTION_DYNAMIC_STYLES.headline.align).toBe("center");
    expect(layers[0]!.anchor.xPct).toBe(50);
  });
});

describe("soft cue breaks in the plan (every preset)", () => {
  const phrase: FixtureWord[] = [
    { word: "So", key: "0", startSec: 0, endSec: 0.2 },
    { word: "here,", key: "250", startSec: 0.25, endSec: 0.45 },
    { word: "we", key: "500", startSec: 0.5, endSec: 0.7 },
    { word: "go", key: "750", startSec: 0.75, endSec: 0.95 },
  ];
  const classic = { ...boldPop, wordsPerCue: 3, textTransform: "none" };

  test("a classic cue closes at the clause instead of the word budget", () => {
    const layers = captionLayers(document({ preset: classic, utterances: [utterance(phrase)] }), "en");
    expect(layers.map((layer) => layer.words.map((word) => word.text))).toEqual([["So", "here,"], ["we", "go"]]);
  });

  test("the break survives the Punctuation toggle, which reads the raw text", () => {
    const layers = captionLayers(document({ preset: { ...classic, punctuation: false }, utterances: [utterance(phrase)] }), "en");
    expect(layers.map((layer) => layer.words.map((word) => word.text))).toEqual([["So", "here"], ["we", "go"]]);
  });

  test("a punctuation-only token hidden by the toggle still ends the phrase", () => {
    const dashed: FixtureWord[] = [
      { word: "So", key: "0", startSec: 0, endSec: 0.2 },
      { word: "here", key: "250", startSec: 0.25, endSec: 0.45 },
      { word: "—", key: "460", startSec: 0.46, endSec: 0.48 },
      { word: "we", key: "500", startSec: 0.5, endSec: 0.7 },
      { word: "go", key: "750", startSec: 0.75, endSec: 0.95 },
    ];
    const layers = captionLayers(document({ preset: { ...classic, punctuation: false }, utterances: [utterance(dashed)] }), "en");
    expect(layers.map((layer) => layer.words.map((word) => word.text))).toEqual([["So", "here"], ["we", "go"]]);
  });

  test("a pause of 0.35 s or more breaks a cue that would overflow", () => {
    const paused: FixtureWord[] = [
      { word: "one", key: "0", startSec: 0, endSec: 0.2 },
      { word: "two", key: "250", startSec: 0.25, endSec: 0.45 },
      { word: "three", key: "900", startSec: 0.9, endSec: 1.1 },
      { word: "four", key: "1150", startSec: 1.15, endSec: 1.35 },
    ];
    const layers = captionLayers(document({ preset: classic, utterances: [utterance(paused)] }), "en");
    expect(layers.map((layer) => layer.words.map((word) => word.text))).toEqual([["one", "two"], ["three", "four"]]);
  });

  test("dub captions keep the break of a punctuation-only token hidden by the toggle", () => {
    const override: CaptionOverride = {
      language: "en",
      segments: [[
        { text: "So", startSec: 0, endSec: 0.2 },
        { text: "here", startSec: 0.25, endSec: 0.45 },
        { text: "\u2014", startSec: 0.46, endSec: 0.48 },
        { text: "we", startSec: 0.5, endSec: 0.7 },
        { text: "go", startSec: 0.75, endSec: 0.95 },
      ]],
    };
    const layers = captionLayers(document({ preset: { ...classic, punctuation: false }, utterances: [utterance(phrase)] }), "en", override);
    expect(layers.map((layer) => layer.words.map((word) => word.text))).toEqual([["So", "here"], ["we", "go"]]);
  });

  test("dub captions break at clauses too", () => {
    const override: CaptionOverride = {
      language: "en",
      segments: [[
        { text: "first", startSec: 0, endSec: 0.2 },
        { text: "part,", startSec: 0.2, endSec: 0.4 },
        { text: "then", startSec: 0.4, endSec: 0.6 },
        { text: "more", startSec: 0.6, endSec: 0.8 },
      ]],
    };
    const layers = captionLayers(document({ preset: classic, utterances: [utterance(phrase)] }), "en", override);
    expect(layers.map((layer) => layer.words.map((word) => word.text))).toEqual([["first", "part,"], ["then", "more"]]);
  });
});

describe("captionCueBlock", () => {
  test("builds the same block as the plan for a sample cue", () => {
    const sample = [{ text: "the", key: null }, { text: "BEST", key: null }, { text: "part", key: null }];
    const roles = { roles: ["minor", "hero", "body"] as CaptionWordRole[], heroSpan: [1, 1] as const };
    expect(captionCueBlock(sample, headline, "en", 3, roles)).toEqual({
      style: "headline",
      roles: ["minor", "hero", "body"],
      texts: ["the", "BEST", "part"],
      keys: [null, null, null],
      rows: [[0], [1], [2]],
      seed: captionBlockSeed(null, 3),
    });
  });

  test("is null for a classic preset", () => {
    expect(captionCueBlock([{ text: "go", key: "0" }], boldPop, "en", 0, { roles: ["body"], heroSpan: null })).toBeNull();
  });
});
