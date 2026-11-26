import { describe, expect, test } from "bun:test";
import {
  autoCensorWordId,
  captionPresetSchema,
  editorDocumentSchema,
  getCaptionPresetById,
  studioEditsSchema,
  type CaptionEmojiRef,
} from "@narriflow/validators";
import {
  deriveCaptionCues,
  planClipComposition,
  type CaptionOverride,
  type CompositionCaptionVisualLayer,
} from "./clip-composition-plan";

/** Caption Emojis through the real plan: which cue takes each stored emoji, and when (spec D5, D7). */

type Word = { word: string; startSec: number; endSec: number; confidence: number };

// Fast speech: 0.3 s per word, the second line right after the first.
const LINE_ONE = ["so", "I", "quit", "my", "job", "today"].map((word, index): Word => ({
  word, startSec: index * 0.4, endSec: index * 0.4 + 0.3, confidence: 1,
}));
const LINE_TWO = ["honestly", "best", "decision", "ever"].map((word, index): Word => ({
  word, startSec: 2.4 + index * 0.4, endSec: 2.4 + index * 0.4 + 0.3, confidence: 1,
}));

function utterance(index: number, words: readonly Word[]) {
  return {
    index, speaker: 0, speakerLabel: "Speaker 1",
    startSec: words[0]!.startSec, endSec: words.at(-1)!.endSec,
    text: words.map((word) => word.word).join(" "), confidence: 1, words: [...words],
  };
}

function document(input: {
  readonly preset?: Record<string, unknown>;
  readonly emojis?: Record<string, CaptionEmojiRef>;
  readonly lines?: readonly (readonly Word[])[];
  readonly overrides?: Record<string, unknown>;
}) {
  return editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 0,
    clipEndSec: 10,
    captionPreset: captionPresetSchema.parse({ textTransform: "none", wordsPerCue: 3, emojis: true, ...input.preset }),
    transcriptSlice: (input.lines ?? [LINE_ONE, LINE_TWO]).map((words, index) => utterance(index, words)),
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" }, ...(input.emojis ? { captionEmojis: input.emojis } : {}) }),
    brollUrl: null,
    deletedRanges: [],
    ...input.overrides,
  });
}

