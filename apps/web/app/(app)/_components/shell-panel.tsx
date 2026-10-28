"use client";

import type { ReactNode } from "react";
import { Flex, type FlexProps } from "@chakra-ui/react";

/**
 * The app shell's content sheet. On desktop it sits inset from the darker
 * frame (bg.sidebar) as one rounded panel — the fill alone separates it, no
 * border; on mobile it is full-bleed.
 */
export function ShellPanel({ children, ...rest }: FlexProps) {
  return (
    <Flex
      direction="column"
      flex="1"
      minW="0"
      bg="bg"
      borderRadius={{ base: "0", lg: "14px" }}
      {...rest}
    >
      {children}
    </Flex>
  );
}

/**
 * The panel's header: an optional leading slot (menu, back, logo) on the left
 * and the actions on the right. No divider below it.
 */
export function ShellHeader({
  start,
  children,
  ...rest
}: { start?: ReactNode; children?: ReactNode } & FlexProps) {
  return (
    <Flex
      as="header"
      h="64px"
      flexShrink={0}
      align="center"
      justify="space-between"
      gap="3"
      px={{ base: "4", lg: "6" }}
      {...rest}
    >
      <Flex align="center" gap="2" minW="0">
        {start}
      </Flex>
      <Flex align="center" gap="2" flexShrink={0}>
        {children}
      </Flex>
    </Flex>
  );
}
