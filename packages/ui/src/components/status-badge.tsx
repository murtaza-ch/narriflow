"use client"

import { HStack, Text, Box } from "@chakra-ui/react"

type StatusType = "queued" | "pending" | "processing" | "ready" | "completed" | "failed" | "error"

interface StatusBadgeProps {
  status: StatusType
  label?: string
}

const statusConfig: Record<StatusType, { color: string; dotColor: string; label: string; pulse?: boolean }> = {
  queued: { color: "fg.muted", dotColor: "fg.subtle", label: "Queued" },
  pending: { color: "fg.muted", dotColor: "fg.subtle", label: "Pending" },
  processing: { color: "fg.accent", dotColor: "accent.solid", label: "Processing", pulse: true },
  ready: { color: "success.fg", dotColor: "success.solid", label: "Ready" },
  completed: { color: "success.fg", dotColor: "success.solid", label: "Completed" },
  failed: { color: "danger.fg", dotColor: "danger.solid", label: "Failed" },
  error: { color: "danger.fg", dotColor: "danger.solid", label: "Error" },
}

export function StatusBadge({ status, label }: StatusBadgeProps) {
  const config = statusConfig[status] ?? statusConfig.pending

  return (
    <HStack
      gap="6px"
      px="8px"
      py="2px"
      borderRadius="6px"
      bg="bg.muted"
      display="inline-flex"
    >
      <Box
        w="6px"
        h="6px"
        borderRadius="full"
        bg={config.dotColor}
        flexShrink={0}
        animation={config.pulse ? "pulse 2s ease-in-out infinite" : undefined}
      />
      <Text fontSize="11px" fontWeight="500" letterSpacing="0.02em" color={config.color}>
        {label ?? config.label}
      </Text>
    </HStack>
  )
}
