import type { ComponentProps, ReactNode } from "react";
import { Box, Text } from "@chakra-ui/react";

/** Inline code on the soft fill. */
export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <Box as="code" px="1.5" py="0.5" bg="bg.soft" borderRadius="4px" fontFamily="mono" fontSize="0.9em" color="fg">
      {children}
    </Box>
  );
}

/** A soft chip: a field's type, default or flag. */
export function Chip({ children, ...rest }: { children: ReactNode } & ComponentProps<typeof Text>) {
  return (
    <Text as="span" px="2" py="0.5" bg="bg.soft" borderRadius="6px" fontFamily="mono" fontSize="12px" lineHeight="1.4" color="fg.muted" overflowWrap="anywhere" {...rest}>
      {children}
    </Text>
  );
}

