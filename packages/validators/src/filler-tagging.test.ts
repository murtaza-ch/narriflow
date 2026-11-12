import { describe, expect, test } from "bun:test";

import { detectClipCleanupRanges } from "./clip-cleanup";
import { normalizeTranscriptSliceForClip } from "./clip-timing";
import { MIN_KEPT_SEGMENT_SEC } from "./edit-ranges";
import {
  acceptFillerTags,
  chunkTranscriptForFillerTagging,
  collectFillerKeys,
  FILLER_TAGGING_CHUNK_WORDS,
  fillerTagLetters,
  fillerWordKey,
  type FillerTaggingChunk,
} from "./filler-tagging";
import type { TranscriptUtterance, TranscriptWord } from "./transcript";

function word(startSec: number, text: string, endSec = startSec + 0.2): TranscriptWord {
  return { word: text, startSec, endSec, confidence: null };
}
function utterance(speaker: number | null, words: TranscriptWord[], index = 0): TranscriptUtterance {
  return { index, speaker, speakerLabel: "S", startSec: words[0]!.startSec, endSec: words.at(-1)!.endSec, text: words.map((w) => w.word).join(" "), confidence: null, words };
}
const report = (fillers: unknown[]) => ({ fillers });
const tag = (id: number, text: string, extra: Record<string, unknown> = {}) => ({ id, text, is_dictionary_word: false, kind: "hesitation_sound", ...extra });

describe("chunkTranscriptForFillerTagging", () => {
  test("renders speaker lines with chunk-local ids, as evaluated", () => {
    const chunks = chunkTranscriptForFillerTagging([utterance(0, [word(0, "Also,"), word(0.3, "äh,"), word(0.6, "wir.")]), utterance(1, [word(1, "Ja.")], 1)], "de");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.prompt).toBe("Language: de\nTokens:\nS0: 0:Also, 1:äh, 2:wir.\nS1: 3:Ja.");
  });

  test("never exceeds the evaluated chunk size and keeps every word", () => {
    const words = Array.from({ length: 1234 }, (_, i) => word(i * 0.3, `w${i % 7 === 0 ? "." : ""}`));
    const chunks = chunkTranscriptForFillerTagging([utterance(0, words)], "fr");
    expect(chunks.every((c) => c.tokens.length <= FILLER_TAGGING_CHUNK_WORDS)).toBe(true);
    expect(chunks.reduce((n, c) => n + c.tokens.length, 0)).toBe(1234);
  });

  test("a token that could forge prompt structure leaves the chunk untagged", () => {
    for (const text of ["a\nS0:", "x y", "um 17:go", "a\u2028S0:", "a\u00a0b", "a\u0000", "\tum"]) {
      expect(chunkTranscriptForFillerTagging([utterance(0, [word(0, "hola"), word(0.3, text)])], "es")[0]!.prompt).toBeNull();
    }
  });

  test("a colon inside a token is shown fullwidth, so it never reads as an id", () => {
    const chunk = chunkTranscriptForFillerTagging([utterance(0, [word(0, "sagte:"), word(0.3, "10:30"), word(0.6, "12:um"), word(0.9, "S1:")])], "de")[0]!;
    expect(chunk.prompt).toBe("Language: de\nTokens:\nS0: 0:sagte\uFF1A 1:10\uFF1A30 2:12\uFF1Aum 3:S1\uFF1A");
    // The id-shaped token can never be accepted (digits), and letters still compare.
    expect(acceptFillerTags(chunk, report([tag(2, "um"), tag(2, "12:um")]))).toEqual([]);
    const withColon = chunkTranscriptForFillerTagging([utterance(0, [word(0, "äh:")])], "de")[0]!;
    expect(acceptFillerTags(withColon, report([tag(0, "äh\uFF1A")]))).toEqual([0]);
  });

  test("an unknown speaker renders as S? and keys as -", () => {
    const chunks = chunkTranscriptForFillerTagging([utterance(null, [word(0, "euh")])], "fr");
    expect(chunks[0]!.prompt).toContain("S?: 0:euh");
    expect(fillerWordKey(null, word(0, "euh"))).toBe("-|euh|0.000|0.200");
  });
});

