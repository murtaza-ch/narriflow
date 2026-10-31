export { resolveDisplayGeometry, type DisplayGeometry } from "@narriflow/validators/source-display-geometry";
import { CLIP_AUTO_LAYOUT_ENGINE, SCREEN_LAYOUT_ENGINE_VERSION, getEffectiveClipTiming } from "@narriflow/validators";
import type { ClipPreparationInput } from "@narriflow/validators/clip-preparation";

export const DEFAULT_PREVIEW_PADDING_SEC = 4;
export const DEFAULT_PREVIEW_MAX_HEIGHT = 540;
export const DEFAULT_PREVIEW_X264_PRESET = "veryfast";
export const DEFAULT_PREVIEW_X264_CRF = "30";
export const DEFAULT_PREVIEW_AUDIO_BITRATE = "64k";
export const DEFAULT_PREVIEW_X264_THREADS = "2";
export const DEFAULT_PREVIEW_FFMPEG_TIMEOUT_MS = 120_000;
export const DEFAULT_PEAKS_PCM_SAMPLE_RATE_HZ = 8000;
export const DEFAULT_PREVIEW_PEAKS_PER_SEC = 20;
export const DEFAULT_CLIP_PREVIEW_PADDING_SEC = DEFAULT_PREVIEW_PADDING_SEC;

export const CLIP_PREPARATION_POLICY = Object.freeze({
  version: 1,
  preview: Object.freeze({ paddingSec: DEFAULT_PREVIEW_PADDING_SEC, maxHeight: DEFAULT_PREVIEW_MAX_HEIGHT,
    x264Preset: DEFAULT_PREVIEW_X264_PRESET, x264Crf: DEFAULT_PREVIEW_X264_CRF,
    audioBitrate: DEFAULT_PREVIEW_AUDIO_BITRATE, x264Threads: DEFAULT_PREVIEW_X264_THREADS,
    timeoutMs: DEFAULT_PREVIEW_FFMPEG_TIMEOUT_MS }),
  peaks: Object.freeze({ sampleRateHz: DEFAULT_PEAKS_PCM_SAMPLE_RATE_HZ, peaksPerSec: DEFAULT_PREVIEW_PEAKS_PER_SEC,
    deadlineMs: DEFAULT_PREVIEW_FFMPEG_TIMEOUT_MS }),
  observations: Object.freeze({ automatic: CLIP_AUTO_LAYOUT_ENGINE, screen: SCREEN_LAYOUT_ENGINE_VERSION, split: "explicit-split-v1",
    sampleFps: 4, sceneThreshold: 0.3, pipMotionThreshold: 0.12, probeTimeoutMs: 120_000,
    python: "python3", modelPath: "/usr/local/share/narriflow/face_yunet.onnx" }),
});
export async function clipPreparationEngineHash(toolchainFingerprint: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(toolchainFingerprint)) throw new Error("clip_preparation_engine_invalid");
  const bytes = new TextEncoder().encode(JSON.stringify({ toolchainFingerprint, policy: CLIP_PREPARATION_POLICY }));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}

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
