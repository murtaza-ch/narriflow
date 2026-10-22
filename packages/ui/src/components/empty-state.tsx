import { EmptyState as ChakraEmptyState, Stack } from "@chakra-ui/react";
import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  ratio?: number;
}

/**
 * Empty state on a subtle card: the icon in a soft circle, a title, one line
 * and one action. No border in dark mode; a hairline on porcelain.
 */
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <ChakraEmptyState.Root
      py={{ base: "10", md: "14" }}
      px="6"
      bg="bg.subtle"
      borderWidth="1px"
      borderColor="border.card"
      borderRadius="l3"
    >
      <ChakraEmptyState.Content gap="4">
        {icon && (
          <ChakraEmptyState.Indicator
            boxSize="11"
            borderRadius="full"
            bg="bg.soft"
            color="fg.muted"
            css={{ "& svg": { width: "20px", height: "20px" } }}
          >
            {icon}
          </ChakraEmptyState.Indicator>
        )}
        <Stack textAlign="center" gap="1">
          <ChakraEmptyState.Title fontSize="15px" fontWeight="500">{title}</ChakraEmptyState.Title>
          {description && (
            <ChakraEmptyState.Description fontSize="13px" color="fg.muted" maxW="44ch">
              {description}
            </ChakraEmptyState.Description>
          )}
        </Stack>
        {action}
      </ChakraEmptyState.Content>
    </ChakraEmptyState.Root>
  );
}
