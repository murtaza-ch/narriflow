"use client";

import { editedToSource, type EditedTimeMap } from "@narriflow/validators";

type ThumbnailQuality = "coarse" | "refined";

/**
 * Which physical file a thumbnail request actually reads frames from — the
 * per-clip preview proxy or the full multi-hundred-MB/GB source. Two requests
 * can share the same `sourcePreviewId` (it identifies the underlying footage,
 * not the file serving it) while resolving to different `videoKind`s across
 * the lifetime of a session — e.g. thumbnails generated from the source
 * before the proxy finished processing. `cacheKeyFor` folds this in so a
 * strip captured from one is never handed back for the other.
 */
export type ThumbnailVideoKind = "proxy" | "source";

interface ThumbnailRequest {
  sourcePreviewId: string;
  sourceVideoUrl: string;
  videoKind: ThumbnailVideoKind;
  /** Seconds to subtract from an absolute source-time seek target to land on
   *  `sourceVideoUrl`'s own local timeline: `previewStartSec` when
   *  `videoKind` is "proxy" (the proxy's t=0 sits that far into the source),
   *  0 when reading the source directly. See `sourceTimeToVideoTime`. */
  offsetSec: number;
  clipStartSec: number;
  /** Fix 6 (Phase B hardening): the block's own EDITED-timeline span (what
   *  timeline.tsx actually draws it at), not the raw uncut source span. A
   *  segment can straddle a cut — its drawn width already only spans the
   *  KEPT portion — so sampling must walk this edited span through
   *  `editedTimeMap` (below), not interpolate linearly across the segment's
   *  full uncut source range the way this used to (which could sample and
   *  display deleted footage inside the strip). */
  editedStartSec: number;
  editedEndSec: number;
  /** The clip's current edited-time map — sampling below maps each
   *  in-between edited x-position back to its real (never-deleted) source
   *  second via `editedToSource`, mirroring how the ruler/waveform/playhead
   *  already do this. */
  editedTimeMap: EditedTimeMap;
  /** Short signature of the clip's current `deletedRanges` (e.g.
   *  `JSON.stringify`), folded into the cache key so a strip captured under
   *  one cut layout is never handed back after the cuts change — even in
   *  the (rare) case where two different cut layouts happen to produce the
   *  same `editedStartSec`/`editedEndSec` for this block. */
  cutsSignature: string;
  width: number;
  height: number;
  quality: ThumbnailQuality;
  onFrame: (strip: HTMLCanvasElement, isComplete: boolean) => void;
  onError: () => void;
}

interface ThumbnailJob extends ThumbnailRequest {
  id: number;
  cacheKey: string;
  cancelled: boolean;
}

interface VideoSlot {
  video: HTMLVideoElement;
  sourceVideoUrl: string;
  metadataReady: Promise<void>;
}

const MAX_CACHE_ITEMS = 80;
const MAX_COARSE_WIDTH = 720;
const MAX_REFINED_WIDTH = 1800;
// Cache keys quantise pixel width into buckets this wide so dragging the zoom
// slider (0.05/tick) doesn't invalidate every visible strip on every tick.
// Reusing a strip captured at a nearby width is visually safe because
// timeline.tsx's drawCachedStrip always rescales via drawImage's
// destination-rect form, regardless of the cached canvas's native size.
const THUMBNAIL_WIDTH_BUCKET_PX = 40;
// A missed `seeked`/`loadedmetadata` event used to wedge the queue forever —
// `activeJob` is only cleared in runJob's `.finally`, which never fires if
// the awaited promise never settles. Bound every wait so a stuck video always
// fails its own job and lets the rest of the queue drain.
const VIDEO_EVENT_TIMEOUT_MS = 8000;

const thumbnailCache = new Map<string, HTMLCanvasElement>();
const videoSlots = new Map<string, VideoSlot>();
const queue: ThumbnailJob[] = [];

let activeJob: ThumbnailJob | null = null;
let nextJobId = 1;
let playbackActive = false;

/** Quantises a pixel width into a fixed-size bucket for cache-key purposes only. */
export function bucketWidth(width: number): number {
  const bucketed = Math.round(width / THUMBNAIL_WIDTH_BUCKET_PX) * THUMBNAIL_WIDTH_BUCKET_PX;
  return Math.max(THUMBNAIL_WIDTH_BUCKET_PX, bucketed);
}

