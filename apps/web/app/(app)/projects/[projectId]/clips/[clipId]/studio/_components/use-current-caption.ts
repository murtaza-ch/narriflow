"use client";

import { useMemo } from "react";
import { CAPTION_CHUNK_SIZE } from "@narriflow/validators";
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

const CHUNK_SIZE = CAPTION_CHUNK_SIZE;
const END_CLAMP_EPSILON_SEC = 0.001;

/**
 * Pure caption resolver so timing edge cases can be tested without React.
 */
export function getCurrentCaptionState(
  currentTime: number,
  utterances: TranscriptUtterance[],
  clipStartSec: number,
): CaptionState | null {
  if (utterances.length === 0) return null;

  const absoluteTime = currentTime + clipStartSec;

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
  const words = utterance.words;

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
): CaptionState | null {
  return useMemo(
    () => getCurrentCaptionState(currentTime, utterances, clipStartSec),
    [currentTime, utterances, clipStartSec],
  );
}
