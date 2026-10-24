"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import Link from "next/link";
import { Box, chakra, Flex, Text } from "@chakra-ui/react";
import { Gauge, UserPlus } from "lucide-react";
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
import { ShellHeader, ShellPanel } from "./shell-panel";
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
  usedMinutes: number;
  limitMinutes: number;
  activeWorkspaceId: string;
  workspaceSelectionChanged: boolean;
  workspaceRole: "owner" | "admin" | "editor" | "viewer";
  workspaceStatus: "active" | "pending_payment" | "restricted";
  workspaceTier: "free" | "creator" | "pro" | "business";
  workspaces: WorkspaceSwitcherItem[];
  canCreateWorkspace: boolean;
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
  usedMinutes,
  limitMinutes,
  workspaceRole,
  workspaceStatus,
  workspaceTier,
  activeWorkspaceId,
}: { workspaceName: string } & Pick<AppChromeProps,
  | "email" | "firstName" | "lastName" | "imageUrl" | "usedMinutes" | "limitMinutes" | "workspaceRole" | "workspaceStatus" | "workspaceTier" | "activeWorkspaceId">) {
  const pathname = usePathname();
  const section = pathname.split("/")[1] ?? "home";
  const title = ({ home: "Home", projects: "Projects", exports: "Exports", calendar: "Calendar", autopilot: "Autopilot", recipes: "Recipes", "brand-kit": "Brand kit", integrations: "Integrations", settings: "Settings", help: "Help", "whats-new": "What's new" } as Record<string, string>)[section] ?? "Workspace";
  const canInvite = workspaceStatus === "active" && workspaceTier === "business" && (workspaceRole === "owner" || workspaceRole === "admin");
  return (
    <ShellHeader crumbs={pathname.startsWith("/integrations/mcp") ? [workspaceName, title, "AI assistants"] : [workspaceName, title]} display={{ base: "none", lg: "flex" }}>
      <GlobalSearch workspaceId={activeWorkspaceId} />
      <Button variant="ghost" size="sm" asChild>
        <Link href="/settings/usage"><Gauge size={14} />{Math.round(usedMinutes)}/{Math.round(limitMinutes)} min</Link>
      </Button>
      {canInvite ? (
        <Button variant="subtle" size="sm" asChild>
          <Link href="/settings/members"><UserPlus size={14} />Invite</Link>
        </Button>
      ) : null}
      {workspaceStatus === "pending_payment" && workspaceRole === "owner" ? (
        <Button variant="subtle" size="sm" asChild>
          <Link href="/settings/billing">Complete setup</Link>
        </Button>
      ) : workspaceTier !== "business" ? (
        <Button variant="subtle" size="sm" asChild>
          <Link href="/settings/billing">Upgrade</Link>
        </Button>
      ) : null}
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
  usedMinutes,
  limitMinutes,
}: Pick<AppChromeProps, "email" | "firstName" | "lastName" | "imageUrl" | "usedMinutes" | "limitMinutes">) {
  return (
    <ShellHeader
      start={
        <Link href="/home" aria-label="Narriflow home">
          <Logo size="md" />
        </Link>
      }
    >
      <Link href="/settings/usage">
        <Text fontSize="13px" color="fg.muted" mr={{ base: "0", sm: "2" }} whiteSpace="nowrap">
          <chakra.span fontWeight="600" color="fg">{Math.max(0, limitMinutes - usedMinutes).toLocaleString()}</chakra.span> min left
        </Text>
      </Link>
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
  usedMinutes,
  limitMinutes,
  activeWorkspaceId,
  workspaceSelectionChanged,
  workspaceRole,
  workspaceStatus,
  workspaceTier,
  workspaces,
  canCreateWorkspace,
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
        {children}
      </SettingsChrome>
    );
  }

  if (/^\/projects\/[^/]+(?:\/|$)/.test(pathname)) {
    return (
      <ProjectWorkspace account={<AccountMenu email={email} firstName={firstName} imageUrl={imageUrl} lastName={lastName} />} themeToggle={<ThemeToggle />}>
        {workspaceSelectionChanged ? <WorkspaceChangedNotice workspaceId={activeWorkspaceId} /> : null}
        {children}
      </ProjectWorkspace>
    );
  }

  if (isUploadFunnel) {
    return (
      <Flex direction="column" minH="100dvh" p={{ base: "0", lg: "2" }}>
        <ShellPanel>
          <FocusedTopBar
            usedMinutes={usedMinutes}
            limitMinutes={limitMinutes}
            email={email}
            firstName={firstName}
            lastName={lastName}
            imageUrl={imageUrl}
          />
          {workspaceSelectionChanged ? (
            <WorkspaceChangedNotice workspaceId={activeWorkspaceId} />
          ) : null}
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
        usedMinutes={usedMinutes}
        limitMinutes={limitMinutes}
        activeWorkspaceId={activeWorkspaceId}
        workspaces={workspaces}
        canCreate={workspaceRole !== "viewer" && workspaceStatus === "active"}
        workspaceMenu={workspaceMenu}
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
        workspaceMenu={workspaceMenu}
        canCreateWorkspace={canCreateWorkspace}
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
            usedMinutes={usedMinutes}
            limitMinutes={limitMinutes}
            workspaceRole={workspaceRole}
            workspaceStatus={workspaceStatus}
            workspaceTier={workspaceTier}
            activeWorkspaceId={activeWorkspaceId}
          />

          {workspaceSelectionChanged ? (
            <WorkspaceChangedNotice workspaceId={activeWorkspaceId} />
          ) : null}

          {/* Page content */}
          <Box as="main" flex="1" w="full" maxW="1400px" mx="auto" px={{ base: "4", md: "10" }} py={{ base: "6", md: "10" }}>
            {children}
          </Box>
        </ShellPanel>
      </Flex>
    </>
  );
}
