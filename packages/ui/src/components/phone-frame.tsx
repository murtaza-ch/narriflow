import { Box, type BoxProps } from "@chakra-ui/react"

export interface PhoneFrameProps extends BoxProps {
  /** Outer frame width. Default 220px. */
  width?: BoxProps["width"]
}

/**
 * PhoneFrame — a 9:16 phone-shaped well for caption/brand previews.
 * Graphite ground in both modes (like MediaWell), 18px outer radius with a
 * 2px emphasized frame, and a subtle notch bar. Server-component friendly.
 */
export function PhoneFrame({ width = "220px", children, ...rest }: PhoneFrameProps) {
  return (
    <Box
      w={width}
      borderRadius="18px"
      borderWidth="2px"
      borderColor="border.emphasized"
      bg="studio.subtle"
      overflow="hidden"
      position="relative"
      flexShrink={0}
      {...rest}
    >
      <Box position="relative" aspectRatio={9 / 16} w="full">
        {children}
        {/* Notch bar */}
        <Box
          position="absolute"
          top="2"
          left="50%"
          transform="translateX(-50%)"
          w="35%"
          h="2.5"
          borderRadius="full"
          bg="studio.raised"
          zIndex="1"
          pointerEvents="none"
        />
      </Box>
    </Box>
  )
}
