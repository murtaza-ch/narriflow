"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { EditorDocument } from "@narriflow/validators";
import {
  createStudioEditingSession,
  getStudioEditingSessionMigrationAdapter,
  type StudioEditingSession,
  type StudioEditingSessionMigrationAdapter,
  type StudioSessionSeed,
  type StudioSessionDependencies,
  type StudioSessionSnapshot,
} from "./studio-editing-session";
import type { TimelineSegment } from "./studio-types";
import { createBrowserStudioSessionDependencies } from "./studio-editing-session-browser";
import { createBrowserStudioMediaAdapter } from "./studio-editing-session-media-browser";
import {
  createSessionPlaybackClock,
  type PlaybackClock,
} from "./playback-clock";

type LegacyReactSnapshot = Omit<
  StudioSessionSnapshot,
  "document" | "segments"
> & {
  /** Legacy presentation callers still accept mutable types. The session
   * freezes these values at runtime; later adapter contraction removes this
   * compatibility-only type widening. */
  document: EditorDocument;
  segments: readonly TimelineSegment[];
};

/**
 * Presentation-only React adapter. Session construction and subscription
 * live here so components consume snapshots without taking ownership of
 * document/history sequencing. The migration handle is temporary while
 * later tickets move recovery and cloud convergence behind the session.
 */
export interface StudioEditingSessionReactAdapter {
  session: StudioEditingSession;
  snapshot: LegacyReactSnapshot;
  migration: StudioEditingSessionMigrationAdapter;
  mediaRef(element: HTMLVideoElement | null): void;
  playbackClock: PlaybackClock;
  getCurrentDocument(): EditorDocument;
}

export interface StudioEditingSessionReactAdapters {
  preview?: StudioSessionDependencies["preview"];
}

function snapshotsEqualForPresentation(
  left: StudioSessionSnapshot,
  right: StudioSessionSnapshot,
): boolean {
  return (
    left.document === right.document &&
    left.segments === right.segments &&
    left.history.canUndo === right.history.canUndo &&
    left.history.canRedo === right.history.canRedo &&
    left.status === right.status &&
    left.recovery.kind === right.recovery.kind &&
    left.recovery.conflictPaths === right.recovery.conflictPaths &&
    left.durability.device === right.durability.device &&
    left.durability.protectsNavigation === right.durability.protectsNavigation &&
    left.ownership.kind === right.ownership.kind &&
    left.ownership.generation === right.ownership.generation &&
    left.cloud.state === right.cloud.state &&
    left.cloud.revision === right.cloud.revision &&
    left.cloud.dirty === right.cloud.dirty &&
    left.cloud.rejectionCode === right.cloud.rejectionCode &&
    left.preview.windowFingerprint === right.preview.windowFingerprint &&
    left.preview.proxy === right.preview.proxy &&
    left.preview.waveformPeaksUrl === right.preview.waveformPeaksUrl &&
    left.preview.automaticLayout === right.preview.automaticLayout &&
    left.preview.activeAsset.kind === right.preview.activeAsset.kind &&
    left.preview.activeAsset.url === right.preview.activeAsset.url &&
    left.preview.activeAsset.offsetSec === right.preview.activeAsset.offsetSec &&
    left.playback.durationSec === right.playback.durationSec &&
    left.playback.state === right.playback.state &&
    left.playback.rate === right.playback.rate &&
    left.capabilities.mutate === right.capabilities.mutate &&
    left.capabilities.play === right.capabilities.play &&
    left.capabilities.takeOver === right.capabilities.takeOver
  );
}

export function useStudioEditingSession(
  seed: StudioSessionSeed,
  adapters: StudioEditingSessionReactAdapters = {},
): StudioEditingSessionReactAdapter {
  const [{ session, media }] = useState(() => {
    const media = createBrowserStudioMediaAdapter();
    const session = createStudioEditingSession(
      seed,
      seed.projectId && seed.clipId
        ? {
            ...createBrowserStudioSessionDependencies({
              projectId: seed.projectId,
              clipId: seed.clipId,
            }, adapters.preview),
            media,
          }
        : undefined,
      { deferStart: Boolean(seed.projectId && seed.clipId) },
    );
    return { session, media };
  });
  const closeTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    void session.perform({ type: "start" });
    return () => {
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null;
        void session.perform({ type: "close", reason: "unmount" });
      }, 0);
    };
  }, [session]);
  useEffect(() => {
    const onPageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) {
        void session.perform({ type: "close", reason: "pagehide" });
      }
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        void session.perform({ type: "resume" });
      }
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [session]);
  const getPresentationSnapshot = useMemo(() => {
    let selected = session.getSnapshot();
    return () => {
      const next = session.getSnapshot();
      if (!snapshotsEqualForPresentation(selected, next)) selected = next;
      return selected;
    };
  }, [session]);
  const snapshot = useSyncExternalStore(
    session.subscribe,
    getPresentationSnapshot,
    getPresentationSnapshot,
  );
  const migration = useMemo(
    () => getStudioEditingSessionMigrationAdapter(session),
    [session],
  );
  const playbackClock = useMemo(
    () => createSessionPlaybackClock(session),
    [session],
  );
  const mediaRef = useCallback(
    (element: HTMLVideoElement | null) => media.attach(element),
    [media],
  );
  const getCurrentDocument = useCallback(
    () => session.getSnapshot().document as EditorDocument,
    [session],
  );

  return {
    session,
    snapshot: snapshot as LegacyReactSnapshot,
    migration,
    mediaRef,
    playbackClock,
    getCurrentDocument,
  };
}
