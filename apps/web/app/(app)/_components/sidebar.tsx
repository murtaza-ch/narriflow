"use client";

import Link from "next/link";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { CircleHelp, Plus, Sparkles, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Logo } from "@narriflow/ui/components/logo";
import { NavLink } from "@narriflow/ui/components/nav-link";
import { Meter } from "@narriflow/ui/components/meter";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { AccountMenu } from "./account-menu";
import { Fragment } from "react";
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
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({
  email, firstName, lastName, imageUrl,
  usedMinutes,
  limitMinutes,
  collapsed,
  onToggle,
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
      w={collapsed ? "68px" : "232px"}
      bg="bg.sidebar"
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

      {!collapsed && <WorkspaceSwitcher activeWorkspaceId={activeWorkspaceId} items={workspaces} canCreateWorkspace={canCreateWorkspace} />}

      {/* Navigation — single IA source */}
      <Stack as="nav" flex="1" px="3" py="4" gap="0.5" overflowY="auto" css={{ scrollbarWidth: "thin", scrollbarColor: "transparent transparent", "&:hover": { scrollbarColor: "var(--chakra-colors-border) transparent" }, "@media (max-height: 800px)": { paddingBlock: "8px", gap: 0 } }}>
        {canCreate ? (
          <Button asChild size="sm" mb="4" w="full" justifyContent={collapsed ? "center" : "flex-start"}>
            <Link href="/upload" aria-label="New project"><Plus size={15} />{!collapsed && "New project"}</Link>
          </Button>
        ) : null}
        {NAV_ITEMS.map(({ label, href, icon: Icon }) => (
          <Fragment key={href}>
          {href === "/autopilot" && !collapsed && <Text fontSize="10px" color="fg.subtle" px="3" pt="5" pb="2">Workspace</Text>}
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
      {!collapsed && <Box px="3" py="3" borderTopWidth="1px" borderColor="border.subtle" flexShrink={0}>
        <Box px="2.5" pt="1" pb="3">
          <Flex align="baseline" justify="space-between" gap="3" mb="1.5">
            <Text textStyle="eyebrow" color="fg.subtle">
              Monthly minutes
            </Text>
            <Text
              textStyle="data"
              fontSize="11px"
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
      </Box>}
      <Box px="3" pb="3"><AccountMenu email={email} firstName={firstName} lastName={lastName} imageUrl={imageUrl} variant={collapsed ? "avatar" : "row"} /></Box>
    </Flex>
  );
}
