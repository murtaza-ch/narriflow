"use client";

import { useSyncExternalStore } from "react";
import type { StudioEditingSession } from "./studio-editing-session";

type Listener = () => void;

/** Read-only compatibility projection for time-based presentation consumers.
 * Commands go through Studio session intents; this interface cannot mutate
 * playback or address an HTML media element. */
export interface PlaybackClock {
  getSnapshot: () => number;
  getServerSnapshot: () => number;
  subscribe: (listener: Listener) => () => void;
}

export function createSessionPlaybackClock(
  session: StudioEditingSession,
): PlaybackClock {
  const initialTime = session.getSnapshot().playback.editedTimeSec;
  return {
    getSnapshot: () => session.getSnapshot().playback.editedTimeSec,
    getServerSnapshot: () => initialTime,
    subscribe: (listener) => {
      let previous = session.getSnapshot().playback.editedTimeSec;
      return session.subscribe(() => {
        const next = session.getSnapshot().playback.editedTimeSec;
        if (next === previous) return;
        previous = next;
        listener();
      });
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
