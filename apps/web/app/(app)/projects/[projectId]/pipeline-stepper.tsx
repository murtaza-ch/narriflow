"use client";

import { Box, Flex, Text } from "@chakra-ui/react";
import { Check } from "lucide-react";
import {
  mergePipelineStepsWithLiveEvents,
  pipelineStepStateWord,
  type PipelineStepState,
  type PipelineStepView,
} from "@/lib/project-state";
import { useProjectEvents } from "./project-events-provider";

const STEP_COLORS: Record<
  PipelineStepState,
  { node: string; index: string; label: string }
> = {
  done: { node: "success.solid", index: "success.fg", label: "fg.muted" },
  active: { node: "accent.solid", index: "accent.fg", label: "accent.fg" },
  failed: { node: "danger.solid", index: "danger.fg", label: "danger.fg" },
  todo: { node: "border.emphasized", index: "fg.subtle", label: "fg.subtle" },
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
      align="center"
      w="full"
      aria-label="Pipeline progress"
      listStyleType="none"
      m="0"
      p="0"
      rowGap="2.5"
      columnGap="0"
      wrap="wrap"
    >
      {liveSteps.map((step, index) => {
        const colors = STEP_COLORS[step.state];
        const stateWord = pipelineStepStateWord(step.state, step.status);
        const isLast = index === liveSteps.length - 1;
        return (
          <Flex
            key={step.label}
            as="li"
            align="center"
            flex={isLast ? "0 0 auto" : "1 1 auto"}
            minW="0"
          >
            <Flex align="center" gap="2" flexShrink={0}>
              <Flex
                w="18px"
                h="18px"
                align="center"
                justify="center"
                borderRadius="full"
                borderWidth="1.5px"
                borderColor={colors.node}
                bg={step.state === "done" ? "success.subtle" : "transparent"}
                flexShrink={0}
              >
                {step.state === "done" ? (
                  <Box asChild color="success.fg" aria-label="complete">
                    <Check size={10} strokeWidth={3} />
                  </Box>
                ) : (
                  <Text
                    textStyle="data"
                    fontSize="10px"
                    lineHeight="1"
                    color={colors.index}
                  >
                    {index + 1}
                  </Text>
                )}
              </Flex>
              <Text
                fontSize="11px"
                fontWeight="500"
                lineHeight="1.2"
                color={colors.label}
              >
                {step.label}
              </Text>
              {stateWord && (
                <Text
                  textStyle="data"
                  fontSize="10px"
                  lineHeight="1.2"
                  color={colors.label}
                >
                  · {stateWord}
                </Text>
              )}
            </Flex>
            {!isLast && (
              <Box flex="1" h="1px" bg="border" mx="3" minW="12px" />
            )}
          </Flex>
        );
      })}
    </Flex>
  );
}
