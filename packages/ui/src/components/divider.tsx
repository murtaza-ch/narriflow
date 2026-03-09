import { Flex, Box, Text } from "@chakra-ui/react"

interface LabeledDividerProps {
  label?: string
}

export function LabeledDivider({ label }: LabeledDividerProps) {
  if (!label) {
    return <Box h="1px" bg="border" w="full" />
  }

  return (
    <Flex align="center" gap="12px" w="full">
      <Box h="1px" bg="border" flex="1" />
      <Text
        fontSize="11px"
        fontWeight="500"
        letterSpacing="0.05em"
        textTransform="uppercase"
        color="fg.subtle"
        flexShrink={0}
      >
        {label}
      </Text>
      <Box h="1px" bg="border" flex="1" />
    </Flex>
  )
}
