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

/**
 * StatusBadge — Blueline status voice: no pill, no pulse. A small square
 * swatch in the stripe-grade status color plus an eyebrow label; processing
 * is distinguished by the ultramarine accent, not motion. State is never
 * hue alone — the label always accompanies the color. Server-friendly.
 */
export function StatusBadge({ status, label }: StatusBadgeProps) {
  const config = statusConfig[status] ?? statusConfig.pending

  return (
    <HStack display="inline-flex" gap="1.5" align="center">
      <Box w="8px" h="8px" borderRadius="2px" bg={config.square} flexShrink={0} />
      <Text textStyle="eyebrow" color={config.color}>
        {label ?? config.label}
      </Text>
    </HStack>
  )
}
