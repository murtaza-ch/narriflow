import { Box, Flex, Stack, Text, type BoxProps } from "@chakra-ui/react"

export type MeterPalette = "accent" | "success" | "warning" | "danger"

export interface MeterProps extends Omit<BoxProps, "children"> {
  /** 0–100. Values outside the range are clamped. */
  value: number
  /** Fill color family (default accent — the ultramarine meter fill). */
  palette?: MeterPalette
  /** Optional eyebrow label rendered above the track. */
  label?: string
  /** Show the mono value text (defaults to true when a label is given). */
  showValue?: boolean
}

/**
 * Meter — the Blueline progress voice: a 3px hairline-height track with an
 * accent fill that draws in on mount (`meter-fill`, CSS-only, covered by the
 * global reduced-motion kill-switch). Server-component friendly.
 */
export function Meter({
  value,
  palette = "accent",
  label,
  showValue,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  ...rest
}: MeterProps) {
  const clamped = Math.min(100, Math.max(0, value))
  const showValueText = showValue ?? Boolean(label)

  return (
    <Box w="full" {...rest}>
      {(label || showValueText) && (
        <Flex align="baseline" justify="space-between" gap="3" mb="1.5">
          {label && (
            <Text textStyle="eyebrow" color="fg.subtle">
              {label}
            </Text>
          )}
          {showValueText && (
            <Text textStyle="data" fontSize="12px" color="fg.muted" ms="auto">
              {Math.round(clamped)}%
            </Text>
          )}
        </Flex>
      )}
      <Box
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
        aria-label={ariaLabel ?? (ariaLabelledby ? undefined : label)}
        aria-labelledby={ariaLabelledby}
        h="3px"
        bg="bg.muted"
        borderRadius="full"
        overflow="hidden"
      >
        <Box
          h="full"
          width={`${clamped}%`}
          bg={`${palette}.solid`}
          borderRadius="full"
          animation="meter-fill"
        />
      </Box>
    </Box>
  )
}

export interface ScoreMeterProps {
  /** Virality score, 0–100. */
  score: number
  size?: "sm" | "md" | "lg"
  /** Render the tier word (Viral/High/Good/Fair/Low) under the meter. */
  showLabel?: boolean
}

const scoreFontSizes = {
  sm: "14px",
  md: "18px",
  lg: "24px",
} as const

function getScoreColors(score: number): { text: string; fill: string } {
  if (score >= 70) return { text: "success.fg", fill: "success.solid" }
  if (score >= 40) return { text: "warning.fg", fill: "warning.solid" }
  return { text: "fg.muted", fill: "fg.subtle" }
}

function getScoreLabel(score: number): string {
  if (score >= 90) return "Viral"
  if (score >= 70) return "High"
  if (score >= 50) return "Good"
  if (score >= 30) return "Fair"
  return "Low"
}

/**
 * ScoreMeter — the virality score as a bare mono numeral (no pill costume)
 * with a 24px meter underneath. The Blueline standard score treatment.
 * Server-component friendly.
 */
export function ScoreMeter({ score, size = "md", showLabel = false }: ScoreMeterProps) {
  const clamped = Math.min(100, Math.max(0, score))
  const colors = getScoreColors(clamped)

  return (
    <Stack display="inline-flex" gap="1" align="flex-start">
      <Text
        textStyle="data"
        fontWeight="600"
        fontSize={scoreFontSizes[size]}
        lineHeight="1"
        color={colors.text}
      >
        {Math.round(clamped)}
      </Text>
      <Box
        w="24px"
        h="3px"
        bg="bg.muted"
        borderRadius="full"
        overflow="hidden"
        aria-hidden="true"
      >
        <Box
          h="full"
          width={`${clamped}%`}
          bg={colors.fill}
          borderRadius="full"
          animation="meter-fill"
        />
      </Box>
      {showLabel && (
        <Text textStyle="eyebrow" color={colors.text}>
          {getScoreLabel(clamped)}
        </Text>
      )}
    </Stack>
  )
}
