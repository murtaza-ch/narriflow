"use client";

import Link from "next/link";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { CircleHelp, Plus, Sparkles, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Logo } from "@narriflow/ui/components/logo";
import { NavLink } from "@narriflow/ui/components/nav-link";
import { Meter } from "@narriflow/ui/components/meter";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { Bone, LineBone } from "@narriflow/ui/components/page-loading";
import { chromeVar } from "@/lib/chrome-layout-hint";
import { Fragment } from "react";
import { NAV_ITEMS } from "./nav-items";
import { hasFeature } from "@narriflow/validators";
import { usagePalette } from "./usage-palette";
import { UpgradeGem } from "./upgrade";
import { WorkspaceSwitcher, WorkspaceSwitcherPlaceholder, type WorkspaceMenuPresentation, type WorkspaceSwitcherItem } from "./workspace-switcher";
import { useNavIntent } from "./route-reads";

/** What the sidebar shows of the open Workspace; null while it opens. */
export interface SidebarWorkspace {
  remainingCredits: number;
  limitCredits: number;
  activeWorkspaceId: string;
  workspaces: WorkspaceSwitcherItem[];
  canCreate: boolean;
  workspaceMenu: WorkspaceMenuPresentation;
}

interface SidebarProps {
  workspace: SidebarWorkspace | null;
  collapsed: boolean;
  onToggle: () => void;
}

/**
 * Static parts (logo, nav links, the collapse button) are real from the first
 * byte; the switcher, "New project" and the credits meter hold their final box
 * until the Workspace is open. "New project" is assumed present while pending
 * (the common case) and collapses once for a person who cannot create.
 */
export function Sidebar({ workspace, collapsed, onToggle }: SidebarProps) {
  const intent = useNavIntent();
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

      {collapsed ? null : workspace ? (
        <WorkspaceSwitcher activeWorkspaceId={workspace.activeWorkspaceId} items={workspace.workspaces} presentation={workspace.workspaceMenu} />
      ) : (
        <WorkspaceSwitcherPlaceholder />
      )}

      {/* Navigation — single IA source */}
      <Stack as="nav" flex="1" px="3" py="4" gap="0.5" overflowY="auto" css={{ scrollbarWidth: "thin", scrollbarColor: "transparent transparent", "&:hover": { scrollbarColor: "var(--chakra-colors-border) transparent" }, "@media (max-height: 800px)": { paddingBlock: "8px", gap: 0 } }}>
        {!workspace ? (
          <Bone h="9" w="full" mb="4" borderRadius="control" flexShrink={0} display={chromeVar("newProjectDisplay", "block")} aria-hidden />
        ) : workspace.canCreate ? (
          <Button asChild size="sm" mb="4" w="full" justifyContent={collapsed ? "center" : "flex-start"}>
            <Link href="/upload" aria-label="New project"><Plus size={15} />{!collapsed && "New project"}</Link>
          </Button>
        ) : null}
        {NAV_ITEMS.map(({ label, href, icon: Icon, feature }) => (
          <Fragment key={href}>
          {href === "/autopilot" && !collapsed && <Text textStyle="eyebrow" color="fg.muted" px="3" pt="5" pb="2">Workspace</Text>}
          <NavLink collapsed={collapsed} href={href} intent={intent(href)} icon={<Icon size={17} />} badge={workspace && feature && !hasFeature(workspace.workspaceMenu.tier, feature) ? <UpgradeGem /> : undefined}>
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
        {workspace ? <CreditsMeter remainingCredits={workspace.remainingCredits} limitCredits={workspace.limitCredits} /> : <CreditsMeterPlaceholder />}
      </Box>}
    </Flex>
  );
}

function CreditsMeter({ remainingCredits, limitCredits }: { remainingCredits: number; limitCredits: number }) {
  const usagePct = limitCredits > 0 ? Math.min(100, ((limitCredits - remainingCredits) / limitCredits) * 100) : 0;
  const palette = usagePalette(usagePct);
  return (
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
      <Meter value={usagePct} palette={palette} showValue={false} aria-label="Monthly credits used" />
    </Box>
  );
}

/** The meter's label row and 3px track, with the amounts unknown. */
function CreditsMeterPlaceholder() {
  return (
    <Box px="3" pt="1" aria-hidden>
      <Flex align="baseline" justify="space-between" gap="2" mb="1.5">
        <Text textStyle="eyebrow" color="fg.muted" whiteSpace="nowrap">
          Credits
        </Text>
        {/* About "0,000 of 0,000 left" at 12px in tabular figures. */}
        <LineBone fontSize="12px" fontVariantNumeric="tabular-nums" boneWidth="14ch" w="14ch" />
      </Flex>
      <Bone h="3px" w="full" borderRadius="full" />
    </Box>
  );
}
