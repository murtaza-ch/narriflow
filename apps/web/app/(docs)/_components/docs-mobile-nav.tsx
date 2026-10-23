"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Box, Drawer, Flex, Portal, Text } from "@chakra-ui/react";
import { Menu as MenuIcon, Moon, Sun, X } from "lucide-react";
import { MobileAccountActions } from "@/app/(marketing)/_components/account-actions";
import { IconButton } from "@narriflow/ui/components/button";
import { useColorMode } from "@narriflow/ui/components/color-mode";
import { Logo } from "@narriflow/ui/components/logo";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import type { NavTab } from "@/lib/docs/navigation";
import { activeTabIndex, DocsTree } from "./docs-sidebar";
import { DocsSearchButton } from "./search/docs-search";

function DocsMark() {
  return (
    <Link href="/docs" aria-label="Narriflow docs home">
      <Flex align="center" gap="2.5">
        <Logo size="sm" />
        <Text as="span" fontSize="12px" fontWeight="500" color="fg.muted" bg="bg.soft" px="2" py="0.5" borderRadius="6px">
          Docs
        </Text>
      </Flex>
    </Link>
  );
}

function ThemeRow() {
  const { colorMode, toggleColorMode } = useColorMode();
  return (
    <Flex
      as="button"
      onClick={toggleColorMode}
      align="center"
      gap="2.5"
      px="3"
      py="2"
      borderRadius="8px"
      fontSize="14px"
      color="fg.muted"
      cursor="pointer"
      transition="background 120ms ease, color 120ms ease"
      _hover={{ bg: "bg.soft", color: "fg" }}
    >
      {colorMode === "light" ? <Moon size={16} /> : <Sun size={16} />}
      {colorMode === "light" ? "Dark mode" : "Light mode"}
    </Flex>
  );
}

/**
 * Below lg the sidebar and panel header give way to a top bar and a drawer
 * (the app's mobile nav pattern). The drawer's sections preview a tab's pages
 * without leaving the current one; choosing a page closes it.
 */
export function DocsMobileNav({ navigation }: { navigation: NavTab[] }) {
  const pathname = usePathname();
  const active = activeTabIndex(navigation, pathname);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(active);

  // The drawer also closes when the route changes without a tap on a link (back, forward).
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is an intentional route-change trigger.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <Box display={{ base: "block", lg: "none" }}>
      <Drawer.Root
        open={open}
        onOpenChange={({ open: next }) => {
          setOpen(next);
          setTab(active);
        }}
        placement="start"
      >
        <Flex
          as="header"
          h="48px"
          align="center"
          justify="space-between"
          gap="2"
          px="4"
          bg="bg/85"
          backdropFilter="blur(12px)"
          position="fixed"
          top="0"
          left="0"
          right="0"
          zIndex="40"
        >
          <DocsMark />
          <Flex align="center" gap="1">
            <DocsSearchButton variant="compact" />
            <Drawer.Trigger asChild>
              <IconButton variant="ghost" size="sm" aria-label="Open menu">
                <MenuIcon size={20} />
              </IconButton>
            </Drawer.Trigger>
          </Flex>
        </Flex>

        <Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            {/* A tap on any link inside, even the current page's, ends the visit to the drawer. */}
            <Drawer.Content maxW="320px" display="flex" flexDirection="column" onClick={(event) => (event.target as HTMLElement).closest("a") && setOpen(false)}>
              <Flex h="48px" align="center" justify="space-between" px="4" flexShrink={0}>
                <DocsMark />
                <Drawer.CloseTrigger asChild>
                  <IconButton variant="ghost" size="sm" borderRadius="full" aria-label="Close menu">
                    <X size={18} />
                  </IconButton>
                </Drawer.CloseTrigger>
              </Flex>
              <Box px="3" pt="2" pb="3" flexShrink={0}>
                <SegmentedControl
                  aria-label="Docs sections"
                  w="full"
                  items={navigation.map((section, index) => ({ label: section.title, value: String(index) }))}
                  value={String(tab)}
                  onValueChange={(value) => setTab(Number(value))}
                />
              </Box>
              <Box flex="1" overflowY="auto" px="3" pb="4">
                <DocsTree navigation={navigation} tab={tab} />
              </Box>
              <Flex direction="column" gap="2" px="3" py="4" flexShrink={0}>
                <ThemeRow />
                <MobileAccountActions />
              </Flex>
            </Drawer.Content>
          </Drawer.Positioner>
        </Portal>
      </Drawer.Root>
    </Box>
  );
}
