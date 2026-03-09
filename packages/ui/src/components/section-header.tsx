import { Flex, Stack, Heading, Text } from "@chakra-ui/react"
import type { ReactNode } from "react"

interface SectionHeaderProps {
  title: string
  description?: string
  action?: ReactNode
}

export function SectionHeader({ title, description, action }: SectionHeaderProps) {
  return (
    <Flex align="center" justify="space-between" gap="16px">
      <Stack gap="1">
        <Heading size="xl" fontWeight="600" letterSpacing="-0.02em">
          {title}
        </Heading>
        {description && (
          <Text textStyle="sm" color="fg.muted">
            {description}
          </Text>
        )}
      </Stack>
      {action}
    </Flex>
  )
}
