"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type WorkflowStageUpdatedEvent = {
  event: "workflow.stage.updated";
  projectId: string;
  workflowRunId: string;
  seq: number;
  stage: string;
  status: string;
  progress: number;
  errorCode: string | null;
  emittedAt: string;
};

export function ProjectEvents({ projectId, initialSeq }: { projectId: string; initialSeq: number }) {
  const router = useRouter();
  const [lastSeq, setLastSeq] = useState(initialSeq);
  const [events, setEvents] = useState<WorkflowStageUpdatedEvent[]>([]);
  const refreshedStages = useRef(new Set<string>());

  useEffect(() => {
    let currentSeq = initialSeq;
    const streamUrl = `/api/stream/${projectId}?sinceSeq=${currentSeq}`;
    const source = new EventSource(streamUrl);

    const onWorkflowUpdate = (event: MessageEvent<string>) => {
      const parsed = JSON.parse(event.data) as WorkflowStageUpdatedEvent;
      setEvents((current) => {
        if (current.some((entry) => entry.seq === parsed.seq)) {
          return current;
        }

        const updated = [...current, parsed];
        updated.sort((left, right) => left.seq - right.seq);
        return updated.slice(-20);
      });
      currentSeq = Math.max(currentSeq, parsed.seq);
      setLastSeq(currentSeq);

      const isTerminal = parsed.status === "completed" || parsed.status === "failed";
      if (isTerminal && !refreshedStages.current.has(parsed.stage)) {
        refreshedStages.current.add(parsed.stage);
        router.refresh();
      }
    };

    source.addEventListener("workflow.stage.updated", onWorkflowUpdate as EventListener);

    return () => {
      source.removeEventListener("workflow.stage.updated", onWorkflowUpdate as EventListener);
      source.close();
    };
  }, [projectId, initialSeq, router]);

  const latest = useMemo(() => events.at(-1) ?? null, [events]);

  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      <h2 className="text-sm font-semibold">Workflow Events</h2>
      {latest ? (
        <p className="text-xs text-muted-foreground">
          Last update: seq {latest.seq} - {latest.stage} ({latest.status})
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Waiting for workflow updates.</p>
      )}
      <ul className="space-y-2">
        {events.map((event) => (
          <li key={event.seq} className="rounded-md border border-border p-3 text-xs">
            <div>seq {event.seq}</div>
            <div>
              {event.stage} - {event.status} - {event.progress}%
            </div>
            <div className="text-muted-foreground">{event.emittedAt}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
