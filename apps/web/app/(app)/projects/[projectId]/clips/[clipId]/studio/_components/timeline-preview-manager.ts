"use client";

type ThumbnailQuality = "coarse" | "refined";

interface ThumbnailRequest {
  sourcePreviewId: string;
  sourceVideoUrl: string;
  clipStartSec: number;
  segStartSec: number;
  segEndSec: number;
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
const thumbnailCache = new Map<string, HTMLCanvasElement>();
const videoSlots = new Map<string, VideoSlot>();
const queue: ThumbnailJob[] = [];

let activeJob: ThumbnailJob | null = null;
let nextJobId = 1;
let playbackActive = false;

function cacheKeyFor(request: Omit<ThumbnailRequest, "sourceVideoUrl" | "onFrame" | "onError">) {
  return [
    request.sourcePreviewId,
    request.clipStartSec.toFixed(3),
    request.segStartSec.toFixed(3),
    request.segEndSec.toFixed(3),
    Math.round(request.width),
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
    const cleanup = () => {
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
    const duration = job.segEndSec - job.segStartSec;
    if (duration <= 0) return;

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

    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, renderWidth, renderHeight);

    for (let i = 0; i < frameCount; i++) {
      if (job.cancelled) return;
      await waitForIdle(job.quality);
      if (job.cancelled) return;

      const progress = frameCount === 1 ? 0.5 : i / frameCount;
      const seekTime = job.clipStartSec + job.segStartSec + duration * progress;
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
  request: Omit<ThumbnailRequest, "sourceVideoUrl" | "onFrame" | "onError">,
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