function captionLayers(doc: ReturnType<typeof document>, captionOverride?: CaptionOverride) {
  const result = planClipComposition({
    document: doc,
    captionLanguage: "en",
    ...(captionOverride ? { captionOverride } : {}),
    source: { identity: "source:emoji", kind: "video", width: 1920, height: 1080 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" }, music: {} },
    capabilities: { automaticSpeakerLayout: false, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan.targets[0]!.visualLayers.flatMap((layer): CompositionCaptionVisualLayer[] => (layer.kind === "caption" ? [layer] : []));
}

/** Each cue's text and emojis, for cues that have any. */
function placed(layers: readonly CompositionCaptionVisualLayer[]) {
  return layers.flatMap((layer) => layer.emojis.length === 0 ? [] : [{
    text: layer.words.map((word) => word.text).join(" "),
    emojis: layer.emojis,
  }]);
}

// Word Keys: "quit" starts at 800 ms, "job" at 1600, "decision" at 3200.
const ON_QUIT = { "800": { id: "fire" } };

describe("Caption Emojis in the plan", () => {
  test("an exact Word Key puts the emoji on its word's cue, at the word's start", () => {
    const layers = captionLayers(document({ emojis: { "800": { id: "fire" }, "3200": { id: "thumbs-up", tone: 4 } } }));
    expect(placed(layers)).toEqual([
      { text: "so I quit", emojis: [{ id: "fire", atSec: 0.8, order: 0 }] },
      { text: "honestly best decision", emojis: [{ id: "thumbs-up", tone: 4, atSec: 3.2, order: 1 }] },
    ]);
  });

  test("an emoji with no tone of its own is drawn in the preset's Skin tone; a tone chosen by hand, yellow included, keeps its own", () => {
    // The AI's emojis store no tone; a hand pick stores 0 to 5.
    const emojis = { "800": { id: "waving-hand" }, "1600": { id: "thumbs-up", tone: 2 }, "3200": { id: "clapping-hands", tone: 0 } };
    const drawn = (preset: Record<string, unknown>) => captionLayers(document({ emojis, preset })).flatMap((layer) => layer.emojis.map(({ id, tone }) => ({ id, tone })));
    expect(drawn({})).toEqual([{ id: "waving-hand", tone: undefined }, { id: "thumbs-up", tone: 2 }, { id: "clapping-hands", tone: undefined }]);
    expect(drawn({ emojiTone: 5 })).toEqual([{ id: "waving-hand", tone: 5 }, { id: "thumbs-up", tone: 2 }, { id: "clapping-hands", tone: undefined }]);
  });

  test("each emoji carries its place among the target's emojis in time order, across cues", () => {
    const layers = captionLayers(document({ emojis: { "3200": { id: "brain" }, "800": { id: "fire" }, "1600": { id: "rocket" } } }));
    expect(layers.flatMap((layer) => layer.emojis.map((emoji) => [emoji.id, emoji.order]))).toEqual([["fire", 0], ["rocket", 1], ["brain", 2]]);
  });

  test("a cue holds several emojis in time order", () => {
    const layers = captionLayers(document({ emojis: { "1600": { id: "rocket" }, "1200": { id: "brain" } } }));
    expect(placed(layers)).toEqual([{ text: "my job today", emojis: [{ id: "brain", atSec: 1.2, order: 0 }, { id: "rocket", atSec: 1.6, order: 1 }] }]);
  });

  test("after a line is re-timed the emoji finds the nearest word of its line", () => {
    const retimed = LINE_ONE.map((word, index) => index === 2 ? { ...word, startSec: 0.95, endSec: 1.15 } : word);
    const layers = captionLayers(document({ emojis: ON_QUIT, lines: [retimed, LINE_TWO] }));
    expect(placed(layers)).toEqual([{ text: "so I quit", emojis: [{ id: "fire", atSec: 0.95, order: 0 }] }]);
  });

  test("an entry that stores its word draws only on a word with that text: a rewrite never moves it", () => {
    const fire = { "800": { id: "fire", word: "quit" } };
    // Re-timed, same word: it follows.
    const retimed = LINE_ONE.map((word, index) => index === 2 ? { ...word, startSec: 0.95, endSec: 1.15 } : word);
    expect(placed(captionLayers(document({ emojis: fire, lines: [retimed, LINE_TWO] })))).toEqual([{ text: "so I quit", emojis: [{ id: "fire", atSec: 0.95, order: 0 }] }]);
    // Rewritten in place (same key, other text): nothing draws, and the entry stays stored.
    const rewritten = document({ emojis: fire, lines: [LINE_ONE.map((word, index) => index === 2 ? { ...word, word: "left" } : word), LINE_TWO] });
    expect(placed(captionLayers(rewritten))).toEqual([]);
    expect(rewritten.studioEdits.captionEmojis).toEqual(fire);
    // Rewritten and re-timed: the old rule moved it onto the new word 100 ms away; now it draws nowhere.
    const moved = LINE_ONE.map((word, index) => index === 2 ? { ...word, word: "left", startSec: 0.7, endSec: 0.75 } : word);
    expect(placed(captionLayers(document({ emojis: fire, lines: [moved, LINE_TWO] })))).toEqual([]);
  });

  test("an emoji on a cut word draws nothing and does not move to a neighbour", () => {
    // "my" starts 400 ms after "quit", inside the tolerance: the cut word still owns the entry.
    const cut = document({ emojis: ON_QUIT, overrides: { deletedRanges: [{ startSec: 0.8, endSec: 1.15 }] } });
    expect(placed(captionLayers(cut))).toEqual([]);
    expect(cut.studioEdits.captionEmojis).toEqual(ON_QUIT);
  });

  test("a censored word takes no emoji", () => {
    const quit = LINE_ONE[2]!;
    const censored = document({
      emojis: { ...ON_QUIT, "3200": { id: "brain" } },
      overrides: {
        censorSegments: [{
          schemaVersion: 1, id: "10000000-0000-4000-8000-000000000001",
          sourceWordIds: [autoCensorWordId({ utteranceIndex: 0, wordIndex: 2, word: quit })],
          sourceStartSec: quit.startSec, sourceEndSec: quit.endSec, treatment: "caption_mask", paddingSec: 0, beepSettings: null,
          captionMaskPolicy: { replacement: "first_last", preservePunctuation: true },
          suggestionFingerprint: "a".repeat(64), policyVersion: "auto-censor-v1", enabled: true,
        }],
      },
    });
    expect(placed(captionLayers(censored)).map((cue) => cue.emojis.map((emoji) => emoji.id))).toEqual([["brain"]]);
  });

  test("a cue that already shows a typed emoji takes none", () => {
    const typed = LINE_ONE.map((word, index) => index === 0 ? { ...word, word: "🔥" } : word);
    const layers = captionLayers(document({ emojis: { ...ON_QUIT, "1600": { id: "rocket" } }, lines: [typed, LINE_TWO] }));
    expect(placed(layers)).toEqual([{ text: "my job today", emojis: [{ id: "rocket", atSec: 1.6, order: 0 }] }]);
  });

  test.each([
    ["Brand™", true], ["©2024", true], ["♥", true], ["‼", true],
    ["🔥", false], ["❤️", false], ["✌🏽", false], ["🇵🇰", false], ["#️⃣", false],
  ])("a cue with the typed text %p takes an added emoji: %p", (text, takes) => {
    const typed = LINE_ONE.map((word, index) => index === 0 ? { ...word, word: text } : word);
    const layers = captionLayers(document({ emojis: ON_QUIT, lines: [typed, LINE_TWO] }));
    expect(placed(layers).map((cue) => cue.emojis.map((emoji) => emoji.id))).toEqual(takes ? [["fire"]] : []);
  });

  test("RTL text anchors the same way", () => {
    const urdu = ["میں", "نے", "نوکری", "چھوڑ", "دی"].map((word, index): Word => ({ word, startSec: index * 0.35, endSec: index * 0.35 + 0.3, confidence: 1 }));
    const layers = captionLayers(document({ emojis: { "700": { id: "fire" } }, lines: [urdu] }));
    expect(placed(layers)).toEqual([{ text: "میں نے نوکری", emojis: [{ id: "fire", atSec: 0.7, order: 0 }] }]);
  });

  test("a dub target maps the word's time through the cut and joins the dub cue live then", () => {
    const override: CaptionOverride = {
      language: "ur",
      segments: [
        [{ text: "میں", startSec: 0, endSec: 0.5 }, { text: "نے", startSec: 0.5, endSec: 1 }],
        [{ text: "نوکری", startSec: 1.1, endSec: 1.6 }],
      ],
    };
    // 0.2 s is cut before "quit", so it plays at 0.6 s, inside the first dub cue.
    const doc = document({ emojis: { ...ON_QUIT, "1600": { id: "rocket" }, "3200": { id: "brain" } }, overrides: { deletedRanges: [{ startSec: 0.45, endSec: 0.65 }] } });
    expect(placed(captionLayers(doc, override))).toEqual([
      { text: "میں نے", emojis: [{ id: "fire", atSec: 0.6, order: 0 }] },
      { text: "نوکری", emojis: [{ id: "rocket", atSec: 1.4, order: 1 }] },
    ]);
  });

  test("the switch off draws none, and the stored entries stay", () => {
    const off = document({ emojis: ON_QUIT, preset: { emojis: false } });
    expect(captionLayers(off).every((layer) => layer.emojis.length === 0)).toBe(true);
    expect(captionLayers(document({ emojis: ON_QUIT, preset: { emojis: undefined } })).every((layer) => layer.emojis.length === 0)).toBe(true);
    expect(off.studioEdits.captionEmojis).toEqual(ON_QUIT);
  });

  test("every preset kind draws emojis: classic, Dynamic Style and Scene Style", () => {
    for (const id of ["bold-pop", "headline", "reveal"]) {
      const preset = { ...getCaptionPresetById(id)!.preset, emojis: true };
      const layers = captionLayers(document({ emojis: ON_QUIT, preset }));
      expect(layers.flatMap((layer) => layer.emojis)).toEqual([{ id: "fire", atSec: 0.8, order: 0 }]);
      const owner = layers.find((layer) => layer.emojis.length > 0)!;
      expect(owner.words.some((word) => word.startSec === 0.8)).toBe(true);
    }
  });

  test("on a Dynamic or Scene Style the emoji's word is its cue's hero; other cues and the switch off keep their roles", () => {
    const roles = (layers: readonly CompositionCaptionVisualLayer[]) => layers.map((layer) => layer.block?.roles ?? layer.scene?.roles);
    for (const id of ["headline", "reveal"]) {
      const preset = { ...getCaptionPresetById(id)!.preset, emojis: true };
      const plain = captionLayers(document({ preset }));
      const cue = plain.findIndex((layer) => layer.words.some((word) => word.text === "decision"));
      const before = roles(plain)[cue]!;
      // "decision", a body word the scorer did not pick ("honestly" is a filler: it never becomes the hero).
      const target = plain[cue]!.words.findIndex((word) => word.text === "decision");
      expect(before[target]).toBe("body");
      const key = String(Math.round(plain[cue]!.words[target]!.startSec * 1000));
      const withEmoji = captionLayers(document({ preset, emojis: { [key]: { id: "brain" } } }));
      expect(roles(withEmoji)[cue]![target]).toBe("hero");
      expect(roles(withEmoji).filter((_, index) => index !== cue)).toEqual(roles(plain).filter((_, index) => index !== cue));
      if (id === "headline") expect(withEmoji[cue]!.block!.rows).not.toEqual(plain[cue]!.block!.rows);
      // A manual emphasis on another word of the cue wins over the emoji.
      const other = plain[cue]!.words.findIndex((word) => word.text === "ever");
      const otherKey = String(Math.round(plain[cue]!.words[other]!.startSec * 1000));
      const overridden = captionLayers(document({ preset, emojis: { [key]: { id: "brain" } },
        overrides: { studioEdits: studioEditsSchema.parse({ framing: { mode: "center" }, captionEmojis: { [key]: { id: "brain" } }, captionEmphasis: { [otherKey]: "hero" } }) } }));
      expect(roles(overridden)[cue]![other]).toBe("hero");
      expect(roles(overridden)[cue]![target]).toBe("body");
      // Switched off with the entry still stored, or the cue already shows a typed emoji: the scorer's roles.
      expect(captionLayers(document({ preset: { ...preset, emojis: false }, emojis: { [key]: { id: "brain" } } })).map((layer) => layer.block ?? layer.scene))
        .toEqual(captionLayers(document({ preset: { ...preset, emojis: false } })).map((layer) => layer.block ?? layer.scene));
      const typed = LINE_TWO.map((word) => (word.word === "ever" ? { ...word, word: "ever🔥" } : word));
      const typedPlain = captionLayers(document({ preset, lines: [LINE_ONE, typed] }));
      const typedEmoji = captionLayers(document({ preset, lines: [LINE_ONE, typed], emojis: { [key]: { id: "brain" } } }));
      if (typedPlain[cue]!.words.some((word) => word.text.includes("🔥"))) expect(roles(typedEmoji)).toEqual(roles(typedPlain));
    }
  });

  test("an inserted scene moves the emoji with its word", () => {
    const scene = {
      schemaVersion: 1, id: "8ab9d330-688f-4574-932c-27ac661245c1", anchorSec: 1, durationSec: 1,
      content: { kind: "color", color: "#000000" }, motion: { entrance: "none", exit: "none" }, templateSnapshot: null,
    };
    const layers = captionLayers(document({ emojis: { "1600": { id: "rocket" } }, overrides: { sceneBlocks: [scene] } }));
    expect(layers.flatMap((layer) => layer.emojis)).toEqual([{ id: "rocket", atSec: 2.6, order: 0 }]);
  });

  test("subtitle cues never contain added emojis", () => {
    const doc = document({ emojis: ON_QUIT });
    expect(deriveCaptionCues(doc, { language: "en" })).toEqual(deriveCaptionCues(document({}), { language: "en" }));
  });
});
