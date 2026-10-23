"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, useState } from "react";
import { Box, Flex } from "@chakra-ui/react";
import { BookOpen, Code, type LucideIcon, Sparkles } from "lucide-react";
import { HeaderAccountActions } from "@/app/(marketing)/_components/account-actions";
import { ThemeToggle } from "@/app/(app)/_components/theme-toggle";
import type { NavTab } from "@/lib/docs/navigation";
import { activeTabIndex } from "./docs-sidebar";

const ICONS: Record<string, LucideIcon> = { "book-open": BookOpen, sparkles: Sparkles, code: Code };

/** The docs sections as the app's segmented control, its raised chip sliding to the current one. */
function SectionTabs({ navigation }: { navigation: NavTab[] }) {
  const active = activeTabIndex(navigation, usePathname());
  const links = useRef<Array<HTMLAnchorElement | null>>([]);
  const [chip, setChip] = useState<{ left: number; width: number }>();

  useLayoutEffect(() => {
    const link = links.current[active];
    if (!link) return;
    const measure = () => setChip({ left: link.offsetLeft, width: link.offsetWidth });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(link);
    return () => observer.disconnect();
  }, [active]);

  return (
    <Flex as="nav" aria-label="Docs sections" position="relative" h="9" p="0.5" bg="bg.soft" borderRadius="control" flexShrink={0}>
      {chip ? (
        <Box
          aria-hidden="true"
          position="absolute"
          top="0.5"
          bottom="0.5"
          left="0"
          borderRadius="8px"
          bg={{ _light: "white", _dark: "rgba(255, 255, 255, 0.12)" }}
          boxShadow={{ _light: "0 1px 2px rgba(16, 19, 24, 0.12)", _dark: "none" }}
          transition="translate 300ms cubic-bezier(0.22, 1, 0.36, 1), width 300ms cubic-bezier(0.22, 1, 0.36, 1)"
          style={{ translate: `${chip.left}px 0`, width: chip.width }}
        />
      ) : null}
      {navigation.map((tab, index) => {
        const Icon = ICONS[tab.icon];
        const current = index === active;
        return (
          <Link
            key={tab.title}
            ref={(node) => {
              links.current[index] = node;
            }}
            href={tab.href}
            aria-current={current ? "location" : undefined}
            style={{ textDecoration: "none", position: "relative" }}
          >
            <Flex
              h="full"
              align="center"
              gap="1.5"
              px="3"
              borderRadius="8px"
              fontSize="13px"
              fontWeight="500"
              whiteSpace="nowrap"
              color={current ? "fg" : "fg.muted"}
              _hover={{ color: "fg" }}
              transition="color 120ms ease"
            >
              {Icon ? <Icon size={14} /> : null}
              {tab.title}
            </Flex>
          </Link>
        );
      })}
    </Flex>
  );
}

/** The panel header: section tabs on the left, account and theme on the right. No divider. Below lg the mobile bar and its drawer carry all of this. */
export function DocsHeader({ navigation }: { navigation: NavTab[] }) {
  return (
    <Flex as="header" h="64px" flexShrink={0} align="center" justify="space-between" gap="4" px="6" display={{ base: "none", lg: "flex" }}>
      <SectionTabs navigation={navigation} />
      <Flex align="center" gap="2">
        <HeaderAccountActions />
        <ThemeToggle />
      </Flex>
    </Flex>
  );
}
