import { Box, Flex, Heading, Stack, Text } from "@chakra-ui/react"
import type { ReactNode } from "react"

export interface PageHeaderProps {
  /** Optional changing context, such as a workspace, revision, or timezone. */
  eyebrow?: string
  title: ReactNode
  /** A useful fact or consequence that the title and page body do not repeat. */
  description?: ReactNode
  /** Right-aligned action cluster (buttons, menus). */
  actions?: ReactNode
  /** Row of chips/stats rendered under the title block. */
  meta?: ReactNode
  /** Optional separator for pages that need one. */
  rule?: boolean
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  meta,
  rule = false,
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
        direction={{ base: "column", sm: "row" }}
        pt={rule ? "4" : "0"}
      >
        <Stack gap="1.5" flex="1" minW="0" w={{ base: "full", sm: "auto" }}>
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
          <Flex align="center" gap="2" flexShrink={0} wrap="wrap" maxW="full">
            {actions}
          </Flex>
        )}
      </Flex>
    </Box>
  )
}
