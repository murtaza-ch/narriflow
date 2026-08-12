"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { Box, Flex } from "@chakra-ui/react";
import { Gauge, UserPlus } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Sidebar } from "./sidebar";
import { MobileNav } from "./mobile-nav";
import { AccountMenu } from "./account-menu";
import { ThemeToggle } from "./theme-toggle";
import { GlobalSearch } from "./global-search";
import type { WorkspaceSwitcherItem } from "./workspace-switcher";

interface AppChromeProps {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  usedMinutes: number;
  limitMinutes: number;
  activeWorkspaceId: string;
  workspaceRole: "owner" | "admin" | "editor" | "viewer";
  workspaceStatus: "active" | "pending_payment" | "restricted";
  workspaceTier: "free" | "creator" | "pro" | "business";
  workspaces: WorkspaceSwitcherItem[];
  canCreateWorkspace: boolean;
  children: React.ReactNode;
}

/** Slim top bar (desktop only) — theme toggle + account menu. Present in
 *  both the normal shell and the /upload funnel: it isn't workspace nav
 *  chrome (that's the Sidebar/MobileNav), so there's no reason to hide it
 *  along with those. */
function DesktopTopBar({
  email,
  firstName,
  lastName,
  imageUrl,
  usedMinutes,
  limitMinutes,
  workspaceRole,
  workspaceStatus,
  workspaceTier,
  activeWorkspaceId,
}: Pick<AppChromeProps, "email" | "firstName" | "lastName" | "imageUrl" | "usedMinutes" | "limitMinutes" | "workspaceRole" | "workspaceStatus" | "workspaceTier" | "activeWorkspaceId">) {
  const canInvite = workspaceStatus === "active" && workspaceTier === "business" && (workspaceRole === "owner" || workspaceRole === "admin");
  return (
    <Flex
      h="48px"
      align="center"
      justify="space-between"
      gap="2"
      px="6"
      borderBottomWidth="1px"
      borderColor="border.subtle"
      display={{ base: "none", lg: "flex" }}
      flexShrink={0}
    >
      <GlobalSearch workspaceId={activeWorkspaceId} />
      <Flex align="center" gap="2">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/settings/usage"><Gauge size={14} />{Math.round(usedMinutes)}/{Math.round(limitMinutes)} min</Link>
        </Button>
        {canInvite ? (
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings/members"><UserPlus size={14} />Invite</Link>
          </Button>
        ) : null}
        {workspaceStatus === "pending_payment" && workspaceRole === "owner" ? (
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings/subscription">Complete setup</Link>
          </Button>
        ) : workspaceTier !== "business" ? (
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings/subscription">Upgrade</Link>
          </Button>
        ) : null}
        <ThemeToggle />
        <AccountMenu email={email} firstName={firstName} imageUrl={imageUrl} lastName={lastName} />
      </Flex>
    </Flex>
  );
}

function FocusedTopBar({
  email,
  firstName,
  lastName,
  imageUrl,
}: Pick<AppChromeProps, "email" | "firstName" | "lastName" | "imageUrl">) {
  return (
    <Flex
      h="48px"
      align="center"
      justify="flex-end"
      gap="2"
      px={{ base: "4", md: "8" }}
      borderBottomWidth="1px"
      borderColor="border.subtle"
      flexShrink={0}
    >
      <ThemeToggle />
      <AccountMenu
        email={email}
        firstName={firstName}
        imageUrl={imageUrl}
        lastName={lastName}
      />
    </Flex>
  );
}

/**
 * Owns the pathname-based split between the normal app shell (fixed
 * sidebar + its 240px content offset + mobile nav bar) and the /upload
 * funnel, which is a focused, Vizard-style flow with no nav chrome — the
 * upload page renders its own back link + usage line in place of the
 * sidebar.
 *
 * This used to be a `usePathname` early-return inside Sidebar itself, which
 * only hid the sidebar's own markup: AppLayout's `ml`/`pt` content offset
 * and the always-mounted MobileNav bar stayed in place regardless, leaving
 * the funnel visibly off-center on desktop with a dead mobile top bar
 * underneath. Pulling the pathname check up into this one client wrapper
 * lets AppLayout stay a server component while every piece (offset, mobile
 * nav, sidebar) reacts to the same route check together.
 */
