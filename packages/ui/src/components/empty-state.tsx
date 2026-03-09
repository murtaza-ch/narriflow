import { VStack, Heading, Text, Box } from "@chakra-ui/react"
import type { ReactNode } from "react"

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <VStack py="64px" gap="16px" textAlign="center">
      {icon && (
        <Box
          w="48px"
          h="48px"
          borderRadius="12px"
          bg="bg.muted"
          display="flex"
          alignItems="center"
          justifyContent="center"
          color="fg.muted"
        >
          {icon}
        </Box>
      )}
      <VStack gap="4px">
        <Heading size="md" fontWeight="600">
          {title}
        </Heading>
        {description && (
          <Text textStyle="sm" color="fg.muted" maxW="320px">
            {description}
          </Text>
        )}
      </VStack>
      {action}
    </VStack>
  )
}
