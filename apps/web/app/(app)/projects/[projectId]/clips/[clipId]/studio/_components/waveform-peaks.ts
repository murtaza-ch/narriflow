import type { ClipPreviewPeaks } from "@narriflow/services";

/**
 * Runtime shape guard for a fetched peaks JSON. This is untrusted data as
 * far as the client is concerned — it comes back from an R2 object over a
 * presigned URL, not from a typed server call — so a malformed or
 * unexpected-shape payload (a stale/legacy artifact, a future format
 * version this build doesn't know about) must fail closed into "no peaks"
 * rather than crash the waveform paint.
 */
export function isClipPreviewPeaksShape(value: unknown): value is ClipPreviewPeaks {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    v.sampleRateHz === null &&
    typeof v.peaksPerSec === "number" &&
    v.peaksPerSec > 0 &&
    typeof v.startSec === "number" &&
    typeof v.durationSec === "number" &&
    Array.isArray(v.peaks) &&
    v.peaks.every((p) => typeof p === "number")
  );
}

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

/**
 * Module-level cache of in-flight/settled peaks fetches, keyed by URL — a
 * clip's presigned peaks URL is stable for the lifetime of one studio
 * session (it's only reissued by the preview-status poll once, when the
 * proxy first lands), so re-mounting `WaveformCanvas` (e.g. toggling the
 * timeline, resizing) must not re-fetch the same JSON. A failed fetch
 * resolves to `null` and that `null` is cached too — a presigned URL that
 * 404s (no peaks object at the derived key) will never start succeeding
 * without a fresh URL, so there's nothing to gain by retrying it.
 */
const peaksRequestCache = new Map<string, Promise<ClipPreviewPeaks | null>>();

/**
 * Fetches and validates a clip preview's peaks JSON, deduped by URL via
 * {@link peaksRequestCache}. Resolves to `null` on any failure (network
 * error, non-2xx response, JSON parse failure, or a shape that fails
 * {@link isClipPreviewPeaksShape}) — callers treat `null` identically to
 * "no peaks available yet," which is also the seed state before this
 * resolves, so there's no separate error branch for the canvas to render.
 */
export function loadClipPreviewPeaks(url: string): Promise<ClipPreviewPeaks | null> {
  const cached = peaksRequestCache.get(url);
  if (cached) return cached;

  const request = fetch(url)
    .then((res) => (res.ok ? (res.json() as Promise<unknown>) : null))
    .then((data) => (isClipPreviewPeaksShape(data) ? data : null))
    .catch(() => null);

  peaksRequestCache.set(url, request);
  return request;
}