describe("acceptFillerTags", () => {
  const chunk = (texts: string[]): FillerTaggingChunk =>
    chunkTranscriptForFillerTagging([utterance(0, texts.map((t, i) => word(i, t)))], "xx")[0]!;

  test("accepts an explicit non-word hesitation whose letters match the token", () => {
    expect(acceptFillerTags(chunk(["Also", "äh,", "wir"]), report([tag(1, "äh")]))).toEqual([1]);
    expect(acceptFillerTags(chunk(["Ну", "э-э-э,", "да"]), report([tag(1, "эээ")]))).toEqual([1]);
    expect(acceptFillerTags(chunk(["euh"]), report([tag(0, "Euh")]))).toEqual([0]);
  });

  test("rejects anything the model does not explicitly call a non-word hesitation", () => {
    const c = chunk(["so", "eh", "then"]);
    expect(acceptFillerTags(c, report([tag(1, "eh", { is_dictionary_word: true })]))).toEqual([]);
    expect(acceptFillerTags(c, report([tag(1, "eh", { kind: "discourse_word" })]))).toEqual([]);
    expect(acceptFillerTags(c, report([tag(1, "eh", { kind: "unsure" })]))).toEqual([]);
  });

  test("rejects ids out of range or text that names a different token", () => {
    const c = chunk(["so", "eh", "then"]);
    expect(acceptFillerTags(c, report([tag(3, "eh"), tag(-1, "eh"), tag(1.5, "eh")]))).toEqual([]);
    expect(acceptFillerTags(c, report([tag(0, "eh")]))).toEqual([]);
  });

  test("rejects long tokens, numbers and all-capitals acronyms", () => {
    expect(acceptFillerTags(chunk(["eeeeeeem"]), report([tag(0, "eeeeeeem")]))).toEqual([]);
    expect(acceptFillerTags(chunk(["eh2"]), report([tag(0, "eh2")]))).toEqual([]);
    expect(acceptFillerTags(chunk(["٣"]), report([tag(0, "٣")]))).toEqual([]);
    expect(acceptFillerTags(chunk(["UM"]), report([tag(0, "UM")]))).toEqual([]);
    expect(acceptFillerTags(chunk(["ER"]), report([tag(0, "er")]))).toEqual([]);
  });

  test("any entry that rejects a token vetoes it, in either order (Sol v3 P1-2)", () => {
    const c = chunk(["on", "a", "fini"]);
    const word = { id: 1, text: "a", is_dictionary_word: true, kind: "other_word" };
    expect(acceptFillerTags(c, report([tag(1, "a"), word]))).toEqual([]);
    expect(acceptFillerTags(c, report([word, tag(1, "a")]))).toEqual([]);
    expect(acceptFillerTags(c, report([tag(1, "a"), tag(1, "x")]))).toEqual([]);
    expect(acceptFillerTags(c, report([tag(1, "a"), tag(1, "a")]))).toEqual([1]);
  });

  test("malformed reports and unsafe chunks accept nothing", () => {
    const c = chunk(["eh"]);
    for (const bad of [null, "x", { fillers: "x" }, { fillers: [{ id: 0 }] }, {}]) expect(acceptFillerTags(c, bad)).toEqual([]);
    const unsafe = chunkTranscriptForFillerTagging([utterance(0, [word(0, "eh"), word(0.3, "x\nS1:")])], "es")[0]!;
    expect(acceptFillerTags(unsafe, report([tag(0, "eh")]))).toEqual([]);
  });

  test("counts letters, not marks: a mark or joiner alone is not a filler", () => {
    expect(acceptFillerTags(chunk(["अं"]), report([tag(0, "अं")]))).toEqual([0]);
    expect(acceptFillerTags(chunk(["\u0301"]), report([tag(0, "\u0301")]))).toEqual([]);
    expect(acceptFillerTags(chunk(["\u200c"]), report([tag(0, "\u200c")]))).toEqual([]);
    expect(acceptFillerTags(chunk(["..."]), report([tag(0, "...")]))).toEqual([]);
    // Six letters with marks is accepted; seven letters is not.
    expect(acceptFillerTags(chunk(["eeeemm"]), report([tag(0, "eeeemm")]))).toEqual([0]);
    expect(acceptFillerTags(chunk(["eeeeemm"]), report([tag(0, "eeeeemm")]))).toEqual([]);
  });

  test("composed and decomposed forms of the same letters agree", () => {
    expect(acceptFillerTags(chunk(["a\u0308h"]), report([tag(0, "\u00e4h")]))).toEqual([0]);
  });

  test("keeps joiners: a Persian word with ZWNJ must match exactly", () => {
    expect(fillerTagLetters("می‌خواهم")).not.toBe(fillerTagLetters("میخواهم"));
  });
});

