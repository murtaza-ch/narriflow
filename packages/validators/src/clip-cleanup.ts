import { z } from "zod";
import { buildClipCutPlan, FLOAT_SLACK, MIN_KEPT_SEGMENT_SEC, normalizeDeletedRanges, type ClipWindow, type SourceRange } from "./edit-ranges";
import { detectFillerWordRanges, removableFillerWords } from "./filler-words";
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
  // Exactly the fillers filler removal cuts; a kept filler stays speech.
  const removable = opts.removeFillerWords ? removableFillerWords(utterances, window, opts.languageCode) : null;
  const skipFiller = removable ? (word: TranscriptUtterance["words"][number]) => removable.has(word) : undefined;
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
  const joined = joinSpeechlessSlivers(normalizeDeletedRanges(ranges, window), speech);
  const normalized = normalizeDeletedRanges(capToEditorLimit(keepSpeechRenderable(joined, speech, window)), window);
  if (normalized.length === 0 || buildClipCutPlan(normalized, window).isEmpty) return [];
  return normalized;
}

/** The editor holds at most this many cuts per clip (`deletedRangesSchema`). */
const EDITOR_MAX_CUTS = 500;

/** Past the editor's limit, keeps the longest cuts: most of the time saved,
 *  never a refused document. */
function capToEditorLimit(cuts: SourceRange[]): SourceRange[] {
  if (cuts.length <= EDITOR_MAX_CUTS) return cuts;
  return [...cuts].sort((a, b) => b.endSec - b.startSec - (a.endSec - a.startSec)).slice(0, EDITOR_MAX_CUTS)
    .sort((a, b) => a.startSec - b.startSec);
}

/** The render drops kept pieces shorter than MIN_KEPT_SEGMENT_SEC, which would
 *  silently delete a word left between two close cuts. Widens every such
 *  piece that holds speech by pulling its neighbouring cuts back, dropping a
 *  cut that shrinks to nothing (under a millisecond). Wordless slivers are left for the render to drop. */
function keepSpeechRenderable(input: SourceRange[], speech: SourceRange[], window: ClipWindow): SourceRange[] {
  let cuts = input.map((cut) => ({ ...cut }));
  const target = MIN_KEPT_SEGMENT_SEC + 0.005; // margin over the render's check after millisecond rounding
  for (let pass = 0; pass < 16; pass += 1) {
    let changed = false;
    for (let i = 0; i <= cuts.length; i += 1) {
      const before = i > 0 ? cuts[i - 1]! : null;
      const after = i < cuts.length ? cuts[i]! : null;
      const from = before ? before.endSec : window.startSec;
      const to = after ? after.startSec : window.endSec;
      if (to - from >= target - FLOAT_SLACK) continue;
      if (!speech.some((s) => s.startSec < to + FLOAT_SLACK && s.endSec > from - FLOAT_SLACK)) continue;
      const need = target - Math.max(0, to - from);
      const share = before && after ? need / 2 : need;
      if (before) before.endSec -= share;
      if (after) after.startSec += share;
      changed = true;
    }
    // Only a cut this pass shrank to nothing goes; a short filler cut stays.
    cuts = cuts.filter((cut) => cut.endSec - cut.startSec > 0.001);
    if (!changed) break;
  }
  return cuts;
}
