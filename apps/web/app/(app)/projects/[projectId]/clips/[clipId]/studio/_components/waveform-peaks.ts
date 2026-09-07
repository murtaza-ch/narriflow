import {
  isClipPreviewPeaks as isClipPreviewPeaksShape,
  type ClipPreviewPeaks,
} from "@narriflow/services/clip-preview-storage";

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

// Same-origin endpoint responses are immutable for one preview attempt. Cache
// both success and failure so timeline remounts/resizes never repeat the web
// request or R2 metadata read.
const peaksRequestCache = new Map<string, Promise<ClipPreviewPeaks | null>>();

export function loadClipPreviewPeaks(url: string): Promise<ClipPreviewPeaks | null> {
  const cached = peaksRequestCache.get(url);
  if (cached) return cached;
  const request = fetch(url, { credentials: "same-origin" })
    .then((response) => (response.ok ? (response.json() as Promise<unknown>) : null))
    .then((value) => (isClipPreviewPeaksShape(value) ? value : null))
    .catch(() => null);
  peaksRequestCache.set(url, request);
  return request;
}
