"use client";

import Link from "next/link";
import { Box, chakra, Flex, Stack, Text } from "@chakra-ui/react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";

export function reviewOverrideReasonForRequest(input: {
  blocked: boolean;
  canOverride: boolean;
  reason: string;
}) {
  return input.blocked && input.canOverride ? input.reason.trim() || null : null;
}

export function reviewApprovalOverrideReady(input: {
  blocked: boolean;
  canOverride: boolean;
  reason: string;
}) {
  return !input.blocked || (input.canOverride && input.reason.trim().length > 0);
}

export function ReviewApprovalCheckpoint({
  projectId,
  canOverride,
  reason,
  onReasonChange,
  inputId,
}: {
  projectId: string;
  canOverride: boolean;
  reason: string;
  onReasonChange(reason: string): void;
  inputId: string;
}) {
  return (
    <Box bg="warning.subtle" borderRadius="l2" px="4" py="3.5">
      <Flex align="start" gap="3">
        <Box color="warning.fg" mt="0.5">
          <ShieldAlert size={17} aria-hidden />
        </Box>
        <Stack gap="2.5" flex="1" minW="0">
          <Box>
            <Text fontSize="14px" fontWeight="500" color="fg">
              Approval checkpoint
            </Text>
            <Text fontSize="sm" color="fg" mt="1">
              This exact clip export needs approval before it can be scheduled.
            </Text>
            <Text fontSize="xs" color="fg.muted" mt="1">
              Approval follows the frozen export revision. Caption and schedule
              changes do not reset it.
            </Text>
          </Box>
          <Flex
            gap="3"
            align={{ base: "stretch", md: "end" }}
            direction={{ base: "column", md: "row" }}
          >
            <Button size="sm" variant="subtle" asChild>
              <Link href={`/projects/${projectId}?tab=review`}>Open review</Link>
            </Button>
            {canOverride ? (
              <Stack gap="1" flex="1">
                <chakra.label
                  htmlFor={inputId}
                  textStyle="eyebrow"
                  color="fg.muted"
                >
                  Owner or Admin override reason
                </chakra.label>
                <Input
                  id={inputId}
                  size="sm"
                  value={reason}
                  maxLength={500}
                  placeholder="Why can this revision publish without approval?"
                  onChange={(event) => onReasonChange(event.target.value)}
                />
                <Text
                  fontSize="12px"
                  fontVariantNumeric="tabular-nums"
                  color="fg.subtle"
                  textAlign="end"
                >
                  {reason.length}/500
                </Text>
              </Stack>
            ) : (
              <Text fontSize="xs" color="fg.muted">
                A Workspace Owner or Admin can add an audited override.
              </Text>
            )}
          </Flex>
        </Stack>
      </Flex>
    </Box>
  );
}
