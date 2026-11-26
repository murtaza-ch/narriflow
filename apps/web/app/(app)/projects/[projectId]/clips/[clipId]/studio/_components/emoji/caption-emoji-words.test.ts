import { describe, expect, test } from "bun:test";
import { buildEditedTimeMap, captionWordKey, type EditorDocument } from "@narriflow/validators";
import { emojiFixtureDocument, emojiFixtureLayersFor } from "./caption-emoji-fixture";
import { captionEmojiFingerprint, planCaptionEmojiAnswer } from "./caption-emoji-runs";
import { compositeToBaseEdited } from "../studio-editing-session";
import { chipVisualOrder } from "./emoji-chip-order";
import {
  captionEmojiHiddenReason,
  captionEmojiWords,
  emojiMoveChoices,
  typedEmojiCueRanges,
  heroWordKeys,
  lineAddWord,
  lineEmojiTargets,
  liveCueEmojiChips,
  placeCaptionEmojis,
} from "./caption-emoji-words";

const identity = (sec: number) => sec;

function modelOf(document: EditorDocument) {
  return captionEmojiWords(document, buildEditedTimeMap(document.deletedRanges, { startSec: document.clipStartSec, endSec: document.clipEndSec }));
}

function wordIndex(document: EditorDocument, text: string): number {
  return modelOf(document).words.findIndex((word) => word.text.replace(/[^\p{L}]/gu, "") === text);
}

describe("caption emoji words", () => {
  test("every word of the slice is listed with its Word Key and line", () => {
    const document = emojiFixtureDocument({ presetId: "bold-pop" });
    const model = modelOf(document);
    expect(model.words.length).toBe(document.transcriptSlice.flatMap((line) => line.words).length);
    expect(model.lines.length).toBe(4);
    const first = document.transcriptSlice[0]!.words[0]!;
    expect(model.words[0]).toMatchObject({ key: captionWordKey(first.startSec), text: "This", line: 0, masked: false });
    expect(model.byKey.get(captionWordKey(first.startSec))).toBe(0);
  });

  test("a cut word has no edited time and its emoji is not counted as shown", () => {
    const base = emojiFixtureDocument({ presetId: "bold-pop" });
    const idea = base.transcriptSlice[0]!.words[2]!;
    const document = { ...base, deletedRanges: [{ startSec: idea.startSec, endSec: idea.endSec }] };
    const model = modelOf(document);
    const index = wordIndex(document, "idea");
    expect(model.words[index]!.editedStartSec).toBeNull();
    const placement = placeCaptionEmojis(document.studioEdits.captionEmojis, model);
    expect(placement.byWord.has(index)).toBe(true);
    expect(placement.shown).toBe(3);
    expect(lineEmojiTargets(model, placement, [0]).map((target) => target.text)).toEqual(["idea"]);
  });

  test("an entry a few ms off its word resolves to it and keeps its own key", () => {
    const base = emojiFixtureDocument({ presetId: "bold-pop" });
    const word = base.transcriptSlice[1]!.words[4]!;
    const offKey = captionWordKey(word.startSec + 0.03);
    const document = { ...base, studioEdits: { ...base.studioEdits, captionEmojis: { [offKey]: { id: "flame" } } } };
    const model = modelOf(document);
    const placement = placeCaptionEmojis(document.studioEdits.captionEmojis, model);
    const [target] = lineEmojiTargets(model, placement, [1]);
    expect(target).toMatchObject({ key: offKey, text: word.word, current: { id: "flame" } });
  });
});

