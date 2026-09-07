import { CLIP_MAX_DURATION_SEC, CLIP_MIN_DURATION_SEC } from "@narriflow/validators";
import { nearestWordBoundary, type TrimWord } from "./trim-transcript-cache";

/** Pointer and keyboard trims obey the same source and clip-duration limits. */
export function resolveTrimPosition(input: {
  side: "start" | "end";
  startSec: number;
  endSec: number;
  candidateSec: number;
  sourceDurationSec: number;
  words?: TrimWord[];
}): number {
  const minimum = input.side === "start"
    ? Math.max(0, input.endSec - CLIP_MAX_DURATION_SEC)
    : input.startSec + CLIP_MIN_DURATION_SEC;
  const maximum = input.side === "start"
    ? input.endSec - CLIP_MIN_DURATION_SEC
    : Math.min(input.sourceDurationSec, input.startSec + CLIP_MAX_DURATION_SEC);
  const clamp = (value: number) => Math.max(minimum, Math.min(value, maximum));
  const position = clamp(input.candidateSec);
  return input.words ? clamp(nearestWordBoundary(input.words, position, input.side)) : position;
}
