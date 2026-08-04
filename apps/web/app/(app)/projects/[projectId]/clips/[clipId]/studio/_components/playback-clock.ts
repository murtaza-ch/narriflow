"use client";

import { useSyncExternalStore } from "react";
import type { EditedTimeMap } from "@narriflow/validators";
import { stepRipple } from "./ripple-playback";

type Listener = () => void;

interface PlaybackRunOptions {
  video: HTMLVideoElement | null;
  /** Vizard-parity Phase B step 8: the edited-time map for this clip. The
   *  video element always decodes SOURCE time continuously — it has no
   *  concept of `deletedRanges` — so every playback tick is routed through
   *  `stepRipple` (ripple-playback.ts) to detect drift into a cut and force
   *  the video forward. Pass the identity map (no deletions) to get
   *  byte-for-byte the same behavior this clock always had. */
  editedTimeMap: EditedTimeMap;
  /** File-local (whatever `video.src` currently is — proxy or full source)
   *  -> absolute SOURCE seconds offset: sourceTimeSec = mediaTime +
   *  sourceOffsetSec. Studio-shell's `activeOffsetSec`. */
  sourceOffsetSec: number;
  onEnded: () => void;
}

type VideoFrameCallbackMetadata = {
  mediaTime: number;
};

type VideoFrameRequestCallback = (
  now: DOMHighResTimeStamp,
  metadata: VideoFrameCallbackMetadata,
) => void;

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export interface PlaybackClock {
  getSnapshot: () => number;
  getServerSnapshot: () => number;
  subscribe: (listener: Listener) => () => void;
  setTime: (time: number) => void;
  startVideo: (options: PlaybackRunOptions) => () => void;
  startSynthetic: (duration: number, onEnded: () => void) => () => void;
}

function clampTime(time: number, duration: number) {
  return Math.max(0, Math.min(duration, time));
}

export function createPlaybackClock(initialTime = 0): PlaybackClock {
  let currentTime = initialTime;
  const listeners = new Set<Listener>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setTime = (time: number) => {
    const next = Number.isFinite(time) ? Math.max(0, time) : 0;
    if (Math.abs(next - currentTime) < 0.001) return;
    currentTime = next;
    notify();
  };

  return {
    getSnapshot: () => currentTime,
    getServerSnapshot: () => initialTime,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setTime,
    startVideo: ({ video, editedTimeMap, sourceOffsetSec, onEnded }) => {
      if (!video) return () => {};

      let cancelled = false;
      let rafId = 0;
      let frameCallbackId = 0;
      const videoWithFrameCallback = video as VideoWithFrameCallback;

      const updateFromMediaTime = (mediaTime: number) => {
        const sourceTimeSec = mediaTime + sourceOffsetSec;
        const step = stepRipple(editedTimeMap, sourceTimeSec);

        if (step.atEnd) {
          setTime(editedTimeMap.editedDurationSec);
          onEnded();
          return false;
        }

        if (step.skipToSourceSec !== undefined) {
          // Force the video forward past the cut — it has no concept of
          // `deletedRanges` and would otherwise keep decoding/showing the
          // deleted footage. The clock's own edited time (set below) is
          // already continuous across this jump; only the video element
          // needs correcting.
          video.currentTime = step.skipToSourceSec - sourceOffsetSec;
        }

        setTime(step.editedTime);
        return true;
      };

      if (videoWithFrameCallback.requestVideoFrameCallback) {
        const onVideoFrame: VideoFrameRequestCallback = (_now, metadata) => {
          if (cancelled) return;
          if (!updateFromMediaTime(metadata.mediaTime)) return;
          frameCallbackId = videoWithFrameCallback.requestVideoFrameCallback!(onVideoFrame);
        };

        frameCallbackId = videoWithFrameCallback.requestVideoFrameCallback(onVideoFrame);

        return () => {
          cancelled = true;
          if (frameCallbackId && videoWithFrameCallback.cancelVideoFrameCallback) {
            videoWithFrameCallback.cancelVideoFrameCallback(frameCallbackId);
          }
        };
      }

      const tick = () => {
        if (cancelled) return;
        if (!updateFromMediaTime(video.currentTime)) return;
        rafId = window.requestAnimationFrame(tick);
      };

      rafId = window.requestAnimationFrame(tick);

      return () => {
        cancelled = true;
        if (rafId) window.cancelAnimationFrame(rafId);
      };
    },
    startSynthetic: (duration, onEnded) => {
      let cancelled = false;
      let rafId = 0;
      let lastNow = performance.now();

      const tick = (now: number) => {
        if (cancelled) return;

        const deltaSec = Math.max(0, (now - lastNow) / 1000);
        lastNow = now;
        const next = clampTime(currentTime + deltaSec, duration);
        setTime(next);

        if (next >= duration) {
          onEnded();
          return;
        }

        rafId = window.requestAnimationFrame(tick);
      };

      rafId = window.requestAnimationFrame(tick);

      return () => {
        cancelled = true;
        if (rafId) window.cancelAnimationFrame(rafId);
      };
    },
  };
}

export function usePlaybackTime(clock: PlaybackClock) {
  return useSyncExternalStore(
    clock.subscribe,
    clock.getSnapshot,
    clock.getServerSnapshot,
  );
}