describe("collectFillerKeys", () => {
  test("drops a key two source words share (two speakers, same text and timing)", () => {
    const chunks = chunkTranscriptForFillerTagging([utterance(0, [word(1, "um")]), utterance(0, [word(1, "um")], 1), utterance(1, [word(2, "eh")], 2)], "pt");
    const all = chunks.flatMap((c) => c.tokens);
    expect(all).toHaveLength(3);
    const accepted = chunks.map((c) => c.tokens.map((_, i) => i));
    expect(collectFillerKeys(chunks, accepted)).toEqual([fillerWordKey(1, word(2, "eh"))]);
  });
});

describe("collectFillerKeys drops stretched real words", () => {
  const keysFor = (lang: string, texts: string[], acceptedTexts: string[]) => {
    const chunks = chunkTranscriptForFillerTagging([utterance(0, texts.map((t, i) => word(i, t)))], lang);
    const accepted = chunks.map((c) => c.tokens.flatMap((t, i) => acceptedTexts.includes(t.word.word) ? [i] : []));
    return collectFillerKeys(chunks, accepted).map((k) => k.split("|")[1]);
  };

  test("Portuguese Eee and eeem, Russian Иии: their bare forms are words in the transcript", () => {
    expect(keysFor("pt", ["Eee,", "e", "eu", "espero"], ["Eee,"])).toEqual([]);
    expect(keysFor("pt", ["pensando", "eeem,", "quer", "dizer,", "em", "chamar"], ["eeem,"])).toEqual([]);
    expect(keysFor("ru", ["Иии,", "ну,", "и", "обсудить"], ["Иии,"])).toEqual([]);
  });

  test("spelling variants still find the plain word (Sol v4): doubled letters, Turkish İ, final sigma, joiners, apostrophes", () => {
    expect(keysFor("de", ["also", "daaann,", "dann", "gehen"], ["daaann,"])).toEqual([]);
    expect(keysFor("tr", ["bu", "İiil,", "il", "güzel"], ["İiil,"])).toEqual([]);
    expect(keysFor("el", ["όπως", "ωσσς,", "ως", "εδώ"], ["ωσσς,"])).toEqual([]);
    expect(keysFor("fa", ["من", "و\u200cو\u200cو", "و", "تو"], ["و\u200cو\u200cو"])).toEqual([]);
    expect(keysFor("it", ["un", "pooo'", "po'", "di"], ["pooo'"])).toEqual([]);
  });

  test("a stretched hesitation stays when its short form is only written as a hesitation", () => {
    expect(keysFor("ru", ["Э,", "я", "думаю,", "эээ,", "что"], ["эээ,"])).toEqual(["эээ,"]);
    expect(keysFor("de", ["also", "ähhh,", "wir"], ["ähhh,"])).toEqual(["ähhh,"]);
    // Unstretched tags are never affected.
    expect(keysFor("pt", ["e", "hum,", "não"], ["hum,"])).toEqual(["hum,"]);
  });

  test("an accepted short form cannot vouch for itself", () => {
    // "e" was (wrongly) accepted once, but it is still used as a bare word elsewhere.
    const chunks = chunkTranscriptForFillerTagging([utterance(0, [word(0, "Eee,"), word(1, "e"), word(2, "eu"), word(3, "e")])], "pt");
    expect(collectFillerKeys(chunks, [[0, 1]]).map((k) => k.split("|")[1])).toEqual(["e"]);
  });
});

