"use client";

import { useMemo } from "react";
import { CAPTION_CHUNK_SIZE, editedToSource, sourceRangeToEdited } from "@narriflow/validators";
import type { EditedTimeMap, TranscriptUtterance } from "@narriflow/validators";

export interface CaptionWord {
  word: string;
  isActive: boolean;
}

export interface CaptionState {
  visibleWords: CaptionWord[];
  utteranceIndex: number;
  activeWordIndex: number;
}

const CHUNK_SIZE = CAPTION_CHUNK_SIZE;
const END_CLAMP_EPSILON_SEC = 0.001;

/**
 * Pure caption resolver so timing edge cases can be tested without React.
 *
 * `currentTime` is EDITED-timeline seconds (the playback clock's own unit
 * post Vizard-parity Phase B step 8). When `editedTimeMap` is supplied,
 * `currentTime` is converted through it to absolute SOURCE seconds — the
 * space `utterances`' own `startSec`/`endSec` live in — before matching
 * cues, so a cut can never desync captions from what's actually on screen
 * (words inside a deleted range simply never become active, since edited
 * time skips over them by construction). Omitting `editedTimeMap` falls
 * back to the pre-ripple `currentTime + clipStartSec` identity, which is
 * mathematically the same thing for a clip with no deletions — kept as an
 * explicit fallback (rather than always requiring a map) so callers that
 * genuinely have no notion of one (e.g. isolated previews) still work.
 *
 * A deleted word never becoming ACTIVE isn't the whole story, though: the
 * worker's `generateSrtFromSlice`/`generateAssFromSlice` (render-clips.ts)
 * DROP fully-deleted words before grouping the survivors into fixed-size
 * chunks, so the export's chunk boundaries are computed over the FILTERED
 * word list. This resolver used to chunk the RAW `utterance.words` — same
 * active word, but a neighboring chunk could still contain a deleted word
 * (or, once the deletion sits earlier in the utterance, every later chunk
 * boundary drifts out of alignment with the export entirely). `words`
 * below applies the exact same predicate the worker uses
 * (`sourceRangeToEdited(...) !== null`) before any chunk math runs, so the
 * preview's visible chunk text always matches what actually gets burned in.
 */
export function getCurrentCaptionState(
  currentTime: number,
  utterances: TranscriptUtterance[],
  clipStartSec: number,
  editedTimeMap?: EditedTimeMap,
): CaptionState | null {
  if (utterances.length === 0) return null;

  const absoluteTime = editedTimeMap
    ? editedToSource(editedTimeMap, currentTime)
    : currentTime + clipStartSec;

  let utteranceIdx = utterances.findIndex(
    (u) => absoluteTime >= u.startSec && absoluteTime < u.endSec,
  );

  if (utteranceIdx === -1) {
    const lastUtterance = utterances[utterances.length - 1]!;
    if (absoluteTime >= lastUtterance.endSec - END_CLAMP_EPSILON_SEC) {
      utteranceIdx = utterances.length - 1;
    } else {
      return null;
    }
  }

  const utterance = utterances[utteranceIdx]!;
  // Same predicate as the worker's `isVisible` (render-clips.ts's
  // generateSrtFromSlice/generateAssFromSlice) — drop words that fall
  // entirely inside a cut BEFORE computing activeWordIdx/chunk boundaries,
  // so the preview can never show a deleted word or a chunk split that
  // disagrees with the export.
  const words = editedTimeMap
    ? utterance.words.filter((w) => sourceRangeToEdited(editedTimeMap, w) !== null)
    : utterance.words;

  if (words.length > 0) {
    let activeWordIdx = words.findIndex(
      (w) => absoluteTime >= w.startSec && absoluteTime < w.endSec,
    );

    if (activeWordIdx === -1) {
      const upcoming = words.findIndex((w) => w.startSec > absoluteTime);
      if (upcoming === -1) {
        activeWordIdx = words.length - 1;
      } else if (upcoming > 0) {
        activeWordIdx = upcoming - 1;
      } else {
        activeWordIdx = 0;
      }
    }

    const chunkStart = Math.floor(activeWordIdx / CHUNK_SIZE) * CHUNK_SIZE;
    const chunkEnd = Math.min(words.length, chunkStart + CHUNK_SIZE);

    const visibleWords: CaptionWord[] = words
      .slice(chunkStart, chunkEnd)
      .map((w, i) => ({
        word: w.word,
        isActive: chunkStart + i === activeWordIdx,
      }));

    return { visibleWords, utteranceIndex: utteranceIdx, activeWordIndex: activeWordIdx };
  }

  const textWords = utterance.text.split(/\s+/).filter(Boolean);
  if (textWords.length === 0) return null;

  const utteranceDuration = Math.max(
    END_CLAMP_EPSILON_SEC,
    utterance.endSec - utterance.startSec,
  );
  const progress = Math.max(0, (absoluteTime - utterance.startSec) / utteranceDuration);
  const estimatedActiveIdx = Math.min(
    textWords.length - 1,
    Math.floor(progress * textWords.length),
  );

  const chunkStart = Math.floor(estimatedActiveIdx / CHUNK_SIZE) * CHUNK_SIZE;
  const chunkEnd = Math.min(textWords.length, chunkStart + CHUNK_SIZE);

  const visibleWords: CaptionWord[] = textWords
    .slice(chunkStart, chunkEnd)
    .map((w, i) => ({
      word: w,
      isActive: chunkStart + i === estimatedActiveIdx,
    }));

  return { visibleWords, utteranceIndex: utteranceIdx, activeWordIndex: estimatedActiveIdx };
}

export function useCurrentCaption(
  currentTime: number,
  utterances: TranscriptUtterance[],
  clipStartSec: number,
  editedTimeMap?: EditedTimeMap,
): CaptionState | null {
  return useMemo(
    () => getCurrentCaptionState(currentTime, utterances, clipStartSec, editedTimeMap),
    [currentTime, utterances, clipStartSec, editedTimeMap],
  );
}
