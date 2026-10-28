import {
  isClipPreviewPeaks as isClipPreviewPeaksShape,
  type ClipPreviewPeaks,
} from "@narriflow/validators/clip-preview-peaks";

export { isClipPreviewPeaksShape };

/**
 * Samples the amplitude at a given SOURCE-time instant from a peaks
 * artifact — nearest-bin lookup (no interpolation; at the default 20
 * bins/sec against an ~80px/sec timeline zoom, several pixels legitimately
 * share one bin, which reads as a perfectly normal waveform bar width).
 *
 * Mirrors the shape of the pre-existing synthetic-waveform sampling in
 * timeline.tsx's `WaveformCanvas` (which indexes `speechRanges`/
 * `wordRanges` by the same `absoluteTime` this function takes) — callers
 * project an EDITED-timeline pixel to source time via `editedToSource`
 * first, then pass that source time straight in here.
 *
 * Returns 0 for any time outside `[startSec, startSec + durationSec)` by
 * clamping to the nearest edge bin rather than returning silence — a
 * caption/word can legitimately sit a fraction of a bin past the last
 * sample due to floating-point rounding, and clamping avoids a visible
 * one-bin gap at the proxy window's edges.
 */
export function sampleAmplitudeAtSourceTime(
  peaks: ClipPreviewPeaks,
  sourceTimeSec: number,
): number {
  if (peaks.peaks.length === 0 || peaks.peaksPerSec <= 0) return 0;

  const relativeSec = sourceTimeSec - peaks.startSec;
  const index = Math.round(relativeSec * peaks.peaksPerSec);
  const clampedIndex = Math.max(0, Math.min(peaks.peaks.length - 1, index));
  const raw = peaks.peaks[clampedIndex] ?? 0;

  // Stored as an integer 0-100 (see ClipPreviewPeaks's doc comment) —
  // normalize back to 0..1 and defensively clamp in case of a corrupt/
  // out-of-range artifact.
  return Math.max(0, Math.min(1, raw / 100));
}

/** Where peaks are read from; `cacheScope` keeps accounts and Workspaces apart. */
export interface PeaksSource {
  readonly cacheScope: string;
  peaks(path: string): Promise<unknown>;
}

// Endpoint responses are immutable for one preview attempt. Cache both success
// and failure so timeline remounts/resizes never repeat the request or R2
// metadata read.
const peaksRequestCache = new Map<string, Promise<ClipPreviewPeaks | null>>();

/** `path` is the API-relative URL the preview source returns; the source adds the origin and Bearer token. */
export function loadClipPreviewPeaks(path: string, source: PeaksSource): Promise<ClipPreviewPeaks | null> {
  const cacheKey = `${source.cacheScope}:${path}`;
  const cached = peaksRequestCache.get(cacheKey);
  if (cached) return cached;
  const request = source
    .peaks(path)
    .then((value) => (isClipPreviewPeaksShape(value) ? value : null))
    .catch(() => null);
  peaksRequestCache.set(cacheKey, request);
  return request;
}
