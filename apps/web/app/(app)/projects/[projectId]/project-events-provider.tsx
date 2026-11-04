"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CLIENT_ERROR_CODES } from "@narriflow/api-client/core";
import { clearProjectAccess, invalidateProject } from "@narriflow/api-client/projects";
import {
  invalidateAfterProgress,
  invalidateAfterTerminalProgress,
  useProgressStream,
} from "@narriflow/api-client/progress";
import type { WorkflowStageUpdatedEvent } from "@narriflow/validators";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import { useDocumentVisible } from "@/lib/use-document-visible";
import {
  PROJECT_EVENT_ROW_LIMIT,
  rememberBoundedIdentity,
  workflowEventRowIdentity,
} from "@/lib/project-state";

/** How often a page with work in progress re-reads the Project while it has no stream. */
const REFRESH_WITHOUT_STREAM_MS = 8_000;

/**
 * Firewalls, proxies and browser extensions can block WebSockets, so progress
 * cannot depend on one. An open stream makes this unnecessary, and an idle page
 * or a hidden tab has nothing to keep current.
 */
export function shouldRefreshWithoutStream(state: {
  working: boolean;
  visible: boolean;
  streamOpen: boolean;
}): boolean {
  return state.working && state.visible && !state.streamOpen;
}

function sortAndCapEvents(
  events: readonly WorkflowStageUpdatedEvent[],
): WorkflowStageUpdatedEvent[] {
  return [...events]
    .sort((left, right) => left.seq - right.seq)
    .slice(-PROJECT_EVENT_ROW_LIMIT);
}

function latestStageMap(
  events: readonly WorkflowStageUpdatedEvent[],
  base: Record<string, WorkflowStageUpdatedEvent> = {},
): Record<string, WorkflowStageUpdatedEvent> {
  const map = { ...base };
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const existing = map[event.stage];
    if (!existing || existing.seq < event.seq) map[event.stage] = event;
  }
  return map;
}

interface ProjectEventsContextValue {
  /** Bounded, ascending-by-seq event history — same list ProjectEvents
   *  (Activity tab) rendered before this was extracted into a provider. */
  events: WorkflowStageUpdatedEvent[];
  /** Most recent event per workflow stage, for consumers (e.g. the
   *  processing checklist) that only care about "where is this stage right
   *  now" rather than the full timeline. Not capped by
   *  PROJECT_EVENT_ROW_LIMIT — a stage's latest event can fall off the
   *  bounded `events` list during a long-running burst on other stages,
   *  but this map must still reflect it. */
  latestByStage: Record<string, WorkflowStageUpdatedEvent>;
}

const ProjectEventsContext = createContext<ProjectEventsContextValue | null>(
  null,
);

/**
 * Feeds the Project page's live workflow state. The connection belongs to the
 * shared progress stream (one per Project, also used by the upload and export
 * pages), which also refreshes the Project's cached reads on its 5-second
 * trailing throttle and once per terminal outcome. This provider only holds
 * the bounded event history and the latest event per stage for its consumers.
 *
 * The socket is open whenever the tab is visible, so work started from another
 * tab, device or integration shows up on a page that was idle. A hidden tab
 * keeps none. Coming back to the tab refetches the Project, and the stream
 * resumes from the newest event this page holds. While work is in progress and
 * the stream is down, the page re-reads the Project on a timer instead.
 */
export function ProjectEventsProvider(props: {
  projectId: string;
  initialSeq: number;
  initialEvents: WorkflowStageUpdatedEvent[];
  /** The Project has work in progress, so the page must keep updating. */
  working: boolean;
  children: ReactNode;
}) {
  // A different Project starts from its own history.
  return <ProjectEventsState key={props.projectId} {...props} />;
}

