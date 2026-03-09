"use client"

import { HStack, Text } from "@chakra-ui/react"
import { Box } from "@chakra-ui/react"

interface LogoProps {
  size?: "sm" | "md" | "lg"
  showWordmark?: boolean
}

const sizeMap = {
  sm: { mark: "6px", text: "13px", gap: "6px" },
  md: { mark: "7px", text: "15px", gap: "7px" },
  lg: { mark: "8px", text: "17px", gap: "8px" },
}

export function Logo({ size = "md", showWordmark = true }: LogoProps) {
  const s = sizeMap[size]

  return (
    <HStack gap={s.gap}>
      <Box
        w={s.mark}
        h={s.mark}
        bg="accent.solid"
        borderRadius="2px"
        flexShrink={0}
      />
      {showWordmark && (
        <Text
          fontSize={s.text}
          fontWeight="600"
          letterSpacing="-0.02em"
          color="fg"
        >
          narriflow
        </Text>
      )}
    </HStack>
  )
}
