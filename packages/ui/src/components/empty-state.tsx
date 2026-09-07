import { EmptyState as ChakraEmptyState, Stack } from "@chakra-ui/react";
import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  ratio?: number;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <ChakraEmptyState.Root py={{ base: "10", md: "12" }} px="5" bg="bg.subtle" borderRadius="l2">
      <ChakraEmptyState.Content>
        {icon && <ChakraEmptyState.Indicator color="fg.muted" bg="bg.muted" borderRadius="l2" p="3">{icon}</ChakraEmptyState.Indicator>}
        <Stack textAlign="center" gap="2">
          <ChakraEmptyState.Title fontWeight="500">{title}</ChakraEmptyState.Title>
          {description && (
            <ChakraEmptyState.Description maxW="44ch">{description}</ChakraEmptyState.Description>
          )}
        </Stack>
        {action}
      </ChakraEmptyState.Content>
    </ChakraEmptyState.Root>
  );
}