describe("source keys survive clip slicing exactly", () => {
  test("a key from sub-millisecond source times matches its sliced word", () => {
    const source = [utterance(0, [word(0, "Also", 0.5), word(1.2344999, "äh", 1.5005), word(2, "wir", 9)])];
    const keys = new Set([fillerWordKey(0, source[0]!.words[1]!)]);
    const slice = normalizeTranscriptSliceForClip(source, 0, 10);
    expect(detectClipCleanupRanges(slice, { startSec: 0, endSec: 10 }, { removeSilences: false, removeFillerWords: true, quietRanges: null, languageCode: "de", aiFillerKeys: keys }))
      .toHaveLength(1);
  });

  test("an untagged word clamped onto a tagged word's identity cuts neither (Sol P1-1)", () => {
    // Same speaker: "um" [0.1,1.2] untagged, "um" [0.6,1.2] tagged. A clip at 0.6 clamps the first to [0.6,1.2].
    const source = [utterance(0, [word(0.1, "um", 1.2), word(0.6, "um", 1.2), word(1.3, "dann", 2), word(2.1, "weiter", 9)])];
    const keys = new Set([fillerWordKey(0, source[0]!.words[1]!)]);
    for (const start of [0.6, 0.3]) {
      const slice = normalizeTranscriptSliceForClip(source, start, 10);
      expect(detectClipCleanupRanges(slice, { startSec: start, endSec: 10 }, { removeSilences: false, removeFillerWords: true, quietRanges: null, languageCode: "de", aiFillerKeys: keys }))
        .toEqual([]);
    }
  });

  test("a tagged word touching either clip edge is never cut", () => {
    const source = [utterance(0, [word(0, "äh", 0.4), word(0.5, "wir", 5), word(5.1, "äh", 5.5)])];
    const keys = new Set([fillerWordKey(0, source[0]!.words[0]!), fillerWordKey(0, source[0]!.words[2]!)]);
    const slice = normalizeTranscriptSliceForClip(source, 0, 5.5);
    expect(detectClipCleanupRanges(slice, { startSec: 0, endSec: 5.5 }, { removeSilences: false, removeFillerWords: true, quietRanges: null, languageCode: "de", aiFillerKeys: keys }))
      .toEqual([]);
  });
});

describe("AI keys drive cleanup only for languages without a list", () => {
  const window = { startSec: 0, endSec: 10 };
  const slice = [utterance(0, [word(0, "Also,", 0.5), word(0.6, "äh,", 0.9), word(0.95, "wir", 2), word(2.1, "gehen", 10)])];
  const keys = new Set([fillerWordKey(0, slice[0]!.words[1]!)]);

  test("a tagged German filler is cut", () => {
    expect(detectClipCleanupRanges(slice, window, { removeSilences: false, removeFillerWords: true, quietRanges: null, languageCode: "de", aiFillerKeys: keys }))
      .toEqual([{ startSec: 0.6, endSec: 0.9 }]);
  });

  test("no keys, wrong speaker or shifted timing cuts nothing", () => {
    const base = { removeSilences: false, removeFillerWords: true, quietRanges: null, languageCode: "de" };
    expect(detectClipCleanupRanges(slice, window, base)).toEqual([]);
    expect(detectClipCleanupRanges(slice, window, { ...base, aiFillerKeys: new Set([fillerWordKey(1, slice[0]!.words[1]!)]) })).toEqual([]);
    expect(detectClipCleanupRanges(slice, window, { ...base, aiFillerKeys: new Set([fillerWordKey(0, { ...slice[0]!.words[1]!, startSec: 0.601 })]) })).toEqual([]);
  });

  test("a 1 ms real word between two tagged fillers is kept (Sol v3 P1-1)", () => {
    const fr = [utterance(0, [word(0, "on", 1), word(1, "euh", 2), word(2, "a", 2.001), word(2.001, "euh", 3), word(3, "fini", 20)])];
    const keys = new Set([fillerWordKey(0, fr[0]!.words[1]!), fillerWordKey(0, fr[0]!.words[3]!)]);
    const cuts = detectClipCleanupRanges(fr, { startSec: 0, endSec: 20 }, { removeSilences: false, removeFillerWords: true, quietRanges: null, languageCode: "fr", aiFillerKeys: keys });
    expect(cuts.length).toBeGreaterThan(0);
    // Nothing cut overlaps the kept word, and it stays renderable.
    expect(cuts.every((c) => c.endSec <= 2 + 1e-9 || c.startSec >= 2.001 - 1e-9)).toBe(true);
    const gap = cuts.find((c) => c.startSec >= 2.001 - 1e-9)!.startSec - cuts.find((c) => c.endSec <= 2 + 1e-9)!.endSec;
    expect(gap).toBeGreaterThanOrEqual(MIN_KEPT_SEGMENT_SEC);
  });

  test("English ignores AI keys and keeps its list", () => {
    const en = [utterance(0, [word(0, "So", 0.5), word(0.6, "um,", 0.9), word(0.95, "we", 10)])];
    expect(detectClipCleanupRanges(en, window, { removeSilences: false, removeFillerWords: true, quietRanges: null, languageCode: "en", aiFillerKeys: new Set() }))
      .toEqual([{ startSec: 0.6, endSec: 0.9 }]);
  });
});
