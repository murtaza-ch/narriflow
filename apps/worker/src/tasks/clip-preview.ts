import { putFileFromPath } from "../r2-file-transfer";
import { computeClipPreviewWindow, type ClipPreviewWindow, clipPreviewAttemptStorageKey, buildClipPreviewArgs, buildAudiogramPreviewArgs, persistOptionalClipPreviewPeaks, clipPreviewOutputExpectation, encodeAndValidateClipPreview } from "../../../media/src/tasks/clip-preview";
export { computeClipPreviewWindow, type ClipPreviewWindow, sourceTimeToPreviewTime, previewTimeToSourceTime, clipPreviewAttemptStorageKey, buildClipPreviewArgs, audiogramPreviewDimensions, type AudiogramPreviewDimensions, buildAudiogramPreviewArgs, buildPeaksExtractionArgs, computeAmplitudePeaks, quantizePeaks, generateClipPreviewPeaks, persistOptionalClipPreviewPeaks, clipPreviewOutputExpectation, encodeAndValidateClipPreview } from "../../../media/src/tasks/clip-preview";
import { executorProcessFailure } from "../../../media/src/worker-process";
/**
 * Generates lightweight preview proxies for clips so the studio and the
 * project-page clip cards never have to stream the full (multi-hundred-MB
 * to multi-GB) source just to preview a few seconds of footage. Each proxy
 * is a small, 540p, faststart MP4 covering a clip's range plus a little
 * padding on each side, cut directly from the source with a fast input
 * seek.
 *
 * Audio-only sources (podcast MP3/WAV/M4A — a first-class Narriflow source
 * type, not an edge case) get an "audiogram" proxy instead of no proxy at
 * all: an animated ffmpeg `showwaves` waveform over a solid background,
 * matching the Clip Composition Plan's audiogram presentation, but capped
 * at 540p with no burned-in captions (the studio
 * overlays captions in HTML at preview time). These clips must never be
 * left with nothing to preview — that's worse than the pre-proxy
 * full-source-streaming behaviour this feature exists to replace. Telling
 * "real video" apart from a podcast MP3's embedded cover-art image (which
 * ffprobe reports as its own video stream) is the load-bearing bit — see
 * the shared worker process module's media inspection contract.
 *
 * This deliberately *polls for clips missing a proxy* rather than being
 * triggered from detect-clips.ts, so it also backfills every pre-existing
 * clip and stays fully decoupled from the moment_detection/clip_rendering
 * workflow-run machinery — a proxy is either present or it isn't, there's
 * no "run" to track.
 *
 * See apps/worker/src/tasks/clip-render-attempt.ts / broll.ts for the house style
 * this mirrors (structured logs, small env-overridable encode knobs,
 * `-ss` before `-i` for a fast seek, per-item try/catch so one bad clip
 * never fails the batch).
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  getLayoutEvidenceLifecycle,
  deleteObject,
  derivePeaksStorageKey,
  presignDownloadUrl,
  putJson,
} from "@narriflow/services";
import { productionWorkerProcessModule, resolveDisplayGeometry, type WorkerProcessModule } from "../../../media/src/worker-process";

import type { ClipPendingPreview } from "@narriflow/services";

function log(level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>) {
  // Structured logs per CLAUDE.md: console.warn(JSON.stringify({level,message,...ctx})).
  console.warn(
    JSON.stringify({
      level,
      message,
      ts: new Date().toISOString(),
      ...context,
    }),
  );
}

// ─── Env-overridable encode knobs ──────────────────────────────────────────
// Preview-specific encode settings stay local to this task. Full-quality
// export uses the Clip Render Attempt's render configuration.

const DEFAULT_PREVIEW_BATCH_SIZE = 5;

/** Presign lifetime for the streamed source. Kept generous even though each
 *  clip now gets its own fresh presign (see the "Refresh per clip" comment
 *  on processPendingClipPreviews) — this is just the per-URL TTL, not a
 *  batch-wide budget anymore. */
