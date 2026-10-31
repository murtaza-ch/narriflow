import { getEffectiveClipTiming } from "@narriflow/validators";
import type { ClipPreparationInput } from "@narriflow/validators/clip-preparation";

export const DEFAULT_CLIP_PREVIEW_PADDING_SEC = 4;

export interface ClipPreviewWindow {
  /** The proxy's t=0, expressed in *source* time — persisted verbatim as
   *  the clip's `previewStartSec`. */
  startSec: number;
  /** The padded window's end, in source time. */
  endSec: number;
  durationSec: number;
}

/**
 * Computes the padded source-time window to cut a clip's preview proxy
 * from: `paddingSec` on each side (so small trim tweaks in the studio don't
 * need a re-cut), clamped to `[0, sourceDurationSec]`. When the source
 * duration isn't known, only the lower bound is clamped — ffmpeg's `-t`
 * naturally truncates at end-of-file, so a loose upper bound can't overrun
 * into anything that doesn't exist.
 */
export function computeClipPreviewWindow(
  clipStartSec: number,
  clipEndSec: number,
  sourceDurationSec: number | null,
  paddingSec: number = DEFAULT_CLIP_PREVIEW_PADDING_SEC,
): ClipPreviewWindow {
  const rawStart = clipStartSec - paddingSec;
  const rawEnd = clipEndSec + paddingSec;

  const startSec = Math.max(0, rawStart);
  const cappedEnd =
    sourceDurationSec !== null && sourceDurationSec > 0
      ? Math.min(rawEnd, sourceDurationSec)
      : rawEnd;
  // Never invert: a malformed/zero-length input clamps to a zero-duration
  // window rather than a negative one — callers treat durationSec <= 0 as
  // "skip this clip".
  const endSec = Math.max(startSec, cappedEnd);

  return {
    startSec: Number(startSec.toFixed(3)),
    endSec: Number(endSec.toFixed(3)),
    durationSec: Number((endSec - startSec).toFixed(3)),
  };
}


/** Same effective source window as preview admission and the Studio snapshot. */
export function clipPreparationTiming(input: Pick<ClipPreparationInput, "document" | "sourceProbe">) {
  return getEffectiveClipTiming({ utterances: input.document.transcriptSlice, startSec: input.document.clipStartSec,
    endSec: input.document.clipEndSec, sourceDurationSec: input.sourceProbe.durationSec, tailPadSec: 0 });
}
export function clipPreparationPreviewWindow(input: Pick<ClipPreparationInput, "document" | "sourceProbe">) {
  const effective = clipPreparationTiming(input);
  return computeClipPreviewWindow(effective.startSec, effective.endSec, input.sourceProbe.durationSec);
}
