"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Box, chakra, Portal, Text, Tooltip as ChakraTooltip } from "@chakra-ui/react";
import { ChevronRight } from "lucide-react";

export interface TooltipProps {
  tip: string;
  headline?: string;
  cta?: string;
  href?: string;
  children?: ReactNode;
}

/** `<Tooltip tip>`: a dotted underline on the trigger; the card opens on hover or focus and stays open while hovered, so its link is reachable. */
export function Tooltip({ tip, headline, cta, href, children }: TooltipProps) {
  return (
    <ChakraTooltip.Root openDelay={150} closeDelay={100} interactive positioning={{ placement: "top" }}>
      <ChakraTooltip.Trigger asChild>
        <chakra.span tabIndex={0} cursor="help" textDecoration="underline" textDecorationStyle="dotted" textDecorationThickness="2px" textUnderlineOffset="4px" textDecorationColor="var(--chakra-colors-fg-subtle)">
          {children}
        </chakra.span>
      </ChakraTooltip.Trigger>
      <Portal>
        <ChakraTooltip.Positioner>
          <ChakraTooltip.Content bg="bg.raised" color="fg" borderWidth="1px" borderColor="border.card" borderRadius="12px" boxShadow="none" maxW="64" px="3.5" py="3">
            <Box display="grid" gap="1">
              {headline ? (
                <Text fontSize="13px" fontWeight="600" lineHeight="1.4">
                  {headline}
                </Text>
              ) : null}
              <Text fontSize="13px" lineHeight="1.5" color="fg.muted">
                {tip}
              </Text>
              {cta && href ? (
                <chakra.span asChild display="inline-flex" alignItems="center" gap="0.5" mt="1" fontSize="13px" fontWeight="500" color="accent.fg">
                  <Link href={href}>
                    {cta}
                    <ChevronRight size={14} aria-hidden="true" />
                  </Link>
                </chakra.span>
              ) : null}
            </Box>
          </ChakraTooltip.Content>
        </ChakraTooltip.Positioner>
      </Portal>
    </ChakraTooltip.Root>
  );
}
