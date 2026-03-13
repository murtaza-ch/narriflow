"use client"

import { Box, Text, Flex } from "@chakra-ui/react"

interface ScoreBadgeProps {
  score: number
  size?: "sm" | "md" | "lg"
  showLabel?: boolean
}

function getScoreColor(score: number): { bg: string; text: string; ring: string } {
  if (score >= 70) return { bg: "success.subtle", text: "success.fg", ring: "success.solid" }
  if (score >= 40) return { bg: "warning.subtle", text: "warning.fg", ring: "warning.solid" }
  return { bg: "bg.muted", text: "fg.muted", ring: "fg.subtle" }
}

function getScoreLabel(score: number): string {
  if (score >= 90) return "Viral"
  if (score >= 70) return "High"
  if (score >= 50) return "Good"
  if (score >= 30) return "Fair"
  return "Low"
}

const sizeConfig = {
  sm: { box: "28px", font: "11px", labelFont: "9px" },
  md: { box: "40px", font: "14px", labelFont: "10px" },
  lg: { box: "52px", font: "18px", labelFont: "11px" },
}

export function ScoreBadge({ score, size = "md", showLabel = false }: ScoreBadgeProps) {
  const colors = getScoreColor(score)
  const s = sizeConfig[size]

  return (
    <Flex direction="column" align="center" gap="2px">
      <Box
        w={s.box}
        h={s.box}
        borderRadius="full"
        borderWidth="2px"
        borderColor={colors.ring}
        bg={colors.bg}
        display="flex"
        alignItems="center"
        justifyContent="center"
      >
        <Text fontSize={s.font} fontWeight="700" color={colors.text} lineHeight="1">
          {score}
        </Text>
      </Box>
      {showLabel && (
        <Text fontSize={s.labelFont} fontWeight="500" color={colors.text} letterSpacing="0.02em">
          {getScoreLabel(score)}
        </Text>
      )}
    </Flex>
  )
}
