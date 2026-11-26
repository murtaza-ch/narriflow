import { describe, expect, test } from "bun:test";
import { autoCensorWordId, censorSegmentSchema, DEFAULT_CAPTION_PRESET, EDITOR_DOCUMENT_VERSION, editorDocumentSchema, USER_ERROR_MESSAGES, userErrorMessage, type EditorDocument, type TranscriptUtterance } from "@narriflow/validators";
import { clipEmojiSuggestionFailure, clipEmojiTranscriptFailure, clipEmojiWords, suggestClipEmojis, type ClipEmojiTagger } from "./clip-emoji-suggestion";
import type { CaptionEmojiTaggingInput, CaptionEmojiTaggingOutcome } from "./clip-emoji-tagging";

const word = (startSec: number, endSec: number, text: string) => ({ word: text, startSec, endSec, confidence: null });
// An Urdu line: "bahut (10) mazedaar (11) biryani (12.5) khayi (14)".
const slice: TranscriptUtterance[] = [{ index: 3, speaker: 0, speakerLabel: "S1", startSec: 10, endSec: 15, text: "بہت مزیدار بریانی کھائی", confidence: null,
  words: [word(10, 10.8, "بہت"), word(11, 12.3, "مزیدار"), word(12.5, 13.8, "بریانی"), word(14, 15, "کھائی")] }];

function document(over: Partial<Pick<EditorDocument, "deletedRanges" | "censorSegments">> = {}): EditorDocument {
  return editorDocumentSchema.parse({ version: EDITOR_DOCUMENT_VERSION, clipStartSec: 10, clipEndSec: 15, captionPreset: DEFAULT_CAPTION_PRESET, transcriptSlice: slice,
    studioEdits: {}, brollUrl: null, deletedRanges: over.deletedRanges ?? [], sceneBlocks: [], censorSegments: over.censorSegments ?? [], mediaMotions: [] });
}
const mask = (wordIndex: number, enabled = true) => censorSegmentSchema.parse({ schemaVersion: 1, id: "00000000-0000-4000-8000-00000000000" + wordIndex,
  sourceWordIds: [autoCensorWordId({ utteranceIndex: 3, wordIndex, word: slice[0]!.words[wordIndex]! })], sourceStartSec: slice[0]!.words[wordIndex]!.startSec,
  sourceEndSec: slice[0]!.words[wordIndex]!.endSec, treatment: "caption_mask", paddingSec: 0, captionMaskPolicy: { replacement: "asterisks", preservePunctuation: true },
  policyVersion: "v1", enabled });

const outcome = (picks: CaptionEmojiTaggingOutcome["picks"], over: Partial<CaptionEmojiTaggingOutcome> = {}): CaptionEmojiTaggingOutcome =>
  ({ chunks: 1, tagged: 1, failed: 0, retried: 0, rateLimited: 0, skipped: 0, unsafe: 0, tokensUsed: 10, picks, ...over });
function recording(reply: CaptionEmojiTaggingOutcome) {
  const calls: CaptionEmojiTaggingInput[] = [];
  const tag: ClipEmojiTagger = async (input) => { calls.push(input); return reply; };
  return { tag, calls };
}

describe("clipEmojiWords", () => {
  test("offers kept, unmasked words with their edited start", () => {
    const { utterances, words } = clipEmojiWords(document({ deletedRanges: [{ startSec: 10.9, endSec: 12.4 }], censorSegments: [mask(3), mask(0, false)] }));
    expect(utterances.map((u) => u.words.map((w) => w.word))).toEqual([["بہت", "بریانی"]]);
    expect(words).toEqual([{ key: "10000", editedStartSec: 0 }, { key: "12500", editedStartSec: 1 }]);
  });

  test("without censor segments only the deleted ranges remove words (generation, before any mask exists)", () => {
    const { censorSegments: _masks, ...clip } = document({ deletedRanges: [{ startSec: 10.9, endSec: 12.4 }], censorSegments: [mask(3)] });
    expect(clipEmojiWords(clip).words).toEqual([{ key: "10000", editedStartSec: 0 }, { key: "12500", editedStartSec: 1 }, { key: "14000", editedStartSec: 2.5 }]);
  });
});

describe("suggestClipEmojis", () => {
  const base = { languageCode: "ur", title: "شادی", density: "balanced" as const, deadline: 30_000 };

  test("tags the kept words and applies the density, keyed by Word Key", async () => {
    const { tag, calls } = recording(outcome([{ key: "10000", ref: { id: "fire" }, strength: 1 }, { key: "11000", ref: { id: "yum" }, strength: 3 },
      { key: "12500", ref: { id: "curry-rice" }, strength: 3 }, { key: "99000", ref: { id: "flame" }, strength: 3 }]));
    const result = await suggestClipEmojis({ ...base, document: document() }, tag);
    // The strongest hook pick (1 s) goes first; 0 s and 2.5 s are under 2.5 s from it.
    expect(result.emojis).toEqual({ "11000": { id: "yum" } });
    expect(calls[0]).toMatchObject({ languageCode: "ur", title: "شادی", deadline: 30_000 });
    const expressive = await suggestClipEmojis({ ...base, density: "expressive", document: document() }, recording(outcome([{ key: "10000", ref: { id: "fire" }, strength: 1 },
      { key: "11000", ref: { id: "yum" }, strength: 3 }, { key: "12500", ref: { id: "curry-rice" }, strength: 3 }])).tag);
    // Expressive allows 1.5 s: 2.5 s is exactly 1.5 s after the hook.
    expect(Object.keys(expressive.emojis)).toEqual(["11000", "12500"]);
  });

  test("a clip with no words left returns an empty map without calling the model", async () => {
    const { tag, calls } = recording(outcome([]));
    const result = await suggestClipEmojis({ ...base, document: document({ censorSegments: [mask(0), mask(1), mask(2), mask(3)] }) }, tag);
    expect(result).toEqual({ emojis: {}, outcome: null, complete: true });
    expect(calls).toHaveLength(0);
    expect(clipEmojiSuggestionFailure(result.outcome)).toBeNull();
  });
});

test("only a run that tagged nothing because requests failed is a failure", () => {
  expect(clipEmojiSuggestionFailure(outcome([]))).toBeNull();
  expect(clipEmojiSuggestionFailure(outcome([], { tagged: 0, unsafe: 1 }))).toBeNull();
  expect(clipEmojiSuggestionFailure(outcome([], { chunks: 2, tagged: 1, failed: 1 }))).toBeNull();
  expect(clipEmojiSuggestionFailure(outcome([], { tagged: 0, failed: 1, rateLimited: 1 }))).toBe("openai_rate_limited");
  expect(clipEmojiSuggestionFailure(outcome([], { tagged: 0, failed: 1 }))).toBe("clip_emoji_suggestion_failed");
  expect(clipEmojiSuggestionFailure(outcome([], { tagged: 0, skipped: 1 }))).toBe("clip_emoji_suggestion_failed");
});

test("a missing or unfinished transcript is not ready, never an empty suggestion", () => {
  expect(clipEmojiTranscriptFailure(null)).toBe("transcript_not_ready");
  expect(clipEmojiTranscriptFailure({ status: "processing" })).toBe("transcript_not_ready");
  expect(clipEmojiTranscriptFailure({ status: "failed" })).toBe("transcript_not_ready");
  expect(clipEmojiTranscriptFailure({ status: "completed" })).toBeNull();
  expect(userErrorMessage("transcript_not_ready")).toBe(USER_ERROR_MESSAGES.transcript_not_ready!);
});