describe("On screen now chips", () => {
  test("a classic cue matches its words by time and letters", () => {
    const document = emojiFixtureDocument({ presetId: "bold-pop" });
    const layers = emojiFixtureLayersFor(document, {});
    const model = modelOf(document);
    const placement = placeCaptionEmojis(document.studioEdits.captionEmojis, model);
    const row = liveCueEmojiChips(layers[0]!, model, placement, identity);
    expect(row.direction).toBe("ltr");
    expect(row.chips.length).toBe(layers[0]!.words.length);
    expect(row.chips.every((chip) => chip.target !== null)).toBe(true);
    const withEmoji = row.chips.filter((chip) => chip.target?.current);
    expect(withEmoji.map((chip) => chip.target!.text)).toEqual(["idea"]);
  });

  test("Scene and Dynamic cues use their Word Keys", () => {
    for (const presetId of ["horizon", "headline"]) {
      const document = emojiFixtureDocument({ presetId });
      const layers = emojiFixtureLayersFor(document, {});
      const model = modelOf(document);
      const placement = placeCaptionEmojis(document.studioEdits.captionEmojis, model);
      const row = liveCueEmojiChips(layers[0]!, model, placement, identity);
      expect(row.chips.length).toBeGreaterThan(0);
      expect(row.chips.every((chip) => chip.target !== null)).toBe(true);
      expect(row.chips.some((chip) => chip.target?.current?.id === "bulb")).toBe(true);
    }
  });

  test("an Urdu cue reads right to left: chips from the left edge, the first word rightmost", () => {
    const document = emojiFixtureDocument({ presetId: "bold-pop", rtl: true });
    const layers = emojiFixtureLayersFor(document, { rtl: true });
    const model = modelOf(document);
    const placement = placeCaptionEmojis(document.studioEdits.captionEmojis, model);
    const row = liveCueEmojiChips(layers[0]!, model, placement, identity);
    expect(row.direction).toBe("rtl");
    expect(row.chips.map((chip) => chip.text)).toEqual(layers[0]!.words.map((word) => word.text).reverse());
    expect(row.chips.at(-1)!.target!.text).toBe(document.transcriptSlice[0]!.words[0]!.word);
  });

  test("a classic cue split by an inserted scene: the word that resumes after it keeps its target", () => {
    const WORDS = ["the", "biggest", "mistake", "people", "make", "is", "waiting", "until"];
    // Words every 0.4 s from 0.2 s, four per cue: the 2 s scene at 1.7 s cuts the first cue inside "people" (1.4-1.75 s).
    const base = emojiFixtureDocument({ presetId: "electric", preset: { wordsPerCue: 4 } });
    const words = WORDS.map((word, index) => ({ word, startSec: 0.2 + index * 0.4, endSec: 0.55 + index * 0.4, confidence: 1 }));
    const document: EditorDocument = {
      ...base,
      clipEndSec: 3.8,
      transcriptSlice: [{ index: 0, speaker: 0, speakerLabel: "Speaker 1", startSec: 0.2, endSec: 3.35, text: WORDS.join(" "), confidence: 1, words }],
      studioEdits: { ...base.studioEdits, captionEmojis: { "1400": { id: "flame" } } },
      sceneBlocks: [{ schemaVersion: 1, id: "8ab9d330-688f-4574-932c-27ac661245c2", anchorSec: 1.7, durationSec: 2, content: { kind: "color", color: "#000000" }, motion: { entrance: "none", exit: "none" }, templateSnapshot: null }],
    };
    const layers = emojiFixtureLayersFor(document, {});
    const resumed = layers[1]!;
    expect(resumed.words.map((word) => word.text.toLowerCase())).toEqual(["people"]);
    const model = modelOf(document);
    const row = liveCueEmojiChips(resumed, model, placeCaptionEmojis(document.studioEdits.captionEmojis, model), (sec) => compositeToBaseEdited(document, sec));
    expect(row.chips.map((chip) => chip.target && { key: chip.target.key, current: chip.target.current })).toEqual([{ key: "1400", current: { id: "flame" } }]);
  });

  test("a caption with no transcript words (a dub) offers no targets", () => {
    const document = emojiFixtureDocument({ presetId: "bold-pop" });
    const [layer] = emojiFixtureLayersFor(document, {});
    const dubbed = { ...layer!, words: layer!.words.map((word) => ({ ...word, text: "otro" })) };
    const model = modelOf(document);
    const row = liveCueEmojiChips(dubbed, model, placeCaptionEmojis(undefined, model), identity);
    expect(row.chips.every((chip) => chip.target === null)).toBe(true);
  });
});

