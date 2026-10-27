"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import Link from "next/link";
import { Box, Flex, Text } from "@chakra-ui/react";
import { UserPlus } from "lucide-react";
import { hasFeature, lowestTierWithFeature, planUpgradeHighlight } from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";
import { Logo } from "@narriflow/ui/components/logo";
import { SettingsChrome } from "./settings-chrome";
import { useSettingsReturn } from "./use-settings-return";
import { isSettingsPath } from "@/lib/settings-return";
import { ProjectWorkspace } from "./project-workspace";
import { Sidebar } from "./sidebar";
import { MobileNav } from "./mobile-nav";
import { AccountMenu } from "./account-menu";
import { ThemeToggle } from "./theme-toggle";
import { GlobalSearch } from "./global-search";
import { CreditsMenu } from "./credits-menu";
import { LockedButton } from "./upgrade";
import { ShellHeader, ShellPanel } from "./shell-panel";
import { WorkspaceStatusNotice } from "./workspace-status-notice";
import type { WorkspaceMenuPresentation, WorkspaceSwitcherItem } from "./workspace-switcher";
import { switchWorkspaceAction } from "../_actions/workspace";
import {
  authenticatedActionResultMessage,
  isAuthenticatedActionFailure,
} from "@/lib/authenticated-request-browser";

interface AppChromeProps {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  remainingCredits: number;
  usedCredits: number;
  reservedCredits: number;
  limitCredits: number;
  creditsRenewAt: string;
  activeWorkspaceId: string;
  workspaceSelectionChanged: boolean;
  workspaceRole: "owner" | "admin" | "editor" | "viewer";
  workspaceStatus: "active" | "pending_payment" | "restricted";
  workspaceTier: "free" | "creator" | "pro" | "business";
  workspaces: WorkspaceSwitcherItem[];

  workspaceMenu: WorkspaceMenuPresentation;
  children: React.ReactNode;
}

function WorkspaceChangedNotice({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [visible, setVisible] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  if (!visible) return null;
  return (
    <Flex
      align="center"
      justify="space-between"
      gap="4"
      px={{ base: "4", md: "8" }}
      py="2"
      bg="accent.subtle"
    >
      <Text fontSize="sm" color="fg">
        Your saved Workspace is no longer available. Narriflow opened a
        Workspace you can access.
      </Text>
      <Button
        size="sm"
        variant="subtle"
        loading={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await switchWorkspaceAction(workspaceId);
            if (isAuthenticatedActionFailure(result)) {
              setError(
                authenticatedActionResultMessage(
                  result,
                  "The Workspace could not be selected.",
                ),
              );
              return;
            }
            setVisible(false);
            router.refresh();
          })
        }
      >
        Continue here
      </Button>
      {error ? <Text role="alert" fontSize="xs" color="danger.fg">{error}</Text> : null}
    </Flex>
  );
}

/** The panel header (desktop only): workspace / section breadcrumb on the
 *  left, search, usage, plan actions and the account menu on the right. */
