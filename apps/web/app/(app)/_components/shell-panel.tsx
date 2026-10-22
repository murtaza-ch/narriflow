"use client";

import { Fragment, type ReactNode } from "react";
import { Flex, type FlexProps, Text } from "@chakra-ui/react";

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
 * The panel's header: a breadcrumb on the left (earlier crumbs muted, the
 * current page in fg) and the actions on the right. No divider below it.
 */
export function ShellHeader({
  crumbs,
  start,
  children,
  ...rest
}: { crumbs?: readonly string[]; start?: ReactNode; children?: ReactNode } & FlexProps) {
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
        {crumbs?.length ? (
          <Flex as="nav" aria-label="Breadcrumb" align="center" gap="2" minW="0" fontSize="14px">
            {crumbs.map((crumb, index) => {
              const current = index === crumbs.length - 1;
              return (
                <Fragment key={crumb}>
                  {index > 0 ? (
                    <Text as="span" color="fg.subtle" aria-hidden="true">
                      /
                    </Text>
                  ) : null}
                  <Text
                    as="span"
                    color={current ? "fg" : "fg.muted"}
                    fontWeight={current ? "500" : "400"}
                    truncate
                    aria-current={current ? "page" : undefined}
                  >
                    {crumb}
                  </Text>
                </Fragment>
              );
            })}
          </Flex>
        ) : null}
      </Flex>
      <Flex align="center" gap="2" flexShrink={0}>
        {children}
      </Flex>
    </Flex>
  );
}
