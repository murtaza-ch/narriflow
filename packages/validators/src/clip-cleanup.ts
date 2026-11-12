import { z } from "zod";
import { buildClipCutPlan, deletedRangesSchema, normalizeDeletedRanges, type ClipWindow, type SourceRange } from "./edit-ranges";
import { detectFillerWordRanges, isFillerWord } from "./filler-words";
import { buildCoverageSpans, detectSilenceRanges, joinSpeechlessSlivers } from "./silence-detection";
import type { TranscriptUtterance } from "./transcript";

// Automatic clip cleanup chosen at generation: silence and filler-word
// removal, seeded into each new clip's `deletedRanges` so the Studio shows
// them as ordinary, undoable cuts.

/** How the media executor measures quiet audio on the transcription audio:
 *  FFmpeg `silencedetect=noise=<noiseDb>dB:d=<minDurationSec>`. Measured on
 *  real interviews (2026-11-12): −40 dB removed every cut over music while
 *  keeping 87% of the transcript's pause cuts; 0.3 s matches the shortest
 *  silence cut worth keeping. */
export const QUIET_AUDIO_DETECTION = { noiseDb: -40, minDurationSec: 0.3 } as const;

/** 180 minutes of speech measures about 3,200 quiet intervals. A source over
 *  this cap stores none, which turns silence removal off for it. */
export const QUIET_RANGES_MAX_INTERVALS = 8_000;

const CENTISECONDS = 100;

/** Quiet intervals of a Source Audio as whole-centisecond run lengths:
 *  `[gap, length, gap, length, ...]`, each gap measured from the previous
 *  interval's end (the first from 0). Compact enough for a three-hour source
 *  inside the media executor's 60 KB facts limit. */
export const encodedQuietRangesSchema = z
  .array(z.number().int().nonnegative().max(24 * 3600 * CENTISECONDS))
  .max(QUIET_RANGES_MAX_INTERVALS * 2)
  .refine((values) => values.length % 2 === 0, "Quiet ranges come in gap/length pairs");
export type EncodedQuietRanges = z.infer<typeof encodedQuietRangesSchema>;

/** Encodes sorted quiet intervals, shrinking each to whole centiseconds so a
 *  quiet interval never grows. Returns null past QUIET_RANGES_MAX_INTERVALS. */
export function encodeQuietRanges(ranges: readonly SourceRange[]): EncodedQuietRanges | null {
  const encoded: number[] = [];
  let cursor = 0;
  for (const range of [...ranges].sort((a, b) => a.startSec - b.startSec)) {
    const start = Math.max(cursor, Math.ceil(Math.max(0, range.startSec) * CENTISECONDS - 1e-6));
    const end = Math.floor(range.endSec * CENTISECONDS + 1e-6);
    if (end <= start) continue;
    encoded.push(start - cursor, end - start);
    cursor = end;
  }
  return encoded.length / 2 > QUIET_RANGES_MAX_INTERVALS ? null : encoded;
}

export function decodeQuietRanges(encoded: EncodedQuietRanges): SourceRange[] {
  const ranges: SourceRange[] = [];
  let cursor = 0;
  for (let i = 0; i + 1 < encoded.length; i += 2) {
    const startSec = cursor + encoded[i]!;
    cursor = startSec + encoded[i + 1]!;
    ranges.push({ startSec: startSec / CENTISECONDS, endSec: cursor / CENTISECONDS });
  }
  return ranges;
}

export interface ClipCleanupOptions {
  removeSilences: boolean;
  removeFillerWords: boolean;
  /** Measured quiet audio. Null when it was not measured: silence removal
   *  then cuts nothing rather than trusting transcript gaps alone, which
   *  would cut music and laughter. */
  quietRanges: readonly SourceRange[] | null;
  /** Transcript language; filler words are removed only where recognised. */
  languageCode: string | null;
}

/** The cleanup cuts for one clip window, normalized. Empty when nothing was
 *  asked for, or when the cuts would leave nothing to play or exceed the
 *  editor's range limit. */
export function detectClipCleanupRanges(
  utterances: TranscriptUtterance[],
  window: ClipWindow,
  opts: ClipCleanupOptions,
): SourceRange[] {
  const skipFiller = opts.removeFillerWords ? (word: TranscriptUtterance["words"][number]) => isFillerWord(word, opts.languageCode) : undefined;
  const ranges = [
    ...(opts.removeSilences && opts.quietRanges
      ? detectSilenceRanges(utterances, window, {
          quietRanges: [...opts.quietRanges],
          // A filler being cut joins the pauses around it into one gap, so no
          // sliver of pause is left between a silence cut and a filler cut.
          ...(skipFiller ? { skipWord: skipFiller } : {}),
        })
      : []),
    ...(opts.removeFillerWords ? detectFillerWordRanges(utterances, window, { languageCode: opts.languageCode }) : []),
  ];
  if (ranges.length === 0) return [];
  const speech = buildCoverageSpans(utterances, window, skipFiller);
  const normalized = normalizeDeletedRanges(joinSpeechlessSlivers(normalizeDeletedRanges(ranges, window), speech), window);
  if (!deletedRangesSchema.safeParse(normalized).success || buildClipCutPlan(normalized, window).isEmpty) return [];
  return normalized;
}
