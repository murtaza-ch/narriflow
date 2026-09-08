"use client";

import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { AudioLines, Circle, Download, Film, ScanSearch, Send, type LucideIcon } from "lucide-react";
import {
  mergePipelineStepsWithLiveEvents,
  pipelineStepStateWord,
  type PipelineStepState,
  type PipelineStepView,
} from "@/lib/project-state";
import { useProjectEvents } from "./project-events-provider";

const STEP_ICONS: Record<string, LucideIcon> = {
  Ingest: Download,
  Transcribe: AudioLines,
  Detect: ScanSearch,
  Render: Film,
  Publish: Send,
};

const STEP_COLORS: Record<
  PipelineStepState,
  { bg: string; border: string; fg: string }
> = {
  done: { bg: "bg.panel", border: "border.emphasized", fg: "accent.fg" },
  active: { bg: "accent.subtle", border: "accent.fg", fg: "accent.fg" },
  failed: { bg: "danger.subtle", border: "danger.fg", fg: "danger.fg" },
  todo: { bg: "bg", border: "border", fg: "fg.muted" },
};

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
      align="flex-start"
    >
      {liveSteps.map((step, index) => {
        const colors = STEP_COLORS[step.state];
        const StageIcon = STEP_ICONS[step.label] ?? Circle;
        const stateWord = pipelineStepStateWord(step.state, step.status)
          ?? (step.state === "done" ? "Complete" : "Not started");
        const isLast = index === liveSteps.length - 1;
        return (
          <Stack
            key={step.label}
            as="li"
            aria-current={step.state === "active" ? "step" : undefined}
            aria-label={`${step.label}: ${stateWord}`}
            position="relative"
            flex={isLast ? "0 0 auto" : "1"}
            minW="0"
            gap="2.5"
            align={isLast ? "flex-end" : "flex-start"}
          >
            {!isLast && (
              <Box
                aria-hidden="true"
                position="absolute"
                top="18px"
                left="48px"
                w="calc(100% - 60px)"
                h="1px"
                bg={step.state === "done" ? "border.emphasized" : "border"}
              />
            )}
            <Flex align="center" aria-hidden="true">
              <Flex
                w="36px"
                h="36px"
                align="center"
                justify="center"
                borderRadius="xl"
                borderWidth="1px"
                borderColor={colors.border}
                bg={colors.bg}
                color={colors.fg}
                flexShrink={0}
              >
                <StageIcon size={16} strokeWidth={1.75} />
              </Flex>
            </Flex>
            <Text
              fontSize={{ base: "10px", md: "xs" }}
              fontWeight="medium"
              color={step.state === "failed" ? "danger.fg" : step.state === "todo" ? "fg.subtle" : "fg.muted"}
            >
              {step.label}
            </Text>
          </Stack>
        );
      })}
    </Flex>
  );
}
