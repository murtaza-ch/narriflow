"use client"

import { HStack, Text, chakra } from "@chakra-ui/react"

interface LogoProps {
  size?: "sm" | "md" | "lg"
  showWordmark?: boolean
}

const sizeMap = {
  sm: { mark: 16, text: "14px", gap: "8px" },
  md: { mark: 18, text: "15px", gap: "9px" },
  lg: { mark: 22, text: "18px", gap: "10px" },
}

/**
 * Waveform mark — three rounded bars, the tall center bar is the
 * ultramarine signal (re-inked automatically via the accent tokens).
 * Reads as both an audio waveform and a play cursor.
 */
export function Logo({ size = "md", showWordmark = true }: LogoProps) {
  const s = sizeMap[size]

  return (
    <HStack gap={s.gap} align="center">
      <chakra.svg
        width={`${s.mark}px`}
        height={`${s.mark}px`}
        viewBox="0 0 20 20"
        fill="none"
        flexShrink={0}
        aria-hidden="true"
      >
        <chakra.rect x="1" y="6.5" width="4" height="7" rx="2" fill="currentColor" color="fg" />
        <chakra.rect x="8" y="1" width="4" height="18" rx="2" fill="currentColor" color="accent.solid" />
        <chakra.rect x="15" y="4.5" width="4" height="11" rx="2" fill="currentColor" color="fg" />
      </chakra.svg>
      {showWordmark && (
        <Text
          fontSize={s.text}
          fontFamily="display"
          fontWeight="650"
          // Archivo tracks tighter than Bricolage at small sizes.
          letterSpacing="-0.02em"
          color="fg"
          lineHeight="1"
        >
          narriflow
        </Text>
      )}
    </HStack>
  )
}