/**
 * Converts an absolute source-time seek target into the local `currentTime`
 * to set on whichever file is actually loaded. `offsetSec` is that file's
 * t=0 expressed in source time (0 for the source itself, `previewStartSec`
 * for the proxy) — mirroring how studio-shell.tsx derives
 * `playerClipStartSec`/`playerClipEndSec` for the main player. Clamped to 0
 * so a request landing just before the proxy's own start (padding/rounding
 * edge cases) never seeks negative.
 */
export function sourceTimeToVideoTime(sourceTimeSec: number, offsetSec: number): number {
  return Math.max(0, sourceTimeSec - offsetSec);
}

export function cacheKeyFor(
  request: Omit<
    ThumbnailRequest,
    "sourceVideoUrl" | "offsetSec" | "onFrame" | "onError" | "editedTimeMap"
  >,
) {
  return [
    request.sourcePreviewId,
    request.videoKind,
    request.clipStartSec.toFixed(3),
    request.editedStartSec.toFixed(3),
    request.editedEndSec.toFixed(3),
    // Fix 6: a cut layout can move where THIS strip samples from without
    // necessarily moving editedStartSec/editedEndSec by the same amount
    // (e.g. two different-shaped cuts inside the same block that happen to
    // leave the same total kept duration) — the signature is what actually
    // guarantees a stale strip gets invalidated when cuts change.
    request.cutsSignature,
    bucketWidth(request.width),
    Math.round(request.height),
    request.quality,
  ].join(":");
}

function rememberStrip(key: string, strip: HTMLCanvasElement) {
  thumbnailCache.set(key, strip);

  if (thumbnailCache.size <= MAX_CACHE_ITEMS) return;

  const oldestKey = thumbnailCache.keys().next().value as string | undefined;
  if (oldestKey) {
    thumbnailCache.delete(oldestKey);
  }
}

function waitForVideoEvent(video: HTMLVideoElement, eventName: "loadedmetadata" | "seeked") {
  return new Promise<void>((resolve, reject) => {
    let timeoutId: number;

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.removeEventListener(eventName, handleEvent);
      video.removeEventListener("error", handleError);
    };
    const handleEvent = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("timeline_thumbnail_video_error"));
    };

    timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error(`timeline_thumbnail_video_timeout:${eventName}`));
    }, VIDEO_EVENT_TIMEOUT_MS);

    video.addEventListener(eventName, handleEvent, { once: true });
    video.addEventListener("error", handleError, { once: true });
  });
}

function createVideoSlot(sourcePreviewId: string, sourceVideoUrl: string): VideoSlot {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.playsInline = true;
  video.src = sourceVideoUrl;

  const metadataReady =
    video.readyState >= 1
      ? Promise.resolve()
      : waitForVideoEvent(video, "loadedmetadata");

  const slot = { video, sourceVideoUrl, metadataReady };
  videoSlots.set(sourcePreviewId, slot);
  return slot;
}

function getVideoSlot(sourcePreviewId: string, sourceVideoUrl: string) {
  const existing = videoSlots.get(sourcePreviewId);
  if (existing?.sourceVideoUrl === sourceVideoUrl) {
    return existing;
  }

  if (existing) {
    existing.video.pause();
    existing.video.removeAttribute("src");
    existing.video.load();
    videoSlots.delete(sourcePreviewId);
  }

  return createVideoSlot(sourcePreviewId, sourceVideoUrl);
}

function sortedInsert(job: ThumbnailJob) {
  queue.push(job);
  queue.sort((left, right) => {
    const leftPriority = left.quality === "coarse" ? 0 : playbackActive ? 3 : 1;
    const rightPriority = right.quality === "coarse" ? 0 : playbackActive ? 3 : 1;
    return leftPriority - rightPriority || left.id - right.id;
  });
}

function scheduleNextJob() {
  if (activeJob) return;

  const next = queue.shift();
  if (!next) return;

  if (next.cancelled) {
    scheduleNextJob();
    return;
  }

  activeJob = next;
  void runJob(next).finally(() => {
    activeJob = null;
    scheduleNextJob();
  });
}

function waitForIdle(quality: ThumbnailQuality) {
  if (quality === "coarse") {
    return new Promise<void>((resolve) => {
      window.setTimeout(resolve, playbackActive ? 60 : 0);
    });
  }

  if ("requestIdleCallback" in window && !playbackActive) {
    return new Promise<void>((resolve) => {
      window.requestIdleCallback(() => resolve(), { timeout: 450 });
    });
  }

  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, playbackActive ? 180 : 40);
  });
}

async function seekVideo(video: HTMLVideoElement, time: number) {
  if (Math.abs(video.currentTime - time) < 0.015 && video.readyState >= 2) {
    return;
  }

  video.currentTime = time;
  await waitForVideoEvent(video, "seeked");
}