export function AppChrome({
  email,
  firstName,
  lastName,
  imageUrl,
  usedMinutes,
  limitMinutes,
  activeWorkspaceId,
  workspaceRole,
  workspaceStatus,
  workspaceTier,
  workspaces,
  canCreateWorkspace,
  children,
}: AppChromeProps) {
  const pathname = usePathname();
  const isUploadFunnel = pathname?.startsWith("/upload") ?? false;
  // An open project is a focused Vizard-style workspace too: no sidebar, the
  // page renders its own back-arrow bar. The /projects LIST keeps the normal
  // shell; the Studio route is a fixed overlay and never sees this chrome.
  const isProjectWorkspace = /^\/projects\/[^/]+/.test(pathname ?? "");

  if (isUploadFunnel) {
    return (
      <Flex direction="column" minH="100dvh">
        <FocusedTopBar
          email={email}
          firstName={firstName}
          lastName={lastName}
          imageUrl={imageUrl}
        />
        <Box as="main" flex="1" w="full" px={{ base: "4", md: "8" }} py={{ base: "6", md: "8" }}>
          {children}
        </Box>
      </Flex>
    );
  }

  if (isProjectWorkspace) {
    return (
      <Flex direction="column" minH="100dvh">
        <DesktopTopBar
          email={email}
          firstName={firstName}
          lastName={lastName}
          imageUrl={imageUrl}
          usedMinutes={usedMinutes}
          limitMinutes={limitMinutes}
          workspaceRole={workspaceRole}
          workspaceStatus={workspaceStatus}
          workspaceTier={workspaceTier}
          activeWorkspaceId={activeWorkspaceId}
        />
        <Box as="main" flex="1" w="full" px={{ base: "4", md: "8" }} py={{ base: "6", md: "8" }}>
          {children}
        </Box>
      </Flex>
    );
  }

  return (
    <>
      {/* Desktop sidebar — separated from content by a single hairline */}
      <Sidebar
        email={email}
        firstName={firstName}
        imageUrl={imageUrl}
        lastName={lastName}
        usedMinutes={usedMinutes}
        limitMinutes={limitMinutes}
        activeWorkspaceId={activeWorkspaceId}
        workspaces={workspaces}
        canCreate={workspaceRole !== "viewer" && workspaceStatus === "active"}
        canCreateWorkspace={canCreateWorkspace}
      />

      {/* Mobile nav */}
      <MobileNav
        email={email}
        firstName={firstName}
        imageUrl={imageUrl}
        lastName={lastName}
        usedMinutes={usedMinutes}
        limitMinutes={limitMinutes}
        activeWorkspaceId={activeWorkspaceId}
        workspaces={workspaces}
        canCreate={workspaceRole !== "viewer" && workspaceStatus === "active"}
        canCreateWorkspace={canCreateWorkspace}
      />

      {/* Content region — flat porcelain ground */}
      <Flex
        direction="column"
        ml={{ base: "0", lg: "240px" }}
        pt={{ base: "48px", lg: "0" }}
        minH="100dvh"
      >
        {/* Slim top bar (desktop) — the page below owns its PageHeader */}
        <DesktopTopBar
          email={email}
          firstName={firstName}
          lastName={lastName}
          imageUrl={imageUrl}
          usedMinutes={usedMinutes}
          limitMinutes={limitMinutes}
          workspaceRole={workspaceRole}
          workspaceStatus={workspaceStatus}
          workspaceTier={workspaceTier}
          activeWorkspaceId={activeWorkspaceId}
        />

        {/* Page content */}
        <Box as="main" flex="1" w="full" px={{ base: "4", md: "8" }} py={{ base: "6", md: "8" }}>
          {children}
        </Box>
      </Flex>
    </>
  );
}