function DesktopTopBar({
  workspaceName,
  email,
  firstName,
  lastName,
  imageUrl,
  remainingCredits,
  usedCredits,
  reservedCredits,
  limitCredits,
  creditsRenewAt,
  workspaceRole,
  workspaceStatus,
  workspaceTier,
  activeWorkspaceId,
}: { workspaceName: string } & Pick<AppChromeProps,
  | "email" | "firstName" | "lastName" | "imageUrl" | "remainingCredits" | "usedCredits" | "reservedCredits" | "limitCredits" | "creditsRenewAt" | "workspaceRole" | "workspaceStatus" | "workspaceTier" | "activeWorkspaceId">) {
  const pathname = usePathname();
  const section = pathname.split("/")[1] ?? "home";
  const title = ({ home: "Home", projects: "Projects", exports: "Exports", calendar: "Calendar", autopilot: "Autopilot", recipes: "Recipes", "brand-kit": "Brand kit", integrations: "Integrations", settings: "Settings", help: "Help", "whats-new": "What's new" } as Record<string, string>)[section] ?? "Workspace";
  const canManageBilling = workspaceRole === "owner";
  const hasMembers = hasFeature(workspaceTier, "workspace.members");
  const membersTier = lowestTierWithFeature("workspace.members");
  const canInvite = workspaceStatus === "active" && hasMembers && (workspaceRole === "owner" || workspaceRole === "admin");
  return (
    <ShellHeader crumbs={pathname.startsWith("/integrations/mcp") ? [workspaceName, title, "AI assistants"] : [workspaceName, title]} display={{ base: "none", lg: "flex" }}>
      <GlobalSearch workspaceId={activeWorkspaceId} />
      {canInvite ? (
        <Button variant="subtle" size="sm" asChild>
          <Link href="/settings/members"><UserPlus size={14} />Invite</Link>
        </Button>
      ) : !hasMembers && membersTier && canManageBilling && workspaceStatus === "active" ? (
        <LockedButton
          variant="subtle"
          size="sm"
          prompt={{
            tier: membersTier,
            headline: "Upgrade to work with your team",
            highlight: planUpgradeHighlight(membersTier, "workspace.members"),
            canManageBilling,
          }}
        >
          <UserPlus size={14} />Invite
        </LockedButton>
      ) : null}
      <CreditsMenu
        remainingCredits={remainingCredits}
        usedCredits={usedCredits}
        reservedCredits={reservedCredits}
        limitCredits={limitCredits}
        renewsAt={creditsRenewAt}
        tier={workspaceTier}
        canManageBilling={canManageBilling && workspaceStatus === "active"}
        askOwner={!canManageBilling}
      />
      <ThemeToggle />
      <AccountMenu email={email} firstName={firstName} imageUrl={imageUrl} lastName={lastName} />
    </ShellHeader>
  );
}

function FocusedTopBar({
  email,
  firstName,
  lastName,
  imageUrl,
  remainingCredits,
  usedCredits,
  reservedCredits,
  limitCredits,
  creditsRenewAt,
  workspaceRole,
  workspaceStatus,
  workspaceTier,
}: Pick<AppChromeProps, "email" | "firstName" | "lastName" | "imageUrl" | "remainingCredits" | "usedCredits" | "reservedCredits" | "limitCredits" | "creditsRenewAt" | "workspaceRole" | "workspaceStatus" | "workspaceTier">) {
  return (
    <ShellHeader
      start={
        <Link href="/home" aria-label="Narriflow home">
          <Logo size="md" />
        </Link>
      }
    >
      <CreditsMenu
        remainingCredits={remainingCredits}
        usedCredits={usedCredits}
        reservedCredits={reservedCredits}
        limitCredits={limitCredits}
        renewsAt={creditsRenewAt}
        tier={workspaceTier}
        canManageBilling={workspaceRole === "owner" && workspaceStatus === "active"}
        askOwner={workspaceRole !== "owner"}
      />
      <ThemeToggle />
      <AccountMenu email={email} firstName={firstName} imageUrl={imageUrl} lastName={lastName} />
    </ShellHeader>
  );
}