const SOURCE_STREAM_URL_TTL_SEC = 3600;
const DEFAULT_PREVIEW_FFPROBE_TIMEOUT_MS = 30_000;
// Storage lifetimes. Each is a ceiling on one R2 operation, layered on the
// worker shutdown signal, so a stalled PUT/DELETE can never pin the preview
// loop. A preview proxy is ~1-3 MB (multipart only past 16 MB) and the peaks
// JSON is a few KB; cleanup deletes are best-effort and never fail a clip.
export const PREVIEW_STORAGE_TIMEOUTS = {
  mediaUploadMs: 120_000,
  peaksUploadMs: 30_000,
  cleanupMs: 10_000,
} as const;
// A permanently-broken clip (corrupt source slice, unsupported codec, ...)
// must not monopolize every tick's batch forever — see the
// ClipPreviewFailureBackoff class below. Base delay doubles per consecutive
// failure, capped at maxDelayMs.
const DEFAULT_PREVIEW_FAILURE_BACKOFF_BASE_MS = 30_000; // 30s
const DEFAULT_PREVIEW_FAILURE_BACKOFF_MAX_MS = 30 * 60_000; // 30 min
const DEFAULT_PREVIEW_FAILURE_BACKOFF_MAX_ENTRIES = 500;

// getClipsNeedingPreview's own `take` clamps to 25 regardless of what's
// requested (see clip.service.ts) — this just says "ask for that much" so a
// backoff-skipped top-N doesn't starve the rest of the queue (Fix 3). Safe
// to request more than the service will ever return.
const DEFAULT_PREVIEW_CANDIDATE_POOL_SIZE = 25;

function previewBatchSize(): number {
  const raw = Number(process.env.WORKER_CLIP_PREVIEW_BATCH_SIZE?.trim());
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_PREVIEW_BATCH_SIZE;
}

function previewFfprobeTimeoutMs(): number {
  const raw = Number(
    process.env.WORKER_CLIP_PREVIEW_FFPROBE_TIMEOUT_MS?.trim(),
  );
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_PREVIEW_FFPROBE_TIMEOUT_MS;
}

function previewFailureBackoffBaseMs(): number {
  const raw = Number(
    process.env.WORKER_CLIP_PREVIEW_FAILURE_BACKOFF_BASE_MS?.trim(),
  );
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_PREVIEW_FAILURE_BACKOFF_BASE_MS;
}

function previewFailureBackoffMaxMs(): number {
  const raw = Number(
    process.env.WORKER_CLIP_PREVIEW_FAILURE_BACKOFF_MAX_MS?.trim(),
  );
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_PREVIEW_FAILURE_BACKOFF_MAX_MS;
}

/**
 * In-process exponential backoff for clips whose preview keeps failing.
 *
 * `getClipsNeedingPreview` returns the highest-virality clips still missing a
 * proxy, in the same order, every tick. Without this, a handful of clips that
 * can never succeed (corrupt source range, unsupported codec) would refill the
 * batch forever and no lower-ranked clip would ever be attempted — burning
 * ffprobe/ffmpeg work on each pass. Backing them off lets the queue drain past
 * them while still retrying periodically in case the cause was transient.
 *
 * Deliberately in-process: a durable version needs `attempts` / `nextAttemptAt`
 * / terminal-error columns on `Clip`, which is a migration. Losing this state on
 * restart is acceptable — the worst case is one extra attempt per clip per boot.
 * Bounded so a long-lived worker can't grow it without limit.
 */
export class ClipPreviewFailureBackoff {
  private readonly entries = new Map<
    string,
    { failures: number; nextAttemptAtMs: number }
  >();

  constructor(
    private readonly baseMs: number = previewFailureBackoffBaseMs(),
    private readonly maxMs: number = previewFailureBackoffMaxMs(),
    private readonly maxEntries: number = DEFAULT_PREVIEW_FAILURE_BACKOFF_MAX_ENTRIES,
  ) {}

