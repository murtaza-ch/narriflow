import { Box, Flex, type BoxProps } from "@chakra-ui/react"

export interface GhostFrameProps extends BoxProps {
  /** Aspect ratio as a number — 16/9 (default) or 9/16. */
  ratio?: number
  /** Frame width. Default 220px. */
  size?: BoxProps["width"]
}

/**
 * GhostFrame — a dashed hairline outline in the shape of a clip frame with a
 * faint corner-to-corner diagonal cross. The Blueline empty-state motif:
 * the frame that footage would fill. Children (usually an icon) render
 * centered inside. Server-component friendly.
 */
export function GhostFrame({ ratio = 16 / 9, size = "220px", children, ...rest }: GhostFrameProps) {
  return (
    <Box
      position="relative"
      aspectRatio={ratio}
      w={size}
      borderWidth="1px"
      borderStyle="dashed"
      borderColor="border.emphasized"
      borderRadius="l2"
      overflow="hidden"
      {...rest}
    >
      {/* Plain <svg>, not the chakra factory — GhostFrame renders in server
          components, where chakra.* client-reference proxies are undefined. */}
      <Box position="absolute" inset="0" color="border" aria-hidden="true">
        <svg
          width="100%"
          height="100%"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          <line
            x1="0"
            y1="0"
            x2="100"
            y2="100"
            stroke="currentColor"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          <line
            x1="100"
            y1="0"
            x2="0"
            y2="100"
            stroke="currentColor"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </Box>
      {children != null && (
        <Flex position="absolute" inset="0" align="center" justify="center" color="fg.subtle">
          {children}
        </Flex>
      )}
    </Box>
  )
}