/**
 * Owns the pathname-based split between the normal app shell (fixed
 * sidebar + its 256px content offset + mobile nav bar) and the /upload
 * funnel, which is a focused, Vizard-style flow with no nav chrome — the
 * focused top bar provides the home link and remaining usage.
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
  remainingCredits,
  usedCredits,
  reservedCredits,
  limitCredits,
  creditsRenewAt,
  activeWorkspaceId,
  workspaceSelectionChanged,
  workspaceRole,
  workspaceStatus,
  workspaceTier,
  workspaces,

  workspaceMenu,
  children,
}: AppChromeProps) {
  const pathname = usePathname();
  const backHref = useSettingsReturn(activeWorkspaceId);
  const isUploadFunnel = pathname?.startsWith("/upload") ?? false;
  // An open project is a focused Vizard-style workspace too: no sidebar, the
  // page renders its own back-arrow bar. The /projects LIST keeps the normal
  // shell; the Studio route is a fixed overlay and never sees this chrome.
  const [collapsed, setCollapsed] = useState(false);

  if (isSettingsPath(pathname)) {
    return (
      <SettingsChrome
        workspaceName={workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.name ?? "Workspace"}
        canManageApi={workspaceMenu.canManageApi}
        backHref={backHref}
        account={<AccountMenu email={email} firstName={firstName} imageUrl={imageUrl} lastName={lastName} />}
        themeToggle={<ThemeToggle />}
      >
        {workspaceSelectionChanged ? <WorkspaceChangedNotice workspaceId={activeWorkspaceId} /> : null}
        <WorkspaceStatusNotice status={workspaceStatus} role={workspaceRole} pathname={pathname} />
        {children}
      </SettingsChrome>
    );
  }

  if (/^\/projects\/[^/]+(?:\/|$)/.test(pathname)) {
    return (
      <ProjectWorkspace account={<AccountMenu email={email} firstName={firstName} imageUrl={imageUrl} lastName={lastName} />} themeToggle={<ThemeToggle />}>
        {workspaceSelectionChanged ? <WorkspaceChangedNotice workspaceId={activeWorkspaceId} /> : null}
        <WorkspaceStatusNotice status={workspaceStatus} role={workspaceRole} pathname={pathname} />
        {children}
      </ProjectWorkspace>
    );
  }

  if (isUploadFunnel) {
    return (
      <Flex direction="column" minH="100dvh" p={{ base: "0", lg: "2" }}>
        <ShellPanel>
          <FocusedTopBar
            remainingCredits={remainingCredits}
            usedCredits={usedCredits}
            reservedCredits={reservedCredits}
            limitCredits={limitCredits}
            creditsRenewAt={creditsRenewAt}
            workspaceRole={workspaceRole}
            workspaceStatus={workspaceStatus}
            workspaceTier={workspaceTier}
            email={email}
            firstName={firstName}
            lastName={lastName}
            imageUrl={imageUrl}
          />
          {workspaceSelectionChanged ? (
            <WorkspaceChangedNotice workspaceId={activeWorkspaceId} />
          ) : null}
          <WorkspaceStatusNotice status={workspaceStatus} role={workspaceRole} pathname={pathname} />
          <Box as="main" flex="1" w="full" maxW="1400px" mx="auto" px={{ base: "4", md: "10" }} py={{ base: "5", md: "6" }}>
            {children}
          </Box>
        </ShellPanel>
      </Flex>
    );
  }


  return (
    <>
      {/* Desktop sidebar — sits on the frame; the account lives in the panel header */}
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
        remainingCredits={remainingCredits}
        limitCredits={limitCredits}
        activeWorkspaceId={activeWorkspaceId}
        workspaces={workspaces}
        canCreate={workspaceRole !== "viewer" && workspaceStatus === "active"}
        workspaceMenu={workspaceMenu}

      />

      {/* Mobile nav */}
      <MobileNav
        email={email}
        firstName={firstName}
        imageUrl={imageUrl}
        lastName={lastName}
        remainingCredits={remainingCredits}
        limitCredits={limitCredits}
        activeWorkspaceId={activeWorkspaceId}
        workspaces={workspaces}
        canCreate={workspaceRole !== "viewer" && workspaceStatus === "active"}
        workspaceMenu={workspaceMenu}

      />

      {/* Content — one rounded panel inset from the frame on desktop */}
      <Flex
        direction="column"
        ps={{ base: "0", lg: collapsed ? "68px" : "256px" }}
        pt={{ base: "48px", lg: "2" }}
        pe={{ base: "0", lg: "2" }}
        pb={{ base: "0", lg: "2" }}
        minH="100dvh"
      >
        <ShellPanel>
          {/* Panel header (desktop) — the page below owns its PageHeader */}
          <DesktopTopBar
            workspaceName={workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.name ?? "Workspace"}
            email={email}
            firstName={firstName}
            lastName={lastName}
            imageUrl={imageUrl}
            remainingCredits={remainingCredits}
            usedCredits={usedCredits}
            reservedCredits={reservedCredits}
            limitCredits={limitCredits}
            creditsRenewAt={creditsRenewAt}
            workspaceRole={workspaceRole}
            workspaceStatus={workspaceStatus}
            workspaceTier={workspaceTier}
            activeWorkspaceId={activeWorkspaceId}
          />

          {workspaceSelectionChanged ? (
            <WorkspaceChangedNotice workspaceId={activeWorkspaceId} />
          ) : null}
          <WorkspaceStatusNotice status={workspaceStatus} role={workspaceRole} pathname={pathname} />

          {/* Page content */}
          <Box as="main" flex="1" w="full" maxW="1400px" mx="auto" px={{ base: "4", md: "10" }} py={{ base: "6", md: "10" }}>
            {children}
          </Box>
        </ShellPanel>
      </Flex>
    </>
  );
}
