import { HStack, Text, Box } from "@chakra-ui/react"

type StatusType =
  | "queued"
  | "pending"
  | "processing"
  | "running"
  | "ready"
  | "completed"
  | "failed"
  | "error"

interface StatusBadgeProps {
  status: StatusType
  label?: string
}

const statusConfig: Record<StatusType, { square: string; color: string; label: string }> = {
  queued: { square: "fg.subtle", color: "fg.muted", label: "Queued" },
  pending: { square: "fg.subtle", color: "fg.muted", label: "Pending" },
  processing: { square: "accent.solid", color: "accent.fg", label: "Processing" },
  running: { square: "accent.solid", color: "accent.fg", label: "Running" },
  ready: { square: "success.solid", color: "success.fg", label: "Ready" },
  completed: { square: "success.solid", color: "success.fg", label: "Completed" },
  failed: { square: "danger.solid", color: "danger.fg", label: "Failed" },
  error: { square: "danger.solid", color: "danger.fg", label: "Error" },
}

/** Compact, labeled status pills shared by project and processing views. */
export function StatusBadge({ status, label }: StatusBadgeProps) {
  const config = statusConfig[status] ?? statusConfig.pending

  return (
    <HStack display="inline-flex" gap="1.5" align="center" px="2" py="1" borderRadius="full" bg={status === "failed" || status === "error" ? "danger.subtle" : status === "ready" || status === "completed" ? "success.subtle" : status === "processing" || status === "running" ? "accent.subtle" : "bg.muted"}>
      <Box w="5px" h="5px" borderRadius="full" bg={config.square} flexShrink={0} />
      <Text fontSize="11px" lineHeight="1" color={config.color}>
        {label ?? config.label}
      </Text>
    </HStack>
  )
}
