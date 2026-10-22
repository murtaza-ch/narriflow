"use client";

import { useMemo } from "react";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { StatusBadge } from "@narriflow/ui/components/status-badge";
import { Meter } from "@narriflow/ui/components/meter";
import { userErrorMessage } from "@narriflow/validators";
import { Activity, AlertTriangle } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import {
  PROJECT_EVENT_ROW_LIMIT,
  projectActivityRows,
  workflowStageLabel,
} from "@/lib/project-state";
import { useProjectEvents } from "./project-events-provider";
import { PanelHeader } from "./panel-header";

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
    <Stack gap="6">
      <PanelHeader
        icon={<Activity size={20} />}
        title="Activity"
        badge={
          <Flex
            align="center"
            gap="1.5"
            px="2"
            py="1"
            borderRadius="full"
            bg="accent.subtle"
            color="accent.fg"
            fontSize="11px"
            lineHeight="1"
          >
            <Box boxSize="1.5" borderRadius="full" bg="accent.solid" />
            Live
          </Flex>
        }
        description={
          events.length >= PROJECT_EVENT_ROW_LIMIT
            ? `The last ${PROJECT_EVENT_ROW_LIMIT} workflow steps, newest first. New ones appear as they happen.`
            : "Each step of this project's workflow, newest first. New ones appear as they happen."
        }
      />

      {rows.length === 0 ? (
        <Flex
          align="center"
          justify="center"
          gap="2.5"
          py="14"
          borderWidth="1px"
          borderStyle="dashed"
          borderColor="border"
          borderRadius="l3"
        >
          <Box boxSize="2" borderRadius="full" bg="accent.solid" animation="pulse" />
          <Text fontSize="sm" color="fg.muted">
            Waiting for workflow updates.
          </Text>
        </Flex>
      ) : (
        <Box borderWidth="1px" borderColor="border.subtle" borderRadius="l3" overflow="hidden">
          {rows.map((event, index) => {
            const tone = stripeFor(event.status);
            return (
              <Flex
                key={event.seq}
                gap="4"
                px="5"
                transition="background 120ms ease"
                _hover={{ bg: "bg.subtle" }}
              >
                {/* Time */}
                <Text
                  textStyle="data"
                  fontSize="11px"
                  color="fg.subtle"
                  w="132px"
                  flexShrink={0}
                  textAlign="right"
                  pt="4"
                  display={{ base: "none", md: "block" }}
                >
                  {formatDateTime(event.emittedAt)}
                </Text>

                {/* Rail: line through every row, a status dot on each */}
                <Box position="relative" w="3" flexShrink={0}>
                  <Box
                    position="absolute"
                    left="50%"
                    top={index === 0 ? "5" : "0"}
                    bottom={index === rows.length - 1 ? "calc(100% - 20px)" : "0"}
                    w="1px"
                    bg="border.subtle"
                    transform="translateX(-50%)"
                  />
                  <Box
                    position="absolute"
                    left="50%"
                    top="4"
                    boxSize="3"
                    borderRadius="full"
                    bg={tone}
                    borderWidth="3px"
                    borderColor="bg.panel"
                    transform="translateX(-50%)"
                  />
                </Box>

                {/* Event */}
                <Stack
                  gap="1.5"
                  minW="0"
                  flex="1"
                  py="3.5"
                  borderBottomWidth={index === rows.length - 1 ? "0" : "1px"}
                  borderColor="border.subtle"
                >
                  <Flex align="center" gap="2.5" minW="0" wrap="wrap">
                    <Text fontSize="14px" fontWeight="550" color="fg" truncate>
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
                  </Flex>
                  <Text
                    textStyle="data"
                    fontSize="11px"
                    color="fg.subtle"
                    display={{ base: "block", md: "none" }}
                  >
                    {formatDateTime(event.emittedAt)}
                  </Text>
                  {event.progress > 0 && event.progress < 100 ? (
                    <Flex align="center" gap="2.5" maxW="320px">
                      <Meter value={event.progress} aria-label={`${workflowStageLabel(event.stage)} progress`} />
                      <Text textStyle="data" fontSize="11px" color="fg.subtle" flexShrink={0}>
                        {event.progress}%
                      </Text>
                    </Flex>
                  ) : null}
                  {event.errorCode ? (
                    <Flex align="center" gap="1.5" color="danger.fg">
                      <AlertTriangle size={12} aria-hidden />
                      <Text fontSize="xs">{userErrorMessage(event.errorCode)}</Text>
                    </Flex>
                  ) : null}
                </Stack>
              </Flex>
            );
          })}
        </Box>
      )}
    </Stack>
  );
}