  /** True when this clip is still inside its backoff window. */
  shouldSkip(clipId: string, nowMs: number): boolean {
    const entry = this.entries.get(clipId);
    return entry !== undefined && nowMs < entry.nextAttemptAtMs;
  }

  recordFailure(clipId: string, nowMs: number): void {
    const failures = (this.entries.get(clipId)?.failures ?? 0) + 1;
    // 2^(n-1) * base, capped. Math.min guards against overflow at high n.
    const delayMs = Math.min(this.maxMs, this.baseMs * 2 ** (failures - 1));
    this.entries.set(clipId, { failures, nextAttemptAtMs: nowMs + delayMs });

    if (this.entries.size > this.maxEntries) {
      // Map preserves insertion order, so the oldest key is the first one.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /** A clip that finally succeeded should not carry its history forward. */
  recordSuccess(clipId: string): void {
    this.entries.delete(clipId);
  }
}

/** Module-level so backoff survives across poll ticks within one process. */
const previewFailureBackoff = new ClipPreviewFailureBackoff();

function previewCandidatePoolSize(): number {
  const raw = Number(
    process.env.WORKER_CLIP_PREVIEW_CANDIDATE_POOL_SIZE?.trim(),
  );
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_PREVIEW_CANDIDATE_POOL_SIZE;
}

function squarePixelPreview(probe: Parameters<typeof resolveDisplayGeometry>[0]): { squarePixelAspect?: number } {
  const geometry = resolveDisplayGeometry(probe);
  return geometry.anamorphic ? { squarePixelAspect: geometry.width / geometry.height } : {};
}

// ─── Orchestration ──────────────────────────────────────────────────────────

// ─── Storage lifetime ───────────────────────────────────────────────────────

export interface ClipPreviewStorage {
  putFileFromPath: typeof putFileFromPath;
  putJson: typeof putJson;
  deleteObject: typeof deleteObject;
}

const productionClipPreviewStorage: ClipPreviewStorage = {
  putFileFromPath,
  putJson,
  deleteObject,
};

/**
 * Deletes objects this attempt wrote, each under its own deadline and
 * independent of the (possibly already aborted) attempt signal. Never throws
 * and never outlives `timeoutMs`: an unconfirmed delete is logged and left to
 * the maintenance reaper, so cleanup can neither fail nor stall a render.
 */
export async function deleteClipPreviewObjectsBestEffort(params: {
  storage: ClipPreviewStorage;
  keys: readonly string[];
  timeoutMs: number;
  context: { clipId: string; projectId: string };
}): Promise<void> {
  await Promise.all(
    params.keys.map(async (key) => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve("timeout");
        }, params.timeoutMs);
      });
      const attempt = params.storage
        .deleteObject(key, { signal: controller.signal })
        .then(
          () => "deleted" as const,
          (error: unknown) => error,
        );
      try {
        const outcome = await Promise.race([attempt, stalled]);
        if (outcome !== "deleted") {
          log("warn", "clip_preview_cleanup_unconfirmed", {
            ...params.context,
            key,
            reason: outcome === "timeout" ? "timeout" : "failed",
            error: outcome instanceof Error ? outcome.message : undefined,
          });
        }
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

/**
 * Uploads a validated preview (and optional peaks), then claims it for the
 * clip. Every storage call carries the worker shutdown signal plus its own
 * deadline; shutdown after the upload stops before the claim, so an aborted
 * attempt can never publish a ready preview. Objects written by an attempt
 * that does not publish are deleted best-effort (bounded); once the claim has
 * been issued nothing is deleted on error, since it may have committed.
 */
export async function storeAndPublishClipPreview(params: {
  workerProcess: WorkerProcessModule;
  signal: AbortSignal;
  clip: ClipPendingPreview;
  outputPath: string;
  hasAudio: boolean;
  window: ClipPreviewWindow;
  validatedDurationSec: number;
  storage?: ClipPreviewStorage;
  completePreview?: ReturnType<typeof getLayoutEvidenceLifecycle>["completePreview"];
  timeouts?: typeof PREVIEW_STORAGE_TIMEOUTS;
}): Promise<{ persisted: true; peaksKey: string | null } | { persisted: false }> {
  const { clip, window, signal } = params;
  const storage = params.storage ?? productionClipPreviewStorage;
  const timeouts = params.timeouts ?? PREVIEW_STORAGE_TIMEOUTS;
  const context = { clipId: clip.id, projectId: clip.projectId };
  const cleanup = (keys: readonly string[]) =>
    deleteClipPreviewObjectsBestEffort({ storage, keys, timeoutMs: timeouts.cleanupMs, context });

  // Attempt-unique key. Two workers racing the same clip used to upload to
  // one shared key and claim afterwards, so the loser's cleanup deleted the
  // very object the winner's row now pointed at (and concurrent writes to a
  // single key also breach R2's ~1 write/sec/key limit). With a per-attempt
  // key the loser can only ever delete its own bytes.
  const key = clipPreviewAttemptStorageKey(clip.projectId, clip.id, randomUUID());
  const candidatePeaksKey = derivePeaksStorageKey(key);
  let peaksWriteStarted = false;
  let peaksKey: string | null = null;

  try {
    await storage.putFileFromPath({
      key,
      filePath: params.outputPath,
      contentType: "video/mp4",
      metadata: {
        project_id: clip.projectId,
        clip_id: clip.id,
        kind: "preview",
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeouts.mediaUploadMs)]),
    });

    // Waveform peaks: uploaded BEFORE the DB claim below, exactly like the mp4
    // itself — completeClipPreview's existing conditional claim (previewStorageKey
    // IS NULL + boundary-window match) already guards staleness for the whole
    // attempt, so nothing extra is needed to keep the peaks key "attached" to
    // the same completion; it's simply present (or not) by the time the claim
    // runs. Silent-video previews (no audio track — see buildClipPreviewArgs's
    // `hasAudio` branch) never get a peaks artifact, since there's nothing to
    // extract; the studio's WaveformCanvas falls back to its synthetic
    // waveform for those exactly as it does for a still-pending proxy. A
    // peaks-generation failure (including its own upload deadline) is logged
    // and swallowed rather than failing the whole preview attempt — a proxy
    // with no waveform is still a working proxy, and this pass runs on the
    // small local proxy file, not the remote source. Only worker shutdown
    // (the parent signal) stops the attempt.
    if (params.hasAudio) {
      const persisted = await persistOptionalClipPreviewPeaks({
        workerProcess: params.workerProcess,
        signal,
        proxyFilePath: params.outputPath,
        windowStartSec: window.startSec,
        windowDurationSec: params.validatedDurationSec,
        persist: (peaksPayload) => {
          peaksWriteStarted = true;
          return storage.putJson({
            key: candidatePeaksKey,
            value: peaksPayload,
            metadata: {
              project_id: clip.projectId,
              clip_id: clip.id,
              kind: "preview_peaks",
            },
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeouts.peaksUploadMs)]),
          });
        },
        diagnose: (error) =>
          log("warn", "clip_preview_peaks_failed", {
            ...context,
            error: error instanceof Error ? error.message : "Unknown error",
          }),
      });
      peaksKey = persisted ? candidatePeaksKey : null;
      // A timed-out PUT may still land server-side; do not leave it behind.
      if (!persisted && peaksWriteStarted) await cleanup([candidatePeaksKey]);
    }

    signal.throwIfAborted();
  } catch (error) {
    await cleanup(peaksWriteStarted ? [key, candidatePeaksKey] : [key]);
    throw error;
  }

  const completePreview =
    params.completePreview ??
    ((id, input) => getLayoutEvidenceLifecycle().completePreview(id, input));
  const result = await completePreview(clip.id, {
    storageKey: key,
    startSec: window.startSec,
    durationSec: window.durationSec,
    // The clip boundary window this cut was made for (see
    // ClipPendingPreview's comment) — NOT `window`, which is the padded
    // preview window derived from it. A boundary edit/reset that lands
    // while this cut was in flight moves the clip's stored startSec/endSec
    // away from these values, so the service's claim correctly rejects a
    // stale attempt instead of persisting a proxy for the wrong window.
    expectedClipStartSec: clip.startSec,
    expectedClipEndSec: clip.endSec,
    expectedEditorRevision: clip.editorRevision,
  });

  if (!result.persisted) {
    // Lost the race to another worker cutting the same clip concurrently.
    // `key` (and `peaksKey`, if this attempt generated one) are this
    // attempt's own unique objects, so deleting them can never touch the
    // bytes the winning row points at.
    await cleanup(peaksKey ? [key, peaksKey] : [key]);
    log("info", "clip_preview_lost_claim_race", context);
    return { persisted: false };
  }
  return { persisted: true, peaksKey };
}

