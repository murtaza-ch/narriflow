"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import type { EditorDocument } from "@narriflow/validators";
import {
  createStudioEditingSession,
  getStudioEditingSessionMigrationAdapter,
  type StudioEditingSession,
  type StudioEditingSessionMigrationAdapter,
  type StudioSessionSeed,
  type StudioSessionSnapshot,
} from "./studio-editing-session";
import type { TimelineSegment } from "./studio-types";

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

export function useStudioEditingSession(
  seed: StudioSessionSeed,
): StudioEditingSessionReactAdapter {
  const [session] = useState(() => createStudioEditingSession(seed));
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
