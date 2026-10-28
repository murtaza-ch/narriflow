"use client";

import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { AlertTriangle, Check } from "lucide-react";
import {
  mergePipelineStepsWithLiveEvents,
  pipelineStepStateWord,
  type PipelineStepView,
} from "@/lib/project-state";
import type { PipelineStepState } from "@narriflow/validators";
import { useProjectEvents } from "./project-events-provider";

const LABEL_COLORS: Record<PipelineStepState, string> = {
  done: "fg.muted",
  active: "fg",
  failed: "danger.fg",
  todo: "fg.subtle",
};

/**
 * The run as one segment per step, drawn like the processing panel's: done
 * fills, the running step shimmers, a stop shows in danger. Step progress is
 * not known here, so the running segment always shimmers.
 */
export function PipelineStepper({
  steps,
  workflowRunId,
}: {
  steps: PipelineStepView[];
  workflowRunId: string | null;
}) {
  const { latestByStage } = useProjectEvents();
  const liveSteps = mergePipelineStepsWithLiveEvents(
    steps,
    latestByStage,
    workflowRunId,
  );

  return (
    <Flex
      as="ol"
      w="full"
      aria-label="Pipeline progress"
      listStyleType="none"
      m="0"
      p="0"
      gap="1.5"
      align="flex-start"
    >
      {liveSteps.map((step) => {
        const stateWord = pipelineStepStateWord(step.state, step.status)
          ?? (step.state === "done" ? "Complete" : "Not started");
        return (
          <Stack
            key={step.label}
            as="li"
            aria-current={step.state === "active" ? "step" : undefined}
            aria-label={`${step.label}: ${stateWord}`}
            flex="1"
            minW="0"
            gap="2"
          >
            <Box aria-hidden="true" h="6px" borderRadius="full" overflow="hidden" bg="bg.muted">
              {step.state === "done" ? (
                <Box h="full" bg="accent.solid" borderRadius="full" />
              ) : step.state === "failed" ? (
                <Box h="full" bg="danger.solid" borderRadius="full" />
              ) : step.state === "active" ? (
                <Box
                  h="full"
                  backgroundImage="linear-gradient(90deg, transparent 20%, {colors.accent.solid} 50%, transparent 80%)"
                  backgroundSize="200% 100%"
                  animation="shimmer"
                />
              ) : null}
            </Box>
            <Flex align="center" gap="1" color={LABEL_COLORS[step.state]} aria-hidden="true">
              {step.state === "done" ? (
                <Box as="span" display="inline-flex" color="accent.fg">
                  <Check size={12} strokeWidth={3} />
                </Box>
              ) : step.state === "failed" ? (
                <AlertTriangle size={12} strokeWidth={2.25} />
              ) : null}
              <Text fontSize="12px" fontWeight="500" truncate>
                {step.label}
              </Text>
            </Flex>
          </Stack>
        );
      })}
    </Flex>
  );
}
