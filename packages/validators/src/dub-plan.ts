import {
  buildClipCutPlan,
  EDIT_RANGE_EPSILON_SEC,
  FLOAT_SLACK,
  sourcePointToEdited,
  sourceRangeToEdited,
  sourceWordToEdited,
} from "./edit-ranges";
import type { EditorDocument } from "./editor-document";
import { joinTranscriptWords } from "./text-script";
import { splitUtterancesIntoSentences } from "./utterance-split";

// A segment shorter than this is voiced together with a neighbour that is
// close enough, so a one-word sentence is not a separate TTS call.
export const DUB_MIN_SEGMENT_SEC = 1.0;
// Largest gap between two segments that still merges them.
export const DUB_MERGE_GAP_SEC = 0.35;
// One TTS call per segment; more than this is not worth dubbing.
export const DUB_MAX_SEGMENTS = 160;

// Rounding each edited end to a millisecond can differ from the source length
// by up to one millisecond even when nothing was cut.
const UNTIMED_KEPT_TOLERANCE_SEC = EDIT_RANGE_EPSILON_SEC * 2;
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;

export interface DubSegmentPlan {
  /** Edited-timeline seconds, before inserted scene blocks. */
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
}

export type DubPlanRefusalCode =
  | "dub_transcript_empty"
  | "dub_transcript_untimed_cut"
  | "dub_transcript_too_long";

export type DubPlanResult =
  | {
      readonly kind: "planned";
      readonly editedDurationSec: number;
      readonly segments: readonly DubSegmentPlan[];
    }
  | { readonly kind: "refused"; readonly code: DubPlanRefusalCode };

type DubPlanDocument = Pick<
  EditorDocument,
  "clipStartSec" | "clipEndSec" | "deletedRanges" | "transcriptSlice"
>;

interface RawSegment {
  startSec: number;
  endSec: number;
  text: string;
  index: number;
}

function hasLetterOrDigit(text: string) {
  return LETTER_OR_DIGIT_RE.test(text);
}

function joinSegments(first: RawSegment, second: RawSegment): RawSegment {
  return {
    startSec: Math.min(first.startSec, second.startSec),
    endSec: Math.max(first.endSec, second.endSec),
    text: joinTranscriptWords([{ word: first.text }, { word: second.text }]),
    index: Math.min(first.index, second.index),
  };
}

/**
 * The sentences a dub voices, placed on the clip's edited timeline (source time
 * after `deletedRanges`, before inserted scene blocks). A word is dubbed
 * exactly when the clip's captions show it: `sourceWordToEdited` is non-null.
 */
export function planDubSegments(document: DubPlanDocument): DubPlanResult {
  const window = { startSec: document.clipStartSec, endSec: document.clipEndSec };
  const { map, editedDurationSec } = buildClipCutPlan(document.deletedRanges, window);
  const raw: RawSegment[] = [];

  for (const sentence of splitUtterancesIntoSentences(document.transcriptSlice)) {
    if (sentence.words.length > 0) {
      const kept = sentence.words.flatMap((word) => {
        const range = sourceWordToEdited(map, word);
        return range ? [{ word, range }] : [];
      });
      // Punctuation that would open a segment belongs to nothing spoken.
      while (kept.length > 0 && !hasLetterOrDigit(kept[0]!.word.word)) kept.shift();
      if (kept.length === 0) continue;
      raw.push({
        startSec: kept[0]!.range.startSec,
        endSec: kept[kept.length - 1]!.range.endSec,
        text: joinTranscriptWords(
          kept.map(({ word }) => ({
            word: word.word,
            ...(word.spaceBefore === undefined ? {} : { spaceBefore: word.spaceBefore }),
          })),
        ),
        index: raw.length,
      });
      continue;
    }

    // Untimed utterance: all or nothing, because there is no word to cut at.
    const startSec = Math.max(sentence.startSec, window.startSec);
    const endSec = Math.min(sentence.endSec, window.endSec);
    const text = sentence.text.trim();
    if (endSec <= startSec) {
      const point = sourcePointToEdited(map, startSec);
      if (point !== null && text) {
        raw.push({ startSec: point, endSec: point, text, index: raw.length });
      }
      continue;
    }
    const range = sourceRangeToEdited(map, { startSec, endSec });
    if (!range) continue;
    if (
      endSec - startSec - (range.endSec - range.startSec) >
      UNTIMED_KEPT_TOLERANCE_SEC + FLOAT_SLACK
    ) {
      return { kind: "refused", code: "dub_transcript_untimed_cut" };
    }
    if (text) raw.push({ ...range, text, index: raw.length });
  }

  const sorted = raw.sort((a, b) => a.startSec - b.startSec || a.index - b.index);

  // Overlapping speakers: one segment spanning both.
  const spans: RawSegment[] = [];
  for (const segment of sorted) {
    const last = spans[spans.length - 1];
    if (last && segment.startSec < last.endSec) {
      spans[spans.length - 1] = joinSegments(last, segment);
    } else {
      spans.push(segment);
    }
  }

  const merged: RawSegment[] = [];
  for (let i = 0; i < spans.length; i += 1) {
    const current = spans[i]!;
    if (current.endSec - current.startSec < DUB_MIN_SEGMENT_SEC) {
      const next = spans[i + 1];
      if (next && next.startSec - current.endSec < DUB_MERGE_GAP_SEC) {
        spans[i + 1] = joinSegments(current, next);
        continue;
      }
      const previous = merged[merged.length - 1];
      if (previous && current.startSec - previous.endSec < DUB_MERGE_GAP_SEC) {
        merged[merged.length - 1] = joinSegments(previous, current);
        continue;
      }
    }
    merged.push(current);
  }

  const segments = merged
    .filter((segment) => hasLetterOrDigit(segment.text))
    .map(({ startSec, endSec, text }) => ({ startSec, endSec, text }));
  if (segments.length === 0) return { kind: "refused", code: "dub_transcript_empty" };
  if (segments.length > DUB_MAX_SEGMENTS) {
    return { kind: "refused", code: "dub_transcript_too_long" };
  }
  return { kind: "planned", editedDurationSec, segments };
}
