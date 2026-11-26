import { describe, expect, test } from "bun:test";
import { deriveCaptionLines } from "@narriflow/composition-plan";
import {
  applyWithHistory,
  autoCensorWordId,
  buildClipCutPlan,
  captionPresetSchema,
  captionWordKey,
  createEditorHistory,
  editorDocumentSchema,
  isCensorSegmentStale,
  joinTranscriptWords,
  studioEditsSchema,
  type CensorSegment,
  type TranscriptUtterance,
  undoEditor,
} from "@narriflow/validators";
import { captionEmojiWords, placeCaptionEmojis } from "./emoji/caption-emoji-words";
import {
  addCaptionRowAfter,
  captionRowAddress,
  deleteCaptionRow,
  replaceCaptionRowText,
  resolveCaptionRow,
  type CaptionRow,
} from "./subtitle-lines";
import { carryCensorWordIds, moveWordKeyedEdits, transcriptEditActions } from "./subtitle-word-carry";

type Word = [word: string, startSec: number, endSec: number];

function utterance(index: number, words: Word[], speaker = 0): TranscriptUtterance {
  return {
    index, speaker, speakerLabel: `Speaker ${speaker + 1}`, startSec: words[0]![1], endSec: words.at(-1)![2],
    text: joinTranscriptWords(words.map(([word]) => ({ word }))), confidence: 1,
    words: words.map(([word, startSec, endSec]) => ({ word, startSec, endSec, confidence: 1 })),
  };
}

// A row is any run of an utterance's words; the plan groups this line at 3 words per cue as
// "We threw" / "a huge party for" / "the whole team.".
const LINE: Word[] = [
  ["We", 1.0, 1.2], ["threw", 1.25, 1.5], ["a", 1.55, 1.6], ["huge", 1.65, 1.9], ["party", 2.0, 2.4],
  ["for", 2.45, 2.6], ["the", 2.65, 2.75], ["whole", 2.8, 3.1], ["team.", 3.15, 3.6],
];
const NEXT: Word[] = [["Everyone", 4.0, 4.5], ["came.", 4.55, 5.0]];
const lines = [utterance(0, LINE), utterance(1, NEXT, 1)];
const middle: CaptionRow = { utterance: 0, words: [3, 4, 5] };

const key = (sec: number) => captionWordKey(sec);
const times = (line: TranscriptUtterance) => line.words.map((word) => [word.word, word.startSec, word.endSec]);

function censorOn(slice: readonly TranscriptUtterance[], utteranceAt: number, wordAt: number): CensorSegment {
  const word = slice[utteranceAt]!.words[wordAt]!;
  return {
    schemaVersion: 1, id: "10000000-0000-4000-8000-000000000001",
    sourceWordIds: [autoCensorWordId({ utteranceIndex: slice[utteranceAt]!.index, wordIndex: wordAt, word })],
    sourceStartSec: word.startSec, sourceEndSec: word.endSec, treatment: "caption_mask", paddingSec: 0, beepSettings: null,
    captionMaskPolicy: { replacement: "asterisks", preservePunctuation: true }, suggestionFingerprint: null,
    policyVersion: "auto-censor-v1", enabled: true,
  };
}

/** The words each emoji draws on, by the plan's anchor rule. */
function emojiWords(slice: TranscriptUtterance[], entries: Record<string, { id: string; word?: string }>) {
  const model = captionEmojiWords({ transcriptSlice: slice, censorSegments: [] }, buildClipCutPlan([], { startSec: 0, endSec: 10 }).map);
  const placement = placeCaptionEmojis(entries, model);
  return Object.fromEntries([...placement.byWord.values()].map((placed) => [placed.ref.id, model.words[placed.word]!.text]));
}