describe("Add emoji on a line", () => {
  const document = emojiFixtureDocument({ presetId: "bold-pop" });
  const model = modelOf(document);
  const empty = placeCaptionEmojis(undefined, model);
  const line = document.transcriptSlice[1]!;
  const none = { heroKeys: new Set<string>() };

  test("anchors to the word under the playhead when the playhead is inside the line", () => {
    const money = line.words[3]!;
    const word = lineAddWord(model, empty, [1], { ...none, playheadSec: money.startSec + 0.05 });
    expect(model.words[word!]!.text).toBe("money");
  });

  test("outside the line, the hero word wins, else the longest word (the later one on a tie)", () => {
    const hero = lineAddWord(model, empty, [1], { playheadSec: 0, heroKeys: new Set([captionWordKey(line.words[1]!.startSec)]) });
    expect(model.words[hero!]!.text).toBe("made");
    const longest = lineAddWord(model, empty, [1], { ...none, playheadSec: 0 });
    // "money" and "month" both have five letters: the later one.
    expect(model.words[longest!]!.text).toBe("month");
  });

  test("passes over words that already hold an emoji while another is free", () => {
    const money = line.words[3]!;
    const placement = placeCaptionEmojis({ [captionWordKey(money.startSec)]: { id: "money-bag" } }, model);
    const word = lineAddWord(model, placement, [1], { ...none, playheadSec: 0 });
    expect(model.words[word!]!.text).not.toBe("money");
  });

  test("a fully cut line offers nothing", () => {
    const cut = { ...document, deletedRanges: [{ startSec: line.startSec, endSec: line.endSec }] };
    const cutModel = modelOf(cut);
    expect(lineAddWord(cutModel, placeCaptionEmojis(undefined, cutModel), [1], { ...none, playheadSec: 0 })).toBeNull();
  });
});

describe("AI suggestions against local edits", () => {
  test("picks on words cut since the save are dropped, and so are keys that are not a word's own (no nearest-time match)", () => {
    const base = emojiFixtureDocument({ presetId: "bold-pop" });
    const [first, second] = [base.transcriptSlice[0]!.words[2]!, base.transcriptSlice[2]!.words[2]!];
    const document = { ...base, deletedRanges: [{ startSec: first.startSec, endSec: first.endSec }] };
    const plan = planCaptionEmojiAnswer({
      start: undefined,
      current: undefined,
      answer: {
        emojis: {
          [captionWordKey(first.startSec)]: { id: "bulb" },
          [captionWordKey(second.startSec)]: { id: "party" },
          [captionWordKey(second.startSec + 0.02)]: { id: "sun" },
          "999999": { id: "flame" },
        },
      },
      fingerprint: captionEmojiFingerprint(modelOf(base)),
      model: modelOf(document),
    });
    expect(plan.kind === "replace" && plan.value).toEqual({ [captionWordKey(second.startSec)]: { id: "party" } });
  });

  test("hero keys come from Scene and Dynamic cues only", () => {
    const scene = emojiFixtureLayersFor(emojiFixtureDocument({ presetId: "horizon" }), {});
    expect(heroWordKeys(scene).size).toBeGreaterThan(0);
    const classic = emojiFixtureLayersFor(emojiFixtureDocument({ presetId: "bold-pop" }), {});
    expect(heroWordKeys(classic).size).toBe(0);
  });
});

