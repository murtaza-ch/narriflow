"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { StatusBadge } from "@narriflow/ui/components/status-badge";

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
        if (current.some((entry) => entry.seq === parsed.seq)) return current;
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
    <Box borderRadius="12px" borderWidth="1px" borderColor="border" bg="bg.panel" p="20px">
      <Stack gap="12px">
        <Flex align="center" justify="space-between">
          <Text fontSize="14px" fontWeight="500" color="fg">Workflow Events</Text>
          {latest && (
            <Text fontSize="11px" fontFamily="mono" color="fg.subtle">
              seq {latest.seq}
            </Text>
          )}
        </Flex>

        {events.length === 0 ? (
          <Text fontSize="13px" color="fg.muted">Waiting for workflow updates.</Text>
        ) : (
          <Stack gap="0" position="relative">
            {/* Timeline line */}
            <Box
              position="absolute"
              left="7px"
              top="8px"
              bottom="8px"
              w="1px"
              bg="border"
            />

            {events.map((event) => (
              <Flex key={event.seq} gap="12px" align="start" py="6px" position="relative">
                {/* Timeline dot */}
                <Box
                  w="14px"
                  h="14px"
                  borderRadius="full"
                  bg="bg"
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  flexShrink={0}
                  mt="2px"
                  zIndex={1}
                >
                  <Box
                    w="6px"
                    h="6px"
                    borderRadius="full"
                    bg={
                      event.status === "completed"
                        ? "success.solid"
                        : event.status === "failed"
                          ? "danger.solid"
                          : event.status === "processing"
                            ? "accent.solid"
                            : "fg.subtle"
                    }
                  />
                </Box>

                <Box overflow="hidden">
                  <Flex align="center" gap="8px">
                    <Text fontSize="13px" fontWeight="500" color="fg">
                      {event.stage}
                    </Text>
                    <StatusBadge status={event.status as "processing" | "completed" | "failed" | "queued"} />
                    {event.progress > 0 && event.progress < 100 && (
                      <Text fontSize="11px" fontFamily="mono" color="fg.subtle">
                        {event.progress}%
                      </Text>
                    )}
                  </Flex>
                  <Text fontSize="11px" fontFamily="mono" color="fg.subtle" mt="2px">
                    {new Date(event.emittedAt).toLocaleTimeString()}
                  </Text>
                </Box>
              </Flex>
            ))}
          </Stack>
        )}
      </Stack>
    </Box>
  );
}
