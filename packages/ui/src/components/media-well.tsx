import { Box, type BoxProps } from "@chakra-ui/react"
import type { ReactNode } from "react"

export interface MediaWellProps extends BoxProps {
  /** Aspect ratio as a number, e.g. 16/9 or 9/16. Default 16/9. */
  ratio?: number
  /** Bottom-right mono timecode chip. */
  timecode?: ReactNode
}

/**
 * MediaWell — THE container for footage. Thumbnails, previews, and players
 * always sit in a well: mode-invariant graphite ground (footage never sits
 * on white), inset hairline, radius l2. Server-component friendly.
 */
export function MediaWell({ ratio = 16 / 9, timecode, children, ...rest }: MediaWellProps) {
  return (
    <Box
      position="relative"
      aspectRatio={ratio}
      bg="studio.subtle"
      borderWidth="1px"
      borderColor="border"
      borderRadius="l2"
      overflow="hidden"
      {...rest}
    >
      {children}
      {timecode != null && (
        <Box
          position="absolute"
          bottom="1.5"
          insetInlineEnd="1.5"
          px="1.5"
          py="0.5"
          borderRadius="l1"
          // rgba of studio.canvas (#0E1013) — MediaWell's sanctioned
          // mode-invariant graphite exception.
          bg="rgba(14, 16, 19, 0.72)"
          color="studio.timecode"
          textStyle="data"
          fontSize="11px"
          lineHeight="1.4"
          pointerEvents="none"
        >
          {timecode}
        </Box>
      )}
    </Box>
  )
}
