/**
 * A clip preview proxy's amplitude-peaks artifact — mono max-abs amplitude
 * per bin, quantized to an integer 0-100 to keep the payload small.
 *
 * `startSec` is the SAME source-absolute value as the proxy's own
 * `Clip.previewStartSec`; bin `i`'s source time is `startSec + i / peaksPerSec`.
 * `sampleRateHz` is always `null`: the artifact describes its own time
 * resolution (`peaksPerSec`), not the PCM rate the worker decoded at.
 *
 * Client-safe home for the type and its guard so browser code can validate the
 * artifact without importing the services bundle.
 */
export interface ClipPreviewPeaks {
  version: 1;
  sampleRateHz: null;
  peaksPerSec: number;
  startSec: number;
  durationSec: number;
  /** Mono max-abs amplitude per bin, quantized to integers in [0, 100]. */
  peaks: number[];
}

/** Runtime validation before the artifact crosses the server/client boundary. */
export function isClipPreviewPeaks(value: unknown): value is ClipPreviewPeaks {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    candidate.sampleRateHz === null &&
    typeof candidate.peaksPerSec === "number" &&
    Number.isFinite(candidate.peaksPerSec) &&
    candidate.peaksPerSec > 0 &&
    typeof candidate.startSec === "number" &&
    Number.isFinite(candidate.startSec) &&
    typeof candidate.durationSec === "number" &&
    Number.isFinite(candidate.durationSec) &&
    candidate.durationSec > 0 &&
    Array.isArray(candidate.peaks) &&
    candidate.peaks.length <= 20_000 &&
    candidate.peaks.every(
      (peak) => Number.isInteger(peak) && peak >= 0 && peak <= 100,
    )
  );
}
