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
import { invalidateProject } from "@narriflow/api-client/projects";
import { useProgressStream } from "@narriflow/api-client/progress";
import type { WorkflowStageUpdatedEvent } from "@narriflow/validators";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import {
  PROJECT_EVENT_ROW_LIMIT,
  rememberBoundedIdentity,
  workflowEventRowIdentity,
} from "@/lib/project-state";

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
 */
export function ProjectEventsProvider(props: {
  projectId: string;
  initialSeq: number;
  initialEvents: WorkflowStageUpdatedEvent[];
  children: ReactNode;
}) {
  // A different Project starts from its own history.
  return <ProjectEventsState key={props.projectId} {...props} />;
}

function ProjectEventsState({
  projectId,
  initialSeq,
  initialEvents,
  children,
}: {
  projectId: string;
  initialSeq: number;
  initialEvents: WorkflowStageUpdatedEvent[];
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
      setEvents((current) => sortAndCapEvents([...current, event]));
      setLatestByStage((current) => {
        const existing = current[event.stage];
        if (existing && existing.seq >= event.seq) return current;
        return { ...current, [event.stage]: event };
      });
    },
    [projectId],
  );

  // Access ended or the stream was refused: re-read the Project, whose own
  // answer (missing, restricted, mismatch) drives the existing recovery gates.
  const reread = useCallback(() => {
    if (scope) void invalidateProject(runtime.queryClient, scope, projectId);
  }, [runtime, scope, projectId]);

  useProgressStream(runtime, scope, projectId, {
    sinceSeq: initialSeq,
    onEvent,
    onRevoked: reread,
    onFatal: (error) => {
      if (error.code !== CLIENT_ERROR_CODES.scopeChanged) reread();
    },
  });

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