async function cutAndUploadClipPreview(params: {
  workerProcess: WorkerProcessModule;
  signal: AbortSignal;
  clip: ClipPendingPreview;
  sourcePath: string;
  tempDir: string;
}): Promise<boolean> {
  const { clip, sourcePath, tempDir } = params;

  let window = computeClipPreviewWindow(
    clip.startSec,
    clip.endSec,
    clip.sourceDurationSec,
  );

  if (window.durationSec <= 0) {
    log("error", "clip_preview_invalid_window", {
      clipId: clip.id,
      projectId: clip.projectId,
      startSec: clip.startSec,
      endSec: clip.endSec,
    });
    return false;
  }

  const probe = await params.workerProcess.inspectMedia({
    sourcePath,
    signal: params.signal,
    deadlineMs: previewFfprobeTimeoutMs(),
  });
  if (!probe.hasVideo && !probe.hasAudio) {
    // Neither a real video stream nor audio — e.g. a corrupt file, or one
    // that's *only* an attached-picture stream with no audio alongside it.
    // Nothing playable to build a proxy from; skip rather than crash the
    // batch (mirrors the invalid-window guard above).
    log("error", "clip_preview_no_playable_stream", {
      clipId: clip.id,
      projectId: clip.projectId,
    });
    return false;
  }

  if (clip.sourceDurationSec === null && probe.durationSec !== null) {
    window = computeClipPreviewWindow(clip.startSec, clip.endSec, probe.durationSec);
  }

  const outputPath = join(tempDir, `${clip.id}-preview.mp4`);
  const previewKind: "video" | "audiogram" = probe.hasVideo ? "video" : "audiogram";
  const args = probe.hasVideo
    ? buildClipPreviewArgs({
        sourcePath,
        outputPath,
        windowStartSec: window.startSec,
        windowDurationSec: window.durationSec,
        hasAudio: probe.hasAudio,
        ...squarePixelPreview(probe),
      })
    : buildAudiogramPreviewArgs({
        sourcePath,
        outputPath,
        windowStartSec: window.startSec,
        windowDurationSec: window.durationSec,
      });

  const validated = await encodeAndValidateClipPreview({
    workerProcess: params.workerProcess,
    signal: params.signal,
    args,
    outputPath,
    expected: clipPreviewOutputExpectation(probe, window.durationSec),
    diagnose: (event) => log(event.accepted ? "info" : "error", "clip_preview_output_validation", {
      clipId: clip.id, projectId: clip.projectId, ...event,
    }),
  });

  const stored = await storeAndPublishClipPreview({
    workerProcess: params.workerProcess,
    signal: params.signal,
    clip,
    outputPath,
    hasAudio: probe.hasAudio,
    window,
    validatedDurationSec: validated.durationSec,
  });
  if (!stored.persisted) return false;
  const peaksKey = stored.peaksKey;

  log("info", "clip_preview_generated", {
    clipId: clip.id,
    projectId: clip.projectId,
    previewKind,
    previewStartSec: window.startSec,
    previewDurationSec: window.durationSec,
    peaksGenerated: peaksKey !== null,
  });
  return true;
}

