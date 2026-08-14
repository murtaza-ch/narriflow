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
  getCurrentDocument(): EditorDocument;
}

export interface StudioEditingSessionReactAdapters {
  preview?: StudioSessionDependencies["preview"];
}

export function useStudioEditingSession(
  seed: StudioSessionSeed,
  adapters: StudioEditingSessionReactAdapters = {},
): StudioEditingSessionReactAdapter {
  const [session] = useState(() =>
    createStudioEditingSession(
      seed,
      seed.projectId && seed.clipId
          ? createBrowserStudioSessionDependencies({
              projectId: seed.projectId,
              clipId: seed.clipId,
            }, adapters.preview)
        : undefined,
      { deferStart: Boolean(seed.projectId && seed.clipId) },
    ),
  );
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
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const migration = useMemo(
    () => getStudioEditingSessionMigrationAdapter(session),
    [session],
  );
  const getCurrentDocument = useCallback(
    () => session.getSnapshot().document as EditorDocument,
    [session],
  );

  return {
    session,
    snapshot: snapshot as LegacyReactSnapshot,
    migration,
    getCurrentDocument,
  };
}
