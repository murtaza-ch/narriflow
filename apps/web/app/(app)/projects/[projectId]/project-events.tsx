"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { StatusBadge } from "@narriflow/ui/components/status-badge";
import { userErrorMessage, type WorkflowStageUpdatedEvent } from "@narriflow/validators";
import { AlertTriangle } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import {
  PROJECT_EVENT_ROW_LIMIT,
  parseWorkflowEventMessage,
  rememberBoundedIdentity,
  workflowEventRowIdentity,
  workflowTerminalEventIdentity,
} from "@/lib/project-state";

function stripeFor(status: string): string {
  if (status === "completed") return "success.solid";
  if (status === "failed") return "danger.solid";
  if (status === "processing" || status === "running") return "accent.solid";
  return "border.emphasized";
}

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

export function ProjectEvents({
  projectId,
  initialSeq,
  initialEvents,
}: {
  projectId: string;
  initialSeq: number;
  /** Persisted WorkflowEvent history (seq <= initialSeq) fetched server-side
   *  so the tab shows the full timeline on first paint instead of only
   *  events that happen to arrive live after the page loads. */
  initialEvents: WorkflowStageUpdatedEvent[];
}) {
  const router = useRouter();
  const [events, setEvents] = useState<WorkflowStageUpdatedEvent[]>(() =>
    sortAndCapEvents(initialEvents),
  );
  const seenEventRows = useRef(new Set<string>());
  const refreshedTerminalEvents = useRef(new Set<string>());
  const lastIncrementalRefreshAtRef = useRef(0);
  const pendingIncrementalRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

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

  useEffect(() => {
    setEvents(sortAndCapEvents(initialEvents));
    seenEventRows.current.clear();
    for (const event of initialEvents) {
      rememberBoundedIdentity(seenEventRows.current, workflowEventRowIdentity(event));
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

      const isTerminal = parsed.status === "completed" || parsed.status === "failed";
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

    source.addEventListener("workflow.stage.updated", onWorkflowUpdate as EventListener);

    return () => {
      source.removeEventListener("workflow.stage.updated", onWorkflowUpdate as EventListener);
      source.close();
      if (pendingIncrementalRefreshTimerRef.current !== null) {
        clearTimeout(pendingIncrementalRefreshTimerRef.current);
        pendingIncrementalRefreshTimerRef.current = null;
      }
    };
  }, [projectId, initialSeq, router, scheduleIncrementalRefresh]);

  const latest = useMemo(() => events.at(-1) ?? null, [events]);

  return (
    <Box layerStyle="band">
      <Stack gap="4">
        <Flex align="center" justify="space-between" gap="3">
          <Box>
            <Text textStyle="eyebrow" color="fg.subtle">
              Activity
            </Text>
            <Text mt="0.5" fontSize="xs" color="fg.muted">
              Full workflow history for this project, updating live.
            </Text>
          </Box>
          {latest && (
            <Text textStyle="data" fontSize="11px" color="fg.subtle">
              seq {latest.seq}
            </Text>
          )}
        </Flex>

        {events.length === 0 ? (
          <Flex align="center" gap="2" py="2">
            {/* Static accent dot — an open channel, not a blinking light */}
            <Box w="6px" h="6px" borderRadius="2px" bg="accent.solid" />
            <Text fontSize="sm" color="fg.muted">
              Waiting for workflow updates.
            </Text>
          </Flex>
        ) : (
          <Stack gap="0" borderTopWidth="1px" borderColor="border.subtle">
            {events.map((event) => (
              <Flex
                key={event.seq}
                position="relative"
                align="flex-start"
                justify="space-between"
                gap="3"
                ps="3.5"
                pe="1"
                py="2.5"
                borderBottomWidth="1px"
                borderColor="border.subtle"
                transition="background 120ms ease"
                _hover={{ bg: "bg.subtle" }}
              >
                {/* 3px status stripe */}
                <Box
                  position="absolute"
                  insetInlineStart="0"
                  top="0"
                  bottom="0"
                  w="3px"
                  bg={stripeFor(event.status)}
                />
                <Stack gap="1" minW="0" flex="1">
                  <Flex align="center" gap="2.5" minW="0" wrap="wrap">
                    <Text textStyle="data" fontSize="13px" color="fg" truncate>
                      {event.stage}
                    </Text>
                    <StatusBadge
                      status={
                        event.status as
                          | "processing"
                          | "running"
                          | "completed"
                          | "failed"
                          | "queued"
                      }
                    />
                    {event.progress > 0 && event.progress < 100 && (
                      <Text textStyle="data" fontSize="11px" color="fg.subtle">
                        {event.progress}%
                      </Text>
                    )}
                  </Flex>
                  {event.errorCode && (
                    <Flex align="center" gap="1.5" color="danger.fg">
                      <AlertTriangle size={12} aria-hidden />
                      <Text fontSize="xs">{userErrorMessage(event.errorCode)}</Text>
                    </Flex>
                  )}
                </Stack>
                <Text
                  textStyle="data"
                  fontSize="11px"
                  color="fg.subtle"
                  flexShrink={0}
                >
                  {formatDateTime(event.emittedAt)}
                </Text>
              </Flex>
            ))}
          </Stack>
        )}
      </Stack>
    </Box>
  );
}
