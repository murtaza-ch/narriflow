"use client";

import { useMemo } from "react";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { StatusBadge } from "@narriflow/ui/components/status-badge";
import { userErrorMessage } from "@narriflow/validators";
import { AlertTriangle } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import {
  PROJECT_EVENT_ROW_LIMIT,
  projectActivityRows,
  workflowStageLabel,
} from "@/lib/project-state";
import { useProjectEvents } from "./project-events-provider";

function stripeFor(status: string): string {
  if (status === "completed") return "success.solid";
  if (status === "partial") return "warning.solid";
  if (status === "failed") return "danger.solid";
  if (
    status === "processing" ||
    status === "running" ||
    status === "waiting"
  ) {
    return "accent.solid";
  }
  return "border.emphasized";
}

/**
 * Activity tab — renders the live workflow event timeline. The EventSource
 * connection itself lives in ProjectEventsProvider (mounted once per project
 * page around the tabs) so the Phase 2a processing checklist can consume the
 * same stream without a second connection; this component is now a pure
 * consumer and stays mounted regardless of active tab exactly as before.
 */
export function ProjectEvents() {
  const { events } = useProjectEvents();

  // State stays ascending (cheap append + dedup by seq); the list renders
  // newest-first so the user lands on the freshest event instead of having to
  // scroll past stale rows to find what just happened.
  const rows = useMemo(() => projectActivityRows(events), [events]);

  return (
    <Box layerStyle="band">
      <Stack gap="4">
        <Flex align="center" justify="space-between" gap="3">
          <Box>
            <Text textStyle="eyebrow" color="fg.subtle">
              Activity
            </Text>
            <Text mt="0.5" fontSize="xs" color="fg.muted">
              {events.length >= PROJECT_EVENT_ROW_LIMIT
                ? `Most recent ${PROJECT_EVENT_ROW_LIMIT} workflow events, newest first, updating live.`
                : "Workflow history for this project, updating live."}
            </Text>
          </Box>
        </Flex>

        {rows.length === 0 ? (
          <Flex align="center" gap="2" py="2">
            {/* Static accent dot — an open channel, not a blinking light */}
            <Box w="6px" h="6px" borderRadius="2px" bg="accent.solid" />
            <Text fontSize="sm" color="fg.muted">
              Waiting for workflow updates.
            </Text>
          </Flex>
        ) : (
          <Stack gap="0" borderTopWidth="1px" borderColor="border.subtle">
            {rows.map((event) => (
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
                      {workflowStageLabel(event.stage)}
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
