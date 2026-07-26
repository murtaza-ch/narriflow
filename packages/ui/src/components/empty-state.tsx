import { VStack, Heading, Text, Box, Flex } from "@chakra-ui/react"
import type { ReactNode } from "react"
import { GhostFrame } from "./ghost-frame"

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
  /** Ghost-frame aspect ratio — 16/9 (default) or 9/16. */
  ratio?: number
}

/**
 * EmptyState — Blueline v2: an open centered zone (no boxed dashed panel)
 * over a masked blueprint-grid ambient, with a GhostFrame standing in for
 * the footage that isn't there yet. Server-component friendly.
 */
export function EmptyState({ icon, title, description, action, ratio = 16 / 9 }: EmptyStateProps) {
  return (
    <Flex position="relative" py="16" px="6" justify="center" overflow="hidden">
      {/* Blueprint-grid atmosphere, fading toward the center */}
      <Box
        position="absolute"
        inset="0"
        layerStyle="blueprint"
        style={{
          maskImage: "radial-gradient(ellipse 75% 75% at center, transparent 22%, black 55%, transparent 100%)",
          WebkitMaskImage: "radial-gradient(ellipse 75% 75% at center, transparent 22%, black 55%, transparent 100%)",
        }}
        pointerEvents="none"
      />
      <VStack gap="5" textAlign="center" position="relative">
        <GhostFrame ratio={ratio} size={ratio >= 1 ? "240px" : "132px"}>
          {icon}
        </GhostFrame>
        <VStack gap="1">
          <Heading as="h3" textStyle="title" fontSize="17px">
            {title}
          </Heading>
          {description && (
            <Text textStyle="sm" color="fg.muted" maxW="44ch">
              {description}
            </Text>
          )}
        </VStack>
        {action}
      </VStack>
    </Flex>
  )
}