describe("caption row edits", () => {
  test("the same number of words rewrites their text; every time and Word Key stays", () => {
    const { lines: next, movedKeys } = replaceCaptionRowText(lines, middle, "huge feast for");
    expect(next[0]!.words.map((word) => word.word)).toEqual(["We", "threw", "a", "huge", "feast", "for", "the", "whole", "team."]);
    expect(next[0]!.words.map((word) => [word.startSec, word.endSec])).toEqual(LINE.map(([, start, end]) => [start, end]));
    expect(next[0]!.text).toBe("We threw a huge feast for the whole team.");
    expect(movedKeys.size).toBe(0);
    // Untouched words are the same objects; so is the other utterance.
    expect(next[0]!.words[3]).toBe(lines[0]!.words[3]!);
    expect(next[1]).toBe(lines[1]!);
  });

  test("a different number re-times only the row's span, evenly; every other word keeps its time", () => {
    const { lines: next, movedKeys } = replaceCaptionRowText(lines, middle, "massive surprise party for");
    const words = next[0]!.words;
    expect(words.map((word) => word.word)).toEqual(["We", "threw", "a", "massive", "surprise", "party", "for", "the", "whole", "team."]);
    expect(times(next[0]!).slice(0, 3)).toEqual(times(lines[0]!).slice(0, 3));
    expect(times(next[0]!).slice(7)).toEqual(times(lines[0]!).slice(6));
    // 1.65 to 2.6 shared by four words.
    expect(words.slice(3, 7).map((word) => [Number(word.startSec.toFixed(4)), Number(word.endSec.toFixed(4))])).toEqual([
      [1.65, 1.8875], [1.8875, 2.125], [2.125, 2.3625], [2.3625, 2.6],
    ]);
    // "party" and "for" kept their text: their keys move with them.
    expect([...movedKeys]).toEqual([[key(2.0), key(2.125)], [key(2.45), key(2.3625)]]);
    expect(next[1]).toBe(lines[1]!);
  });

  test("an emptied row deletes its words only; a row that was the whole utterance deletes it", () => {
    const { lines: next } = replaceCaptionRowText(lines, middle, "   ");
    expect(next[0]!.text).toBe("We threw a the whole team.");
    expect(times(next[0]!)).toEqual([...times(lines[0]!).slice(0, 3), ...times(lines[0]!).slice(6)]);
    const whole = deleteCaptionRow(lines, { utterance: 1, words: [0, 1] });
    expect(whole).toHaveLength(1);
    expect(whole[0]!.text).toBe(lines[0]!.text);
  });

  test("add after a row that is not its utterance's last splits the utterance there, keeping every word's time", () => {
    const next = addCaptionRowAfter(lines, middle);
    expect(next.map((line) => line.text)).toEqual(["We threw a huge party for", "Subtitle here", "the whole team.", "Everyone came."]);
    expect(next.map((line) => line.index)).toEqual([0, 1, 2, 3]);
    expect(next.flatMap((line) => line.words).filter((word) => word.confidence !== null)).toEqual(lines.flatMap((line) => line.words));
    // There is no gap after "for": the placeholder takes the end of that word.
    expect(next[1]!.startSec).toBeCloseTo(2.525, 9);
    expect(next[1]!.endSec).toBe(2.6);
    expect([next[0]!.endSec, next[2]!.startSec]).toEqual([2.6, 2.65]);
    // After the utterance's last row it fills the gap before the next utterance, up to a second.
    const last = addCaptionRowAfter(lines, { utterance: 0, words: [6, 7, 8] });
    expect(last.map((line) => line.text)).toEqual(["We threw a huge party for the whole team.", "Subtitle here", "Everyone came."]);
    expect([last[1]!.startSec, last[1]!.endSec]).toEqual([3.6, 4.0]);
  });

  test("the placeholder after a split shows as its own caption between the two halves", () => {
    const next = addCaptionRowAfter(lines, middle);
    const document = editorDocumentSchema.parse({
      version: 1, clipStartSec: 0, clipEndSec: 6, captionPreset: captionPresetSchema.parse({ wordsPerCue: 3, textTransform: "none" }),
      transcriptSlice: next, studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }), brollUrl: null, deletedRanges: [],
    });
    expect(deriveCaptionLines(document).map((line) => line.text)).toEqual(["We threw", "a huge party for", "Subtitle here", "the whole team.", "Everyone came."]);
  });

  test("Urdu: same count rewrites in place, a different count re-times only the row", () => {
    const ur = [utterance(0, [["یہ", 0.5, 0.7], ["بہت", 0.75, 1.0], ["اچھا", 1.05, 1.4], ["ہے", 1.45, 1.6], ["دوست", 1.7, 2.1]])];
    const same = replaceCaptionRowText(ur, { utterance: 0, words: [0, 1, 2] }, "یہ کافی اچھا").lines;
    expect(same[0]!.text).toBe("یہ کافی اچھا ہے دوست");
    expect(times(same[0]!).map(([, start]) => start)).toEqual([0.5, 0.75, 1.05, 1.45, 1.7]);
    const longer = replaceCaptionRowText(ur, { utterance: 0, words: [3, 4] }, "ہے میرے دوست").lines;
    expect(longer[0]!.text).toBe("یہ بہت اچھا ہے میرے دوست");
    expect(times(longer[0]!).slice(0, 3)).toEqual(times(ur[0]!).slice(0, 3));
    expect(longer[0]!.words.at(-1)!.endSec).toBe(2.1);
  });

  test("Chinese sent one character per word: same count keeps each character's time; more stays per character", () => {
    const zh = [utterance(0, [["我", 0, 0.2], ["们", 0.2, 0.4], ["今", 0.4, 0.6], ["天", 0.6, 0.8], ["去", 0.8, 1.0]])];
    for (const word of zh[0]!.words) word.spaceBefore = false;
    zh[0]!.text = joinTranscriptWords(zh[0]!.words);
    const same = replaceCaptionRowText(zh, { utterance: 0, words: [2, 3, 4] }, "明天去").lines;
    expect(same[0]!.text).toBe("我们明天去");
    expect(times(same[0]!).map(([, start]) => start)).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
    const more = replaceCaptionRowText(zh, { utterance: 0, words: [2, 3, 4] }, "明天去公园").lines;
    expect(more[0]!.text).toBe("我们明天去公园");
    expect(more[0]!.words).toHaveLength(7);
    expect(more[0]!.text).not.toContain(" ");
  });

  test("new words never land in a cut word inside the row", () => {
    // "um" (index 1) is cut, so the row shows words 0 and 2.
    const withCut = [utterance(0, [["So", 0, 0.3], ["um", 0.4, 0.9], ["anyway", 1.0, 1.4]])];
    const { lines: next } = replaceCaptionRowText(withCut, { utterance: 0, words: [0, 2] }, "So yes anyway");
    expect(next[0]!.words.map((word) => word.word)).toEqual(["So", "yes", "um", "anyway"]);
    for (const word of next[0]!.words.filter((entry) => entry.word !== "um")) {
      expect(word.endSec <= 0.4 || word.startSec >= 0.9).toBe(true);
    }
  });

  test("an address taken before a neighbour's edit still finds the row's words", () => {
    const address = captionRowAddress(lines, { utterance: 0, words: [6, 7, 8] });
    const { lines: edited } = replaceCaptionRowText(lines, middle, "big party just for");
    expect(resolveCaptionRow(edited, address)).toEqual({ utterance: 0, words: [7, 8, 9] });
    const split = addCaptionRowAfter(edited, { utterance: 0, words: [0, 1, 2] });
    expect(resolveCaptionRow(split, address)).toEqual({ utterance: 2, words: [4, 5, 6] });
    expect(resolveCaptionRow(deleteCaptionRow(lines, { utterance: 0, words: [6, 7, 8] }), address)).toBeNull();
  });
});