/**
 * Polls for clips missing a preview proxy (highest `viralityScore` first)
 * and cuts one for each, in small batches grouped by project so a
 * multi-hundred-MB source is downloaded at most once per tick no matter how
 * many of that project's clips are due.
 *
 * A clip failing (bad source, ffmpeg error, lost claim race, ...) is logged
 * and skipped — it never fails the batch or aborts processing of the rest.
 *
 * Call signature: `processPendingClipPreviews(options?): Promise<number>`
 * — returns how many clips actually got a proxy persisted in this call.
 * Not wired into a poll loop here; apps/worker/src/index.ts owns that.
 */
export async function processPendingClipPreviews(
  options: { batchSize?: number; signal?: AbortSignal; workerProcess?: WorkerProcessModule } = {},
): Promise<number> {
  const batchSize = options.batchSize ?? previewBatchSize();
  const signal = options.signal ?? new AbortController().signal;
  const workerProcess = options.workerProcess ?? productionWorkerProcessModule;
  // Ask for a wider pool than we intend to cut, then drop the clips currently
  // inside a failure backoff window. Without the wider pool, N permanently
  // broken top-ranked clips would fill the batch every tick and nothing below
  // them would ever be attempted.
  const nowMs = Date.now();
  const pool = await getLayoutEvidenceLifecycle().listPendingPreviews(
    previewCandidatePoolSize(),
  );
  const eligible = pool.filter(
    (clip) => !previewFailureBackoff.shouldSkip(clip.id, nowMs),
  );
  const skipped = pool.length - eligible.length;
  if (skipped > 0) {
    log("info", "clip_preview_backoff_skipped", { skipped });
  }

  const candidates = eligible.slice(0, batchSize);
  if (candidates.length === 0) {
    return 0;
  }

  const byProject = new Map<string, ClipPendingPreview[]>();
  for (const clip of candidates) {
    const existing = byProject.get(clip.projectId);
    if (existing) {
      existing.push(clip);
    } else {
      byProject.set(clip.projectId, [clip]);
    }
  }

  let processed = 0;

  for (const [projectId, clips] of byProject) {
    signal.throwIfAborted();
    await workerProcess.withScratchDirectory("narriflow-clip-preview-", async (tempDir) => {
      const sourceStorageKey = clips[0]!.sourceStorageKey;

      // Stream the source over HTTP rather than downloading it. Sources here
      // are 531 MB - 1.1 GB; pulling one down to cut a ~30s window took over
      // five minutes and, because this task runs on the I/O poll loop, blocked
      // ingest and STT for the whole download. Handing ffmpeg a presigned URL
      // with `-ss` before `-i` makes it range-request only the bytes it needs:
      // measured 11.72s wall for a 38s cut off a 531 MB 4K source, producing
      // the same 1.4 MB output. Each clip in the batch re-uses this one URL.
      let sourcePath: string;
      try {
        sourcePath = await presignDownloadUrl({
          key: sourceStorageKey,
          expiresIn: SOURCE_STREAM_URL_TTL_SEC,
        });
      } catch (error) {
        signal.throwIfAborted();
        log("error", "clip_preview_source_presign_failed", {
          projectId,
          clipCount: clips.length,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        return;
      }

      for (const clip of clips) {
        signal.throwIfAborted();
        try {
          const didPersist = await cutAndUploadClipPreview({
            workerProcess,
            signal,
            clip,
            sourcePath,
            tempDir,
          });
          if (didPersist) processed += 1;
          // Losing the claim race isn't a failure of *this* clip, but the
          // proxy does now exist, so clearing any history is still correct.
          previewFailureBackoff.recordSuccess(clip.id);
        } catch (error) {
          signal.throwIfAborted();
          if (executorProcessFailure(error)) throw error;
          previewFailureBackoff.recordFailure(clip.id, Date.now());
          log("error", "clip_preview_failed", {
            clipId: clip.id,
            projectId,
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
    });
  }

  return processed;
}
