"use client";

import { useMemo } from "react";
import type { TranscriptUtterance } from "@narriflow/validators";

export interface CaptionWord {
  word: string;
  isActive: boolean;
}

export interface CaptionState {
  visibleWords: CaptionWord[];
  utteranceIndex: number;
  activeWordIndex: number;
}

const CHUNK_SIZE = 3;

/**
 * Given the current playback time and transcript utterances,
 * determines which utterance and word is currently active,
 * returning the fixed-size chunk that contains the active word with that
 * word flagged. Chunks are aligned to word index multiples of CHUNK_SIZE,
 * so the visible group only changes when the active word crosses a chunk
 * boundary — no sliding-window shift.
 *
 * @param currentTime - Clip-relative time (0 to duration)
 * @param utterances - TranscriptUtterance[] with words[]
 * @param clipStartSec - Absolute start time of the clip in the source
 */
export function useCurrentCaption(
  currentTime: number,
  utterances: TranscriptUtterance[],
  clipStartSec: number,
): CaptionState | null {
  return useMemo(() => {
    if (utterances.length === 0) return null;

    const absoluteTime = currentTime + clipStartSec;

    // Find active utterance
    const utteranceIdx = utterances.findIndex(
      (u) => absoluteTime >= u.startSec && absoluteTime < u.endSec,
    );

    if (utteranceIdx === -1) return null;

    const utterance = utterances[utteranceIdx]!;
    const words = utterance.words;

    // Word-level timing available
    if (words.length > 0) {
      // Find active word by timestamp
      let activeWordIdx = words.findIndex(
        (w) => absoluteTime >= w.startSec && absoluteTime < w.endSec,
      );

      // If between words, find the closest
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

    // Fallback: no word-level timing — split text and estimate
    const textWords = utterance.text.split(/\s+/).filter(Boolean);
    if (textWords.length === 0) return null;

    const utteranceDuration = utterance.endSec - utterance.startSec;
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
  }, [currentTime, utterances, clipStartSec]);
}