async function runJob(job: ThumbnailJob) {
  const cached = thumbnailCache.get(job.cacheKey);
  if (cached) {
    job.onFrame(cached, true);
    return;
  }

  await waitForIdle(job.quality);
  if (job.cancelled) return;

  const slot = getVideoSlot(job.sourcePreviewId, job.sourceVideoUrl);

  try {
    await slot.metadataReady;
    if (job.cancelled) return;

    const maxWidth = job.quality === "coarse" ? MAX_COARSE_WIDTH : MAX_REFINED_WIDTH;
    const renderWidth = Math.max(1, Math.min(maxWidth, Math.round(job.width)));
    const renderHeight = Math.max(1, Math.round(job.height));
    // Fix 6: EDITED-timeline duration of this block, not the raw uncut
    // source span — see `editedStartSec`/`editedEndSec`'s doc comment.
    const editedDuration = job.editedEndSec - job.editedStartSec;
    if (editedDuration <= 0) return;

    const frameCount =
      job.quality === "coarse"
        ? Math.max(1, Math.min(4, Math.ceil(renderWidth / 240)))
        : Math.max(1, Math.min(10, Math.ceil(renderWidth / 180)));
    const frameWidth = renderWidth / frameCount;
    const strip = document.createElement("canvas");
    strip.width = renderWidth;
    strip.height = renderHeight;

    const ctx = strip.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#171B21"; // studio.surface (canvas literal)
    ctx.fillRect(0, 0, renderWidth, renderHeight);

    for (let i = 0; i < frameCount; i++) {
      if (job.cancelled) return;
      await waitForIdle(job.quality);
      if (job.cancelled) return;

      const progress = frameCount === 1 ? 0.5 : i / frameCount;
      // Fix 6: walk the EDITED x-position through `editedTimeMap` to land
      // on the real (never-deleted) source second — a block that straddles
      // a cut used to interpolate linearly across its full uncut source
      // span here, which could seek into and display deleted footage even
      // though the block's drawn width already excluded it.
      const editedSeekTime = job.editedStartSec + editedDuration * progress;
      const sourceSeekTime = editedToSource(job.editedTimeMap, editedSeekTime);
      const seekTime = sourceTimeToVideoTime(sourceSeekTime, job.offsetSec);
      await seekVideo(slot.video, seekTime);
      if (job.cancelled) return;

      ctx.drawImage(
        slot.video,
        Math.round(i * frameWidth),
        0,
        Math.ceil(frameWidth),
        renderHeight,
      );

      job.onFrame(strip, i === frameCount - 1);
    }

    rememberStrip(job.cacheKey, strip);
  } catch {
    if (!job.cancelled) {
      job.onError();
    }
  }
}

export function setTimelineThumbnailPlaybackActive(isActive: boolean) {
  playbackActive = isActive;
}

export function getCachedTimelineThumbnail(
  request: Omit<
    ThumbnailRequest,
    "sourceVideoUrl" | "offsetSec" | "onFrame" | "onError" | "editedTimeMap"
  >,
) {
  return thumbnailCache.get(cacheKeyFor(request));
}

export function requestTimelineThumbnail(request: ThumbnailRequest) {
  const cacheKey = cacheKeyFor(request);
  const cached = thumbnailCache.get(cacheKey);

  if (cached) {
    request.onFrame(cached, true);
    return () => {};
  }

  const job: ThumbnailJob = {
    ...request,
    id: nextJobId++,
    cacheKey,
    cancelled: false,
  };

  sortedInsert(job);
  scheduleNextJob();

  return () => {
    job.cancelled = true;
  };
}

/**
 * Releases every module-global thumbnail resource: the in-memory canvas
 * cache (up to ~35MB of strips) and the hidden `<video>` elements used to
 * grab frames from them. Both live outside React's tree — keyed by
 * `sourcePreviewId` and shared across however many timeline instances have
 * mounted — so nothing frees them automatically. Call this once, when the
 * studio itself unmounts (not when the timeline panel is merely hidden).
 */
export function releaseTimelineThumbnailResources() {
  if (activeJob) activeJob.cancelled = true;
  for (const job of queue) job.cancelled = true;
  queue.length = 0;
  activeJob = null;

  for (const slot of videoSlots.values()) {
    slot.video.pause();
    slot.video.removeAttribute("src");
    slot.video.load();
  }
  videoSlots.clear();

  thumbnailCache.clear();
  playbackActive = false;
}
