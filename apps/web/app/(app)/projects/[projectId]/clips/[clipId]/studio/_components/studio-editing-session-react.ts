"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { EditorDocument } from "@narriflow/validators";
import {
  createStudioEditingSession,
  studioPreviewSnapshotsEqual,
  type StudioEditingSession,
  type StudioSessionSeed,
  type StudioSessionDependencies,
  type StudioSessionSnapshot,
} from "./studio-editing-session";
import { createBrowserStudioSessionDependencies } from "./studio-editing-session-browser";
import { createBrowserStudioMediaAdapter } from "./studio-editing-session-media-browser";
import {
  createSessionPlaybackClock,
  type PlaybackClock,
} from "./playback-clock";
import { createBrowserStudioSessionLifecycle } from "./studio-editing-session-lifecycle-browser";

export interface StudioSessionSelectorStore<Selection> {
  getSnapshot(): Selection;
  subscribe(listener: () => void): () => void;
}

export type StudioSessionSelector<Selection> = (
  snapshot: StudioSessionSnapshot,
) => Selection;

/** Presentation-only type widening. The session still freezes this value at
 * runtime; existing panel props accept the mutable EditorDocument type. */
export const selectStudioDocument = (snapshot: StudioSessionSnapshot) =>
  snapshot.document as EditorDocument;
export const selectStudioSegments = (snapshot: StudioSessionSnapshot) =>
  snapshot.segments;
export const selectStudioCanUndo = (snapshot: StudioSessionSnapshot) =>
  snapshot.history.canUndo;
export const selectStudioCanRedo = (snapshot: StudioSessionSnapshot) =>
  snapshot.history.canRedo;
export const selectStudioStatus = (snapshot: StudioSessionSnapshot) =>
  snapshot.status;
export const selectStudioRecovery = (snapshot: StudioSessionSnapshot) =>
  snapshot.recovery;
export const selectStudioDurability = (snapshot: StudioSessionSnapshot) =>
  snapshot.durability;
export const selectStudioOwnership = (snapshot: StudioSessionSnapshot) =>
  snapshot.ownership;
export const selectStudioCloud = (snapshot: StudioSessionSnapshot) =>
  snapshot.cloud;
export const selectStudioPreview = (snapshot: StudioSessionSnapshot) =>
  snapshot.preview;

export const studioPreviewPresentationEqual = studioPreviewSnapshotsEqual;

export interface StudioPlaybackPresentation {
  durationSec: number;
  state: StudioSessionSnapshot["playback"]["state"];
  rate: number;
}

export const selectStudioPlaybackPresentation = (
  snapshot: StudioSessionSnapshot,
): StudioPlaybackPresentation => ({
  durationSec: snapshot.playback.durationSec,
  state: snapshot.playback.state,
  rate: snapshot.playback.rate,
});

export function studioPlaybackPresentationEqual(
  left: StudioPlaybackPresentation,
  right: StudioPlaybackPresentation,
): boolean {
  return (
    left.durationSec === right.durationSec &&
    left.state === right.state &&
    left.rate === right.rate
  );
}

export function createStudioSessionSelectorStore<Selection>(
  session: StudioEditingSession,
  selector: StudioSessionSelector<Selection>,
  isEqual: (left: Selection, right: Selection) => boolean = Object.is,
): StudioSessionSelectorStore<Selection> {
  let selected = selector(session.getSnapshot());
  let unsubscribeSession: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const refresh = () => {
    const next = selector(session.getSnapshot());
    if (isEqual(selected, next)) return false;
    selected = next;
    return true;
  };

  return {
    getSnapshot: () => {
      if (listeners.size === 0) refresh();
      return selected;
    },
    subscribe: (listener) => {
      if (listeners.size === 0) refresh();
      listeners.add(listener);
      if (!unsubscribeSession) {
        unsubscribeSession = session.subscribe(() => {
          if (!refresh()) return;
          for (const selectedListener of listeners) selectedListener();
        });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        unsubscribeSession?.();
        unsubscribeSession = null;
      };
    },
  };
}

export function useStudioSessionSelector<Selection>(
  session: StudioEditingSession,
  selector: StudioSessionSelector<Selection>,
  isEqual?: (left: Selection, right: Selection) => boolean,
): Selection {
  const store = useMemo(
    () => createStudioSessionSelectorStore(session, selector, isEqual),
    [isEqual, selector, session],
  );
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}

/**
 * Presentation-only React adapter. It constructs the clip-scoped session,
 * translates React/browser lifecycle events into public session operations,
 * and attaches the browser media adapter. Snapshot selection stays explicit
 * at each rendering call site through `useStudioSessionSelector`.
 */
export interface StudioEditingSessionReactAdapter {
  session: StudioEditingSession;
  mediaRef(element: HTMLVideoElement | null): void;
  playbackClock: PlaybackClock;
  suppressNavigationWarning(): void;
}

export interface StudioEditingSessionReactAdapters {
  preview?: StudioSessionDependencies["preview"];
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
  const lifecycle = useMemo(
    () =>
      typeof window === "undefined"
        ? null
        : createBrowserStudioSessionLifecycle(session),
    [session],
  );
  useEffect(() => {
    if (!lifecycle) return;
    lifecycle.mount();
    return lifecycle.unmount;
  }, [lifecycle]);
  const playbackClock = useMemo(
    () => createSessionPlaybackClock(session),
    [session],
  );
  const mediaRef = useCallback(
    (element: HTMLVideoElement | null) => media.attach(element),
    [media],
  );
  const suppressNavigationWarning = useCallback(
    () => lifecycle?.suppressNavigationWarning(),
    [lifecycle],
  );

  return {
    session,
    mediaRef,
    playbackClock,
    suppressNavigationWarning,
  };
}