describe("what a row edit keeps", () => {
  test("an emoji and an emphasis override on a neighbouring caption survive", () => {
    const entries = { [key(1.25)]: { id: "throw", word: "threw" }, [key(2.8)]: { id: "team", word: "whole" } };
    const emphasis = { [key(1.25)]: "hero" as const, [key(3.15)]: "plain" as const };
    const edits = studioEditsSchema.parse({ framing: { mode: "center" }, captionEmojis: entries, captionEmphasis: emphasis });
    for (const text of ["massive feast for", "massive surprise party just for", ""]) {
      const edit = replaceCaptionRowText(lines, middle, text);
      const carried = moveWordKeyedEdits(edits, edit.movedKeys);
      expect(emojiWords(edit.lines, carried.captionEmojis!)).toEqual({ throw: "threw", team: "whole" });
      const keys = new Set(edit.lines.flatMap((line) => line.words.map((word) => key(word.startSec))));
      expect(Object.keys(carried.captionEmphasis!).every((override) => keys.has(override))).toBe(true);
      expect(carried.captionEmphasis).toEqual(emphasis);
    }
  });

  test("an emoji on an edited word stays when its text is unchanged and is dropped when the word was rewritten", () => {
    const entries = { [key(2.0)]: { id: "party", word: "party" }, [key(1.65)]: { id: "big", word: "huge" } };
    const edits = studioEditsSchema.parse({ framing: { mode: "center" }, captionEmojis: entries, captionEmphasis: { [key(2.0)]: "hero" } });
    // Same count: "huge" rewritten, "party" unchanged.
    const same = replaceCaptionRowText(lines, middle, "giant party for");
    expect(emojiWords(same.lines, moveWordKeyedEdits(edits, same.movedKeys).captionEmojis!)).toEqual({ party: "party" });
    // Different count: "party" is re-timed, and its emoji and emphasis follow it.
    const longer = replaceCaptionRowText(lines, middle, "a giant party for");
    const carried = moveWordKeyedEdits(edits, longer.movedKeys);
    expect(emojiWords(longer.lines, carried.captionEmojis!)).toEqual({ party: "party" });
    const party = longer.lines[0]!.words.find((word) => word.word === "party")!;
    expect(carried.captionEmphasis).toEqual({ [key(party.startSec)]: "hero" });
  });

  test("censor marks on untouched words survive a different count, a delete and a split", () => {
    const marks = [censorOn(lines, 0, 7), censorOn(lines, 1, 1)];
    const edits = [
      replaceCaptionRowText(lines, middle, "massive surprise party for").lines,
      replaceCaptionRowText(lines, middle, "").lines,
      deleteCaptionRow(lines, { utterance: 0, words: [0, 1, 2] }),
      addCaptionRowAfter(lines, { utterance: 0, words: [0, 1, 2] }),
    ];
    for (const after of edits) {
      // Without carrying, the moved word's id no longer names a word.
      expect(isCensorSegmentStale(marks[0]!, after)).toBe(true);
      const carried = carryCensorWordIds(lines, after, marks);
      expect(carried.map((mark) => isCensorSegmentStale(mark, after))).toEqual([false, false]);
    }
    // A same-count rewrite renames nothing; the rewritten word's own mark goes stale.
    const rewritten = replaceCaptionRowText(lines, { utterance: 0, words: [6, 7, 8] }, "the entire team.").lines;
    const kept = carryCensorWordIds(lines, rewritten, marks);
    expect(kept).toBe(marks);
    expect(isCensorSegmentStale(kept[0]!, rewritten)).toBe(true);
    expect(isCensorSegmentStale(kept[1]!, rewritten)).toBe(false);
  });
});

