import { Flex, type FlexProps } from "@chakra-ui/react"

export type ToolbarProps = FlexProps

/**
 * Toolbar — the slim sticky command row: 48px tall, hairline bottom rule,
 * translucent ground with backdrop blur so content scrolls beneath it.
 * Server-component friendly (pure CSS); place interactive controls inside.
 */
export function Toolbar({ children, ...rest }: ToolbarProps) {
  return (
    <Flex
      position="sticky"
      top="0"
      zIndex="docked"
      h="12"
      minH="12"
      align="center"
      gap="2"
      bg="bg/92"
      backdropFilter="blur(12px)"
      borderBottomWidth="1px"
      borderBottomColor="border"
      {...rest}
    >
      {children}
    </Flex>
  )
}
