"use client";

import Link from "next/link";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { CircleHelp, Plus, Sparkles } from "lucide-react";
import { Logo } from "@narriflow/ui/components/logo";
import { NavLink } from "@narriflow/ui/components/nav-link";
import { Meter } from "@narriflow/ui/components/meter";
import { Button } from "@narriflow/ui/components/button";
import { NAV_ITEMS } from "./nav-items";
import { usagePalette } from "./usage-palette";
import { WorkspaceSwitcher, type WorkspaceSwitcherItem } from "./workspace-switcher";

interface SidebarProps {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  usedMinutes: number;
  limitMinutes: number;
  activeWorkspaceId: string;
  workspaces: WorkspaceSwitcherItem[];
  canCreate: boolean;
  canCreateWorkspace: boolean;
}

export function Sidebar({
  usedMinutes,
  limitMinutes,
  activeWorkspaceId,
  workspaces,
  canCreate,
  canCreateWorkspace,
}: SidebarProps) {
  const usagePct = limitMinutes > 0 ? Math.min(100, (usedMinutes / limitMinutes) * 100) : 0;
  const palette = usagePalette(usagePct);

  return (
    <Flex
      as="aside"
      w="240px"
      h="100dvh"
      position="fixed"
      top="0"
      left="0"
      display={{ base: "none", lg: "flex" }}
      direction="column"
      borderRightWidth="1px"
      borderColor="border"
      zIndex="30"
    >
      {/* Logo — hairline aligns with the content top bar */}
      <Flex
        h="48px"
        align="center"
        px="5"
        flexShrink={0}
        borderBottomWidth="1px"
        borderColor="border.subtle"
      >
        <Link href="/home" aria-label="Narriflow home">
          <Logo size="md" />
        </Link>
      </Flex>

      <WorkspaceSwitcher activeWorkspaceId={activeWorkspaceId} items={workspaces} canCreateWorkspace={canCreateWorkspace} />

      {/* Navigation — single IA source */}
      <Stack as="nav" flex="1" px="3" py="4" gap="0.5" overflowY="auto">
        {canCreate ? (
          <Button asChild size="sm" mb="3" w="full">
            <Link href="/upload"><Plus size={15} />New project</Link>
          </Button>
        ) : null}
        {NAV_ITEMS.map(({ label, href, icon: Icon }) => (
          <NavLink key={href} href={href} icon={<Icon size={16} />}>
            {label}
          </NavLink>
        ))}
        <Box flex="1" minH="6" />
        <NavLink href="/whats-new" icon={<Sparkles size={16} />}>What&apos;s new</NavLink>
        <NavLink href="/help" icon={<CircleHelp size={16} />}>Tutorials &amp; help</NavLink>
      </Stack>

      {/* Usage mini-meter */}
      <Box px="3" py="3" borderTopWidth="1px" borderColor="border.subtle" flexShrink={0}>
        <Box px="2.5" pt="1" pb="3">
          <Flex align="baseline" justify="space-between" gap="3" mb="1.5">
            <Text textStyle="eyebrow" color="fg.subtle">
              Usage
            </Text>
            <Text
              textStyle="data"
              fontSize="12px"
              color={palette === "accent" ? "fg.muted" : `${palette}.fg`}
            >
              {Math.round(usedMinutes)}/{Math.round(limitMinutes)} min
            </Text>
          </Flex>
          <Meter
            value={usagePct}
            palette={palette}
            showValue={false}
            aria-label="Monthly processing minutes used"
          />
        </Box>
      </Box>
    </Flex>
  );
}
