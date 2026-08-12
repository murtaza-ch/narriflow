import { Box, Flex, Heading, Stack, Text } from "@chakra-ui/react"
import type { ReactNode } from "react"

export interface PageHeaderProps {
  /** Small caps label above the rule — the section's voice. */
  eyebrow?: string
  title: ReactNode
  description?: ReactNode
  /** Right-aligned action cluster (buttons, menus). */
  actions?: ReactNode
  /** Row of chips/stats rendered under the title block. */
  meta?: ReactNode
  /** Draw the 1.5px ink top-rule (default true). */
  rule?: boolean
}

/**
 * PageHeader — the one page-header rhythm in Blueline.
 *
 * Eyebrow above a 1.5px ink rule that draws in from the left (`rule-in`),
 * then title / description with actions right-aligned. Structure is drawn,
 * not boxed. Server-component friendly: pure markup + CSS animation
 * (the global reduced-motion kill-switch covers `rule-in`).
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  meta,
  rule = true,
}: PageHeaderProps) {
  return (
    <Box as="header" w="full">
      {eyebrow && (
        <Text textStyle="eyebrow" color="fg.subtle" mb="2">
          {eyebrow}
        </Text>
      )}
      {rule && <Box h="1.5px" bg="border.strong" animation="rule-in" />}
      <Flex
        align="flex-start"
        justify="space-between"
        gap="4"
        wrap="wrap"
        pt={rule ? "4" : "0"}
      >
        <Stack gap="1.5" flex="1" minW="0">
          <Heading as="h1" textStyle="title" fontSize={{ base: "24px", md: "30px" }}>
            {title}
          </Heading>
          {description && (
            <Text textStyle="sm" color="fg.muted" maxW="60ch">
              {description}
            </Text>
          )}
          {meta && (
            <Flex align="center" gap="3" wrap="wrap" pt="1">
              {meta}
            </Flex>
          )}
        </Stack>
        {actions && (
          <Flex align="center" gap="2" flexShrink={0}>
            {actions}
          </Flex>
        )}
      </Flex>
    </Box>
  )
}
