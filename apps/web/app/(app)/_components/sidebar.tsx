"use client";

import Link from "next/link";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { CircleHelp, Plus, Sparkles, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Logo } from "@narriflow/ui/components/logo";
import { NavLink } from "@narriflow/ui/components/nav-link";
import { Meter } from "@narriflow/ui/components/meter";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { Fragment } from "react";
import { NAV_ITEMS } from "./nav-items";
import { usagePalette } from "./usage-palette";
import { WorkspaceSwitcher, type WorkspaceMenuPresentation, type WorkspaceSwitcherItem } from "./workspace-switcher";

interface SidebarProps {
  remainingCredits: number;
  limitCredits: number;
  activeWorkspaceId: string;
  workspaces: WorkspaceSwitcherItem[];
  canCreate: boolean;
  canCreateWorkspace: boolean;
  workspaceMenu: WorkspaceMenuPresentation;
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({
  remainingCredits,
  limitCredits,
  collapsed,
  onToggle,
  activeWorkspaceId,
  workspaces,
  canCreate,
  canCreateWorkspace,
  workspaceMenu,
}: SidebarProps) {
  const usagePct = limitCredits > 0 ? Math.min(100, ((limitCredits - remainingCredits) / limitCredits) * 100) : 0;
  const palette = usagePalette(usagePct);

  return (
    <Flex
      as="aside"
      w={collapsed ? "68px" : "256px"}
      bg="bg.sidebar"
      h="100dvh"
      position="fixed"
      top="0"
      left="0"
      display={{ base: "none", lg: "flex" }}
      direction="column"
      zIndex="30"
    >
      {/* Logo — centred on the panel header beside it */}
      <Flex
        h="80px"
        css={{ "@media (max-height: 800px)": { height: "64px" } }}
        align="center"
        px="5"
        justify="space-between"
        flexShrink={0}
      >
        {!collapsed && <Link href="/home" aria-label="Narriflow home">
          <Logo size="md" />
        </Link>}
        <IconButton variant="ghost" size="sm" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={onToggle}>{collapsed ? <PanelLeftOpen size={17}/> : <PanelLeftClose size={17}/>}</IconButton>
      </Flex>

      {!collapsed && <WorkspaceSwitcher activeWorkspaceId={activeWorkspaceId} items={workspaces} presentation={workspaceMenu} canCreateWorkspace={canCreateWorkspace} />}

      {/* Navigation — single IA source */}
      <Stack as="nav" flex="1" px="3" py="4" gap="0.5" overflowY="auto" css={{ scrollbarWidth: "thin", scrollbarColor: "transparent transparent", "&:hover": { scrollbarColor: "var(--chakra-colors-border) transparent" }, "@media (max-height: 800px)": { paddingBlock: "8px", gap: 0 } }}>
        {canCreate ? (
          <Button asChild size="sm" mb="4" w="full" justifyContent={collapsed ? "center" : "flex-start"}>
            <Link href="/upload" aria-label="New project"><Plus size={15} />{!collapsed && "New project"}</Link>
          </Button>
        ) : null}
        {NAV_ITEMS.map(({ label, href, icon: Icon }) => (
          <Fragment key={href}>
          {href === "/autopilot" && !collapsed && <Text textStyle="eyebrow" color="fg.muted" px="3" pt="5" pb="2">Workspace</Text>}
          <NavLink collapsed={collapsed} href={href} icon={<Icon size={17} />}>
            {label}
          </NavLink>
          </Fragment>
        ))}
        <Box flex="1" minH="2" />
        <NavLink collapsed={collapsed} href="/whats-new" icon={<Sparkles size={16} />}>What&apos;s new</NavLink>
        <NavLink collapsed={collapsed} href="/help" icon={<CircleHelp size={16} />}>Tutorials &amp; help</NavLink>
      </Stack>

      {/* Usage mini-meter */}
      {!collapsed && <Box px="3" pb="4" flexShrink={0}>
        <Box px="3" pt="1">
          <Flex align="baseline" justify="space-between" gap="2" mb="1.5">
            <Text textStyle="eyebrow" color="fg.muted" whiteSpace="nowrap">
              Credits
            </Text>
            <Text
              whiteSpace="nowrap"
              fontSize="12px"
              fontVariantNumeric="tabular-nums"
              color={palette === "accent" ? "fg.muted" : `${palette}.fg`}
            >
              {remainingCredits.toLocaleString()} of {limitCredits.toLocaleString()} left
            </Text>
          </Flex>
          <Meter
            value={usagePct}
            palette={palette}
            showValue={false}
            aria-label="Monthly credits used"
          />
        </Box>
      </Box>}
    </Flex>
  );
}
