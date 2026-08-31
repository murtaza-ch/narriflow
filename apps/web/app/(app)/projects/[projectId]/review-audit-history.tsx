"use client";

import { Box, chakra, Flex, Stack, Text } from "@chakra-ui/react";
import { formatDateTime } from "@/lib/format";

export type ReviewAuditEntry = {
  id: string;
  kind: string;
  targetId: string | null;
  createdAt: string;
};

function eventLabel(kind: string) {
  return kind.replaceAll("_", " ");
}

function targetLabel(targetId: string | null) {
  return targetId ? `Target ${targetId.slice(0, 8)}` : "Round";
}

export function ReviewAuditHistory({
  events,
}: {
  events: ReviewAuditEntry[];
}) {
  return (
    <Box as="section" aria-labelledby="review-audit-title">
      <Text id="review-audit-title" textStyle="eyebrow" color="fg.subtle">
        Activity
      </Text>
      {events.length === 0 ? (
        <Text mt="2" fontSize="12px" color="fg.muted">
          Activity will appear as this round is opened and reviewed.
        </Text>
      ) : (
        <Stack mt="2" gap="0" borderTopWidth="1px" borderColor="border.subtle">
          {events.map((event) => (
            <Flex
              key={event.id}
              py="2.5"
              justify="space-between"
              align="baseline"
              gap="4"
              borderBottomWidth="1px"
              borderColor="border.subtle"
            >
              <Box>
                <Text fontSize="12px" textTransform="capitalize">
                  {eventLabel(event.kind)}
                </Text>
                <Text
                  textStyle="data"
                  fontSize="10px"
                  color="fg.subtle"
                  title={event.targetId ?? undefined}
                >
                  {targetLabel(event.targetId)}
                </Text>
              </Box>
              <chakra.time
                dateTime={event.createdAt}
                textStyle="data"
                fontSize="10px"
                color="fg.timecode"
                flexShrink="0"
              >
                {formatDateTime(event.createdAt)}
              </chakra.time>
            </Flex>
          ))}
        </Stack>
      )}
    </Box>
  );
}