function ProjectEventsState({
  projectId,
  initialSeq,
  initialEvents,
  working,
  children,
}: {
  projectId: string;
  initialSeq: number;
  initialEvents: WorkflowStageUpdatedEvent[];
  working: boolean;
  children: ReactNode;
}) {
  const runtime = useApiRuntime();
  const scope = useWorkspaceScope();
  const [events, setEvents] = useState<WorkflowStageUpdatedEvent[]>(() =>
    sortAndCapEvents(initialEvents),
  );
  const [latestByStage, setLatestByStage] = useState<
    Record<string, WorkflowStageUpdatedEvent>
  >(() => latestStageMap(initialEvents));
  const visible = useDocumentVisible();
  const [streamOpen, setStreamOpen] = useState(false);
  // The newest event this page holds, so a resumed stream replays only what it missed.
  const cursor = useRef(initialSeq);
  const seenEventRows = useRef<Set<string> | null>(null);
  if (seenEventRows.current === null) {
    seenEventRows.current = new Set();
    for (const event of initialEvents) {
      rememberBoundedIdentity(seenEventRows.current, workflowEventRowIdentity(event));
    }
  }

  // A refetched Project brings its history up to date; merge it rather than
  // replace, so a live event the refetch has not caught up with is not lost.
  useEffect(() => {
    const seen = seenEventRows.current;
    if (!seen) return;
    const fresh = initialEvents.filter((event) =>
      rememberBoundedIdentity(seen, workflowEventRowIdentity(event)),
    );
    if (fresh.length === 0) return;
    setEvents((current) => sortAndCapEvents([...current, ...fresh]));
    setLatestByStage((current) => latestStageMap(fresh, current));
  }, [initialEvents]);

  const onEvent = useCallback(
    (event: WorkflowStageUpdatedEvent) => {
      if (event.projectId !== projectId) return;
      const seen = seenEventRows.current;
      if (!seen || !rememberBoundedIdentity(seen, workflowEventRowIdentity(event))) return;
      cursor.current = Math.max(cursor.current, event.seq);
      setEvents((current) => sortAndCapEvents([...current, event]));
      setLatestByStage((current) => {
        const existing = current[event.stage];
        if (existing && existing.seq >= event.seq) return current;
        return { ...current, [event.stage]: event };
      });
    },
    [projectId],
  );

  // Access ended or the stream was refused: clear what the Project showed and
  // re-read it, so the server's own answer (missing, restricted, mismatch)
  // drives the existing recovery gates instead of the cached page.
  const reread = useCallback(() => {
    if (scope) void clearProjectAccess(runtime.queryClient, scope, projectId);
  }, [runtime, scope, projectId]);

  useProgressStream(runtime, scope, projectId, {
    enabled: visible,
    sinceSeq: Math.max(initialSeq, cursor.current),
    onEvent,
    onStatus: (status) => setStreamOpen(status.state === "open"),
    onRevoked: reread,
    onFatal: (error) => {
      if (error.code !== CLIENT_ERROR_CODES.scopeChanged) reread();
    },
  });

  // Work may have started or finished while the tab was hidden and the socket closed.
  const wasVisible = useRef(visible);
  useEffect(() => {
    const returned = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (returned && scope) void invalidateProject(runtime.queryClient, scope, projectId);
  }, [visible, runtime, scope, projectId]);

  useEffect(() => {
    if (!scope || !shouldRefreshWithoutStream({ working, visible, streamOpen })) return;
    const timer = setInterval(() => {
      void invalidateProject(runtime.queryClient, scope, projectId);
      void invalidateAfterProgress(runtime.queryClient, scope, projectId);
    }, REFRESH_WITHOUT_STREAM_MS);
    return () => clearInterval(timer);
  }, [working, visible, streamOpen, runtime, scope, projectId]);

  // No stream means no terminal event, so finished work brings in its own results.
  const wasWorking = useRef(working);
  useEffect(() => {
    const finished = wasWorking.current && !working;
    wasWorking.current = working;
    if (finished && !streamOpen && scope) void invalidateAfterTerminalProgress(runtime.queryClient, scope, projectId);
  }, [working, streamOpen, runtime, scope, projectId]);

  const value = useMemo<ProjectEventsContextValue>(
    () => ({ events, latestByStage }),
    [events, latestByStage],
  );

  return (
    <ProjectEventsContext.Provider value={value}>
      {children}
    </ProjectEventsContext.Provider>
  );
}

/** Read the shared live workflow event stream. Must be used within a
 *  ProjectEventsProvider (mounted once per project page). */
export function useProjectEvents(): ProjectEventsContextValue {
  const context = useContext(ProjectEventsContext);
  if (!context) {
    throw new Error("useProjectEvents must be used within ProjectEventsProvider",
    );
  }
  return context;
}
