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

const WINDOW_SIZE = 3;

/**
 * Given the current playback time and transcript utterances,
 * determines which utterance and word is currently active,
 * returning a sliding window of visible words with the active one flagged.
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

      // Compute sliding window centered on active word
      const halfWindow = Math.floor(WINDOW_SIZE / 2);
      let windowStart = Math.max(0, activeWordIdx - halfWindow);
      const windowEnd = Math.min(words.length, windowStart + WINDOW_SIZE);

      // Adjust start if at end boundary
      if (windowEnd - windowStart < WINDOW_SIZE && windowEnd === words.length) {
        windowStart = Math.max(0, windowEnd - WINDOW_SIZE);
      }

      const visibleWords: CaptionWord[] = words
        .slice(windowStart, windowEnd)
        .map((w, i) => ({
          word: w.word,
          isActive: windowStart + i === activeWordIdx,
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

    const halfWindow = Math.floor(WINDOW_SIZE / 2);
    let windowStart = Math.max(0, estimatedActiveIdx - halfWindow);
    const windowEnd = Math.min(textWords.length, windowStart + WINDOW_SIZE);

    if (windowEnd - windowStart < WINDOW_SIZE && windowEnd === textWords.length) {
      windowStart = Math.max(0, windowEnd - WINDOW_SIZE);
    }

    const visibleWords: CaptionWord[] = textWords
      .slice(windowStart, windowEnd)
      .map((w, i) => ({
        word: w,
        isActive: windowStart + i === estimatedActiveIdx,
      }));

    return { visibleWords, utteranceIndex: utteranceIdx, activeWordIndex: estimatedActiveIdx };
  }, [currentTime, utterances, clipStartSec]);
}
