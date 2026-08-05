/**
 * Shared conventions for a clip preview proxy's amplitude-peaks artifact —
 * used by both the worker (apps/worker/src/tasks/clip-preview.ts, which cuts
 * the proxy and writes this JSON alongside it) and this package's own
 * clip.service.ts (which presigns a URL to it for the studio's timeline
 * waveform).
 *
 * Storage convention: the peaks JSON always lives at the proxy mp4's OWN
 * key with the `.mp4` extension swapped for `.peaks.json` — a sibling
 * object under the exact same attempt-unique prefix
 * (`projects/<projectId>/previews/<clipId>/<attemptId>.mp4` — see
 * `clipPreviewAttemptStorageKey` in apps/worker/src/tasks/clip-preview.ts).
 * This is DELIBERATELY a derived key rather than a new `Clip` column: the
 * worker only ever needs to swap the extension right after it already built
 * the mp4 key, and every reader that already has `Clip.previewStorageKey`
 * (getClipPreviewSource, the loser-attempt cleanup path in clip-preview.ts)
 * can derive the peaks key the same way — no migration, and no risk of the
 * two keys drifting apart because they were persisted independently.
 *
 * Because the mp4 key is attempt-unique (a fresh key on every regenerate —
 * see clipPreviewAttemptStorageKey's own doc comment), swapping only the
 * key's own trailing `.mp4` is unambiguous: it can never collide with an
 * unrelated path segment, since attempt ids are UUIDs and the key always
 * ends in exactly `<attemptId>.mp4`.
 *
 * A peaks object may not exist for a given `previewStorageKey` even when
 * derivation succeeds: silent-video previews never generate one (see the
 * worker's `probe.hasAudio` guard), and previews cut before this feature
 * shipped never will either. Callers must treat "derived key doesn't
 * resolve" as a normal, expected case — see clip.service.ts's
 * `getClipPreviewSource` (presigns optimistically, no existence check) and
 * the studio's WaveformCanvas (falls back to its synthetic waveform on a
 * failed fetch).
 */
export function derivePeaksStorageKey(previewStorageKey: string): string {
  const MP4_SUFFIX = ".mp4";
  if (!previewStorageKey.endsWith(MP4_SUFFIX)) {
    throw new Error(
      `Cannot derive a peaks key from a preview storage key that doesn't end in ${MP4_SUFFIX}: ${previewStorageKey}`,
    );
  }
  return `${previewStorageKey.slice(0, -MP4_SUFFIX.length)}.peaks.json`;
}

/**
 * A clip preview proxy's amplitude-peaks artifact — mono max-abs amplitude
 * per bin, quantized to an integer 0-100 to keep the payload small (roughly
 * a few KB for a two-minute proxy at the default 20 bins/sec: 20 * 120 =
 * 2400 small integers).
 *
 * `startSec` is the SAME source-absolute value as the proxy's own
 * `Clip.previewStartSec` (the padded preview window's t=0 in source time) —
 * bin `i`'s source time is `startSec + i / peaksPerSec`. `durationSec` is
 * the same padded-window duration as `Clip.previewDurationSec`.
 *
 * `sampleRateHz` is always `null`: this describes the peaks' own time
 * resolution (`peaksPerSec`), not the PCM sample rate the worker happened to
 * decode at to compute them — that rate is an internal detail of the
 * worker's binning pass, not part of this artifact's contract, and callers
 * must never assume a value for it.
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
