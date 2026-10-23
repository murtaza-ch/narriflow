"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Box, chakra, Flex, Stack, Text } from "@chakra-ui/react";
import { ChevronRight } from "lucide-react";
import { Logo } from "@narriflow/ui/components/logo";
import type { NavItem, NavTab } from "@/lib/docs/navigation";
import { MethodBadge } from "./method-badge";
import { DocsSearchButton } from "./search/docs-search";

/** The tab holding the page; a missing page (the 404) falls back to the section its URL names, e.g. /docs/api/…. */
export function activeTabIndex(navigation: NavTab[], pathname: string): number {
  const section = (path: string) => path.split("/")[2];
  const index = navigation.findIndex((tab) => tab.groups.some((group) => group.items.some((item) => contains(item, pathname))));
  const named = navigation.findIndex((tab) => section(tab.href) === section(pathname));
  return Math.max(0, index >= 0 ? index : named);
}

function contains(item: NavItem, pathname: string): boolean {
  return item.type === "group" ? item.items.some((child) => contains(child, pathname)) : item.href === pathname;
}

/** A sidebar row, styled like the app's NavLink: the current page is raised with a marker at the edge. */
function Row({ href, active, depth, children }: { href: string; active: boolean; depth: number; children: React.ReactNode }) {
  return (
    <Link href={href} aria-current={active ? "page" : undefined} style={{ textDecoration: "none" }}>
      <Flex
        position="relative"
        align="flex-start"
        gap="2"
        ps={depth ? "6" : "3"}
        pe="3"
        py="1.5"
        borderRadius="8px"
        fontSize="14px"
        lineHeight="1.45"
        bg={active ? "bg.panel" : "transparent"}
        color={active ? "fg" : "fg.muted"}
        fontWeight={active ? "500" : "400"}
        transition="background 120ms ease, color 120ms ease"
        _hover={{ bg: active ? "bg.panel" : "bg.soft", color: "fg" }}
        _before={
          active
            ? {
                content: '""',
                position: "absolute",
                left: "-12px",
                top: "8px",
                w: "3px",
                h: "16px",
                borderEndRadius: "3px",
                bg: "fg",
              }
            : undefined
        }
      >
        {children}
      </Flex>
    </Link>
  );
}

function Items({ items, pathname, depth }: { items: NavItem[]; pathname: string; depth: number }) {
  return (
    <Stack gap="0.5">
      {items.map((item) =>
        item.type === "group" ? (
          <Group key={item.title} item={item} pathname={pathname} depth={depth} />
        ) : (
          <Row key={item.href} href={item.href} active={item.href === pathname} depth={depth}>
            {item.type === "endpoint" ? <MethodBadge method={item.method} mt="0.5" /> : null}
            <Text as="span" minW="0">
              {item.title}
            </Text>
          </Row>
        ),
      )}
    </Stack>
  );
}

/** A collapsible nested group (an API tag); it opens when it holds the current page. */
function Group({ item, pathname, depth }: { item: Extract<NavItem, { type: "group" }>; pathname: string; depth: number }) {
  const holdsCurrent = contains(item, pathname);
  const [open, setOpen] = useState(holdsCurrent);
  const expanded = open || holdsCurrent;
  return (
    <Box>
      <chakra.button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
        display="flex"
        alignItems="center"
        justifyContent="space-between"
        w="full"
        ps={depth ? "6" : "3"}
        pe="3"
        py="1.5"
        borderRadius="8px"
        fontSize="14px"
        color={holdsCurrent ? "fg" : "fg.muted"}
        cursor="pointer"
        transition="background 120ms ease, color 120ms ease"
        _hover={{ bg: "bg.soft", color: "fg" }}
      >
        {item.title}
        <Box as="span" color="fg.subtle" transform={expanded ? "rotate(90deg)" : undefined} transition="transform 150ms ease">
          <ChevronRight size={14} />
        </Box>
      </chakra.button>
      {expanded ? (
        <Box mt="0.5">
          <Items items={item.items} pathname={pathname} depth={depth + 1} />
        </Box>
      ) : null}
    </Box>
  );
}

/** A tab's pages, grouped under quiet labels: the current tab's unless `tab` picks another. */
export function DocsTree({ navigation, tab: picked }: { navigation: NavTab[]; tab?: number }) {
  const pathname = usePathname();
  const tab = navigation[picked ?? activeTabIndex(navigation, pathname)];
  return (
    <Stack as="nav" aria-label="Docs" gap="5">
      {tab?.groups.map((group) => (
        <Box key={group.title}>
          <Text textStyle="eyebrow" color="fg.subtle" px="3" pb="2">
            {group.title}
          </Text>
          <Items items={group.items} pathname={pathname} depth={0} />
        </Box>
      ))}
    </Stack>
  );
}

/** Desktop sidebar on the shell frame: logo, search, then the page tree. */
export function DocsSidebar({ navigation }: { navigation: NavTab[] }) {
  return (
    <Flex
      as="aside"
      w="272px"
      h="100dvh"
      position="fixed"
      top="0"
      left="0"
      zIndex="30"
      direction="column"
      bg="bg.sidebar"
      display={{ base: "none", lg: "flex" }}
    >
      <Flex h="64px" flexShrink={0} align="center" gap="2.5" px="5">
        <Link href="/docs" aria-label="Narriflow docs home">
          <Logo size="md" />
        </Link>
        <Text as="span" fontSize="12px" fontWeight="500" color="fg.muted" bg="bg.soft" px="2" py="0.5" borderRadius="6px">
          Docs
        </Text>
      </Flex>
      <Box px="3" pb="4" flexShrink={0}>
        <DocsSearchButton />
      </Box>
      <Box
        flex="1"
        overflowY="auto"
        px="3"
        pb="8"
        css={{
          scrollbarWidth: "thin",
          scrollbarColor: "transparent transparent",
          "&:hover": { scrollbarColor: "var(--chakra-colors-border) transparent" },
        }}
      >
        <DocsTree navigation={navigation} />
      </Box>
    </Flex>
  );
}
