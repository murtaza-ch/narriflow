/**
 * Shared conventions for a clip preview proxy's amplitude-peaks artifact —
 * used by both the worker (apps/worker/src/tasks/clip-preview.ts, which cuts
 * the proxy and writes this JSON alongside it) and this package's own
 * clip.service.ts (which reads and validates it for the studio timeline).
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
 * shipped never will either. Callers treat "derived key doesn't resolve" as
 * a normal, expected case: `getClipPreviewSource` returns null peaks and the
 * studio's WaveformCanvas falls back to its synthetic waveform.
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
 * Deletion-path variant of `derivePeaksStorageKey`: storage deletion and the
 * Clip Editor Document cleanup planner work from the persisted preview key.
 * Cleanup planning must never throw over an unusable key, so this returns
 * `null` when derivation is impossible; callers simply omit the peaks object.
 */
export function tryDerivePeaksStorageKey(
  previewStorageKey: string | null,
): string | null {
  if (!previewStorageKey) return null;
  try {
    return derivePeaksStorageKey(previewStorageKey);
  } catch {
    return null;
  }
}

// The artifact's type and guard live in @narriflow/validators so browser code
// can validate it without importing the services bundle. Re-exported here so
// the worker and clip.service keep one import site.
export {
  isClipPreviewPeaks,
  type ClipPreviewPeaks,
} from "@narriflow/validators/clip-preview-peaks";
