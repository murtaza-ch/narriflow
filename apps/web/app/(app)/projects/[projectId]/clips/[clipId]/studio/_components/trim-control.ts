import { clipDurationBounds, clipMaxWindowSec } from "@narriflow/validators";
import { nearestWordBoundary, type TrimWord } from "./trim-transcript-cache";

/** Where each trim handle may sit: the source's edges and the clip's duration
 * bounds. The server enforces the same `clipDurationBounds`, so a trim that
 * the handles allow is one the save accepts. */
export function trimLimits(input: {
  side: "start" | "end";
  startSec: number;
  endSec: number;
  sourceDurationSec: number;
  wholeSource: boolean;
}): { minimum: number; maximum: number } {
  const { minSec } = clipDurationBounds(input.wholeSource);
  const maxSec = clipMaxWindowSec(input.wholeSource);
  return input.side === "start"
    ? { minimum: Math.max(0, input.endSec - maxSec), maximum: input.endSec - minSec }
    : { minimum: input.startSec + minSec, maximum: Math.min(input.sourceDurationSec, input.startSec + maxSec) };
}

/** The source edge a trim stops at. A whole-source clip ends where its source
 * does (the probed duration), so a silent or caption-less video, whose
 * transcript has no last word to bound it, still trims; any other clip stops at
 * the transcript's last word. */
export function trimSourceCeilingSec(
  clip: { wholeSource: boolean; sourceEdgeSec: number | null },
  transcriptCeilingSec: number,
): number {
  return clip.wholeSource && clip.sourceEdgeSec !== null ? clip.sourceEdgeSec : transcriptCeilingSec;
}

/** Pointer and keyboard trims obey the same source and clip-duration limits. */
export function resolveTrimPosition(input: {
  side: "start" | "end";
  startSec: number;
  endSec: number;
  candidateSec: number;
  sourceDurationSec: number;
  /** The clip is its whole source, so its duration bounds are 1 to 180 seconds. */
  wholeSource: boolean;
  words?: TrimWord[];
}): number {
  const { minimum, maximum } = trimLimits(input);
  const clamp = (value: number) => Math.max(minimum, Math.min(value, maximum));
  const position = clamp(input.candidateSec);
  return input.words ? clamp(nearestWordBoundary(input.words, position, input.side)) : position;
}