describe("one commit is one undo step", () => {
  test("the slice, censor marks and moved emojis dispatched under one coalesce key undo together", () => {
    const base = editorDocumentSchema.parse({
      version: 1, clipStartSec: 0, clipEndSec: 6, captionPreset: captionPresetSchema.parse({ wordsPerCue: 3 }),
      transcriptSlice: lines, censorSegments: [censorOn(lines, 0, 7)],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "center" }, captionEmojis: { [key(2.0)]: { id: "party", word: "party" } } }),
      brollUrl: null, deletedRanges: [],
    });
    const edit = replaceCaptionRowText(base.transcriptSlice, middle, "a really huge party for");
    const actions = transcriptEditActions(base, edit.lines, edit.movedKeys);
    expect(actions.map((action) => action.type)).toEqual(["setTranscriptSlice", "setCensorSegments", "setStudioEdits"]);
    let history = createEditorHistory(base);
    for (const action of actions) history = applyWithHistory(history, action, { coalesceKey: "caption-row:1" });
    expect(history.past).toHaveLength(1);
    expect(isCensorSegmentStale(history.present.censorSegments[0]!, history.present.transcriptSlice)).toBe(false);
    expect(undoEditor(history).present).toBe(base);
    expect(transcriptEditActions(base, base.transcriptSlice, new Map())).toEqual([]);
  });
});