describe("mixed-direction chips", () => {
  const MIXED = ["مرحبا", "New", "York", "الآن"];

  test("chips follow the caption word order: an embedded English phrase keeps its own order", () => {
    // Left to right on screen: الآن New York مرحبا.
    expect(chipVisualOrder(MIXED, "rtl")).toEqual([3, 1, 2, 0]);
    expect(chipVisualOrder(["This", "one", "idea"], "ltr")).toEqual([0, 1, 2]);
  });

  test("the live cue's chips come out left to right, each with its own word", () => {
    const document = emojiFixtureDocument({ presetId: "bold-pop", rtl: true });
    const { scene: _scene, block: _block, ...layer } = emojiFixtureLayersFor(document, { rtl: true })[0]!;
    const mixed = { ...layer, language: "ar", words: MIXED.map((text, at) => ({ text, startSec: 99 + at, endSec: 99.2 + at })) };
    const model = modelOf(document);
    const row = liveCueEmojiChips(mixed, model, placeCaptionEmojis(undefined, model), identity);
    expect(row.chips.map((chip) => chip.text)).toEqual(["الآن", "New", "York", "مرحبا"]);
  });
});

describe("move to another word", () => {
  test("offers the anchor's line in visual order, the current marked, minus cut, censored and occupied words", () => {
    const base = emojiFixtureDocument({ presetId: "bold-pop" });
    // Line 0: "This one idea changed everything for my business." with 💡 on "idea".
    const line = base.transcriptSlice[0]!;
    const cut = line.words[4]!;
    const second = captionWordKey(line.words[6]!.startSec);
    const document = {
      ...base,
      deletedRanges: [{ startSec: cut.startSec - 0.01, endSec: cut.endSec + 0.01 }],
      studioEdits: { ...base.studioEdits, captionEmojis: { ...base.studioEdits.captionEmojis, [second]: { id: "flame" } } },
    };
    const model = modelOf(document);
    const placement = placeCaptionEmojis(document.studioEdits.captionEmojis, model);
    const idea = wordIndex(document, "idea");
    expect(emojiMoveChoices(model, placement, idea, "ltr").map((choice) => [choice.text, choice.current])).toEqual([
      ["This", false],
      ["one", false],
      ["idea", true],
      ["changed", false],
      ["for", false],
      ["business.", false],
    ]);
  });

  test("RTL lines are offered right to left on screen", () => {
    const document = emojiFixtureDocument({ presetId: "bold-pop", rtl: true });
    const model = modelOf(document);
    const placement = placeCaptionEmojis(document.studioEdits.captionEmojis, model);
    const [word] = [...placement.byWord.keys()];
    const choices = emojiMoveChoices(model, placement, word!, "rtl");
    const lineWords = document.transcriptSlice[model.words[word!]!.line]!.words.map((entry) => entry.word);
    expect(choices.map((choice) => choice.text)).toEqual([...lineWords].reverse());
  });
});

describe("why a stored emoji does not draw", () => {
  test("cut, censored, or a cue that already shows a typed emoji", () => {
    const base = emojiFixtureDocument({ presetId: "bold-pop" });
    const typed = { ...base, transcriptSlice: base.transcriptSlice.map((line, at) => (at === 3 ? { ...line, words: line.words.map((word, index) => (index === 1 ? { ...word, word: "it🔥" } : word)) } : line)) };
    const layers = emojiFixtureLayersFor(typed, {});
    const ranges = typedEmojiCueRanges(layers, identity);
    expect(ranges.length).toBeGreaterThan(0);
    const model = modelOf(typed);
    const typedWord = model.words.findIndex((word) => word.text === "it🔥");
    expect(captionEmojiHiddenReason(model.words[typedWord]!, ranges)).toBe("typed-emoji");
    expect(captionEmojiHiddenReason(model.words[0]!, ranges)).toBeNull();
    expect(captionEmojiHiddenReason({ ...model.words[0]!, editedStartSec: null, editedEndSec: null }, ranges)).toBe("cut");
    expect(captionEmojiHiddenReason({ ...model.words[0]!, masked: true }, ranges)).toBe("censored");
  });
});
