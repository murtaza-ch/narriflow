import {
  detectFillerWordRanges,
  detectSilenceRanges,
  FLOAT_SLACK,
  listFillerClassifier,
  normalizeDeletedRanges,
  removableFillerWords,
  SILENCE_DEFAULT_MIN_SILENCE_SEC,
  SILENCE_DEFAULT_PAD_SEC,
  type ClipWindow,
  type SourceRange,
  type TranscriptUtterance,
} from "@narriflow/validators";

// The Studio's clean-up cuts (silences, filler words) as one place both surfaces call: the
// timeline's Remove silence popover and the AI tools panel. What either shows before Apply is
// exactly what `applyDetectedCuts` receives.

export interface CleanupCutsInput {
  readonly utterances: TranscriptUtterance[];
  readonly clipWindow: ClipWindow;
  readonly deletedRanges: SourceRange[];
  /** Measured quiet audio, or null when it was not measured (transcript gaps only). */
  readonly quietRanges: SourceRange[] | null;
}

export interface SilenceSettings {
  readonly minSilenceSec: number;
  readonly padSec: number;
}

/** What Remove silence uses until someone moves the popover's sliders. */
export const REMOVE_SILENCE_DEFAULTS: SilenceSettings = {
  minSilenceSec: SILENCE_DEFAULT_MIN_SILENCE_SEC,
  padSec: SILENCE_DEFAULT_PAD_SEC,
};

export function studioSilenceRanges(input: CleanupCutsInput, settings: SilenceSettings = REMOVE_SILENCE_DEFAULTS): SourceRange[] {
  return detectSilenceRanges(input.utterances, input.clipWindow, {
    minSilenceSec: settings.minSilenceSec,
    padSec: settings.padSec,
    existingDeleted: input.deletedRanges,
    // Measured quiet audio keeps music and laughter between words.
    ...(input.quietRanges ? { quietRanges: input.quietRanges } : {}),
  });
}

/** One cut proposal: the ranges Apply hands over, how many things it removes and how much shorter the clip gets. */
export interface CleanupCuts {
  readonly ranges: SourceRange[];
  readonly count: number;
  readonly removedSec: number;
}

const total = (ranges: readonly SourceRange[]) => ranges.reduce((sum, range) => sum + (range.endSec - range.startSec), 0);

/** Seconds `ranges` add to the cuts already in `deletedRanges` (overlap counts once). */
export function addedCutSec(deletedRanges: SourceRange[], ranges: SourceRange[], window: ClipWindow): number {
  if (ranges.length === 0) return 0;
  return Math.max(0, total(normalizeDeletedRanges([...deletedRanges, ...ranges], window)) - total(normalizeDeletedRanges(deletedRanges, window)));
}

export function silenceCuts(input: CleanupCutsInput, settings: SilenceSettings = REMOVE_SILENCE_DEFAULTS): CleanupCuts {
  const ranges = studioSilenceRanges(input, settings);
  return { ranges, count: ranges.length, removedSec: addedCutSec(input.deletedRanges, ranges, input.clipWindow) };
}

const insideCut = (deleted: readonly SourceRange[], startSec: number, endSec: number) =>
  deleted.some((range) => range.startSec <= startSec + FLOAT_SLACK && range.endSec >= endSec - FLOAT_SLACK);

/**
 * Filler words the built-in list of `languageCode` recognises, still in the clip. Null when the
 * language has no list (other languages need AI tags the Studio does not have).
 */
export function fillerCuts(input: CleanupCutsInput, languageCode: string | null): CleanupCuts | null {
  const isFiller = listFillerClassifier(languageCode);
  if (!isFiller) return null;
  const words = [...removableFillerWords(input.utterances, input.clipWindow, isFiller)].filter((word) => !insideCut(input.deletedRanges, word.startSec, word.endSec));
  if (words.length === 0) return { ranges: [], count: 0, removedSec: 0 };
  const ranges = detectFillerWordRanges(input.utterances, input.clipWindow, { isFiller }).filter((range) => !insideCut(input.deletedRanges, range.startSec, range.endSec));
  const removedSec = addedCutSec(input.deletedRanges, ranges, input.clipWindow);
  return removedSec > 0 ? { ranges, count: words.length, removedSec } : { ranges: [], count: 0, removedSec: 0 };
}
