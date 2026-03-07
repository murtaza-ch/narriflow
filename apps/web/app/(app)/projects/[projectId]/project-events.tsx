"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Box, Heading, Stack, Text } from "@chakra-ui/react";

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
    <Box as="section" borderWidth="1px" borderColor="border" rounded="xl" p="4">
      <Stack gap="3">
        <Heading size="sm" fontWeight="semibold">Workflow Events</Heading>
        {latest ? (
          <Text textStyle="xs" color="fg.muted">
            Last update: seq {latest.seq} - {latest.stage} ({latest.status})
          </Text>
        ) : (
          <Text textStyle="xs" color="fg.muted">Waiting for workflow updates.</Text>
        )}
        <Stack as="ul" gap="2" listStyleType="none">
          {events.map((event) => (
            <Box as="li" key={event.seq} borderWidth="1px" borderColor="border" rounded="md" p="3" textStyle="xs">
              <Box>seq {event.seq}</Box>
              <Box>
                {event.stage} - {event.status} - {event.progress}%
              </Box>
              <Text color="fg.muted">{event.emittedAt}</Text>
            </Box>
          ))}
        </Stack>
      </Stack>
    </Box>
  );
}
