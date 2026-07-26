import { Flex, Box, Text } from "@chakra-ui/react"

interface LabeledDividerProps {
  label?: string
}

/**
 * LabeledDivider — a hairline rule, optionally interrupted by an eyebrow
 * label. Server-component friendly.
 */
export function LabeledDivider({ label }: LabeledDividerProps) {
  if (!label) {
    return <Box h="1px" bg="border" w="full" />
  }

  return (
    <Flex align="center" gap="3" w="full">
      <Box h="1px" bg="border" flex="1" />
      <Text textStyle="eyebrow" color="fg.subtle" flexShrink={0}>
        {label}
      </Text>
      <Box h="1px" bg="border" flex="1" />
    </Flex>
  )
}
