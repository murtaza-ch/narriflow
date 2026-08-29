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
import { useRouter } from "next/navigation";
import type { WorkflowStageUpdatedEvent } from "@narriflow/validators";
import {
  PROJECT_EVENT_ROW_LIMIT,
  parseWorkflowEventMessage,
  rememberBoundedIdentity,
  workflowEventRowIdentity,
  workflowTerminalEventIdentity,
} from "@/lib/project-state";
import {
  parseWorkflowAuthorizationControl,
  recoverFromWorkflowAuthorizationLoss,
} from "@/lib/workflow-stream-authorization";

// Incremental (non-terminal) progress events — e.g. an individual clip's
// preview or render landing mid-run — should refresh the page so newly
// available clips/previews show up without waiting for the whole run to
// finish, but a burst of them (several clips completing back-to-back)
// shouldn't cause a refresh storm. This is a trailing-edge throttle: at most
// one refresh per window fires immediately, and one more is guaranteed
// shortly after the last event in a burst.
const PROGRESS_REFRESH_THROTTLE_MS = 5_000;

function sortAndCapEvents(
  events: readonly WorkflowStageUpdatedEvent[],
): WorkflowStageUpdatedEvent[] {
  return [...events]
    .sort((left, right) => left.seq - right.seq)
    .slice(-PROJECT_EVENT_ROW_LIMIT);
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
 * Owns the single EventSource connection for a project's workflow stream.
 * Lifted out of ProjectEvents (Activity tab) so the processing checklist
 * (Phase 2a) can consume live events directly without opening a second
 * connection or triggering extra refreshes — both this provider's consumers
 * share the same throttled router.refresh() below.
 */
export function ProjectEventsProvider({
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
  const router = useRouter();
  const [events, setEvents] = useState<WorkflowStageUpdatedEvent[]>(() =>
    sortAndCapEvents(initialEvents),
  );
  const [latestByStage, setLatestByStage] = useState<
    Record<string, WorkflowStageUpdatedEvent>
  >(() => {
    const map: Record<string, WorkflowStageUpdatedEvent> = {};
    for (const event of [...initialEvents].sort((a, b) => a.seq - b.seq)) {
      map[event.stage] = event;
    }
    return map;
  });
  const seenEventRows = useRef(new Set<string>());
  const refreshedTerminalEvents = useRef(new Set<string>());
  const lastIncrementalRefreshAtRef = useRef(0);
  const pendingIncrementalRefreshTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  const scheduleIncrementalRefresh = useCallback(() => {
    const now = Date.now();
    const elapsed = now - lastIncrementalRefreshAtRef.current;

    if (elapsed >= PROGRESS_REFRESH_THROTTLE_MS) {
      lastIncrementalRefreshAtRef.current = now;
      router.refresh();
      return;
    }

    // A trailing refresh is already scheduled for this burst — let it fire.
    if (pendingIncrementalRefreshTimerRef.current !== null) return;

    pendingIncrementalRefreshTimerRef.current = setTimeout(() => {
      pendingIncrementalRefreshTimerRef.current = null;
      lastIncrementalRefreshAtRef.current = Date.now();
      router.refresh();
    }, PROGRESS_REFRESH_THROTTLE_MS - elapsed);
  }, [router]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: projectId intentionally resets event state when the provider changes projects.
  useEffect(() => {
    setEvents(sortAndCapEvents(initialEvents));
    setLatestByStage(() => {
      const map: Record<string, WorkflowStageUpdatedEvent> = {};
      for (const event of [...initialEvents].sort((a, b) => a.seq - b.seq)) {
        map[event.stage] = event;
      }
      return map;
    });
    seenEventRows.current.clear();
    for (const event of initialEvents) {
      rememberBoundedIdentity(seenEventRows.current, workflowEventRowIdentity(event),
      );
    }
    refreshedTerminalEvents.current.clear();
    // Re-seeds whenever the server hands us a fresh history snapshot
    // (navigation to a different project, or any router.refresh()) — the SSE
    // effect below only ever delivers seq > initialSeq, so there's no
    // overlap with what's seeded here.
  }, [projectId, initialEvents]);

  useEffect(() => {
    const streamUrl = `/api/stream/${projectId}?sinceSeq=${initialSeq}`;
    const source = new EventSource(streamUrl);

    const onWorkflowUpdate = (event: MessageEvent<string>) => {
      const parsed = parseWorkflowEventMessage(event.data);
      if (!parsed) {
        console.error("workflow_event_invalid");
        return;
      }
      if (parsed.projectId !== projectId) {
        console.error("workflow_event_project_mismatch");
        return;
      }
      if (
        !rememberBoundedIdentity(
          seenEventRows.current,
          workflowEventRowIdentity(parsed),
        )
      ) {
        return;
      }

      setEvents((current) => {
        const updated = [...current, parsed];
        updated.sort((left, right) => left.seq - right.seq);
        return updated.slice(-PROJECT_EVENT_ROW_LIMIT);
      });
      setLatestByStage((current) => {
        const existing = current[parsed.stage];
        if (existing && existing.seq >= parsed.seq) return current;
        return { ...current, [parsed.stage]: parsed };
      });

      const isTerminal =
        parsed.status === "completed" ||
        parsed.status === "partial" ||
        parsed.status === "failed";
      if (isTerminal) {
        if (
          rememberBoundedIdentity(
            refreshedTerminalEvents.current,
            workflowTerminalEventIdentity(parsed),
          )
        ) {
          router.refresh();
        }
        return;
      }

      // Incremental progress (e.g. an individual clip's preview/render
      // landing) — throttled so a burst of these can't cause a refresh
      // storm, but still visible well before the run finishes.
      scheduleIncrementalRefresh();
    };

    const onAuthorizationRevoked = (event: MessageEvent<string>) => {
      const control = parseWorkflowAuthorizationControl(event.data);
      source.close();
      if (!control) {
        router.refresh();
        return;
      }
      recoverFromWorkflowAuthorizationLoss(
        control,
        `${window.location.pathname}${window.location.search}`,
      );
    };

    source.addEventListener("workflow.stage.updated", onWorkflowUpdate as EventListener,
    );
    source.addEventListener(
      "authorization.revoked",
      onAuthorizationRevoked as EventListener,
    );

    return () => {
      source.removeEventListener("workflow.stage.updated", onWorkflowUpdate as EventListener,
      );
      source.removeEventListener(
        "authorization.revoked",
        onAuthorizationRevoked as EventListener,
      );
      source.close();
      if (pendingIncrementalRefreshTimerRef.current !== null) {
        clearTimeout(pendingIncrementalRefreshTimerRef.current);
        pendingIncrementalRefreshTimerRef.current = null;
      }
    };
  }, [projectId, initialSeq, router, scheduleIncrementalRefresh]);

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
