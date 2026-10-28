"use client";

import { useAuth } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { type ComponentProps, type ReactNode, useMemo, useState } from "react";
import Link from "next/link";
import { Box, Flex, Text } from "@chakra-ui/react";
import { UserPlus } from "lucide-react";
import { STALE_TIME, type WorkspaceScope } from "@narriflow/api-client";
import { billingStateQueryOptions, createBillingActions } from "@narriflow/api-client/billing";
import { hasFeature, lowestTierWithFeature, planUpgradeHighlight, resolvePricingTier } from "@narriflow/validators";
import type { WorkspaceBootstrap } from "@narriflow/validators/api/workspace";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@narriflow/ui/components/button";
import { Logo } from "@narriflow/ui/components/logo";
import { SettingsChrome } from "./settings-chrome";
import { useSettingsReturn } from "./use-settings-return";
import { isSettingsPath } from "@/lib/settings-return";
import { ProjectWorkspace } from "./project-workspace";
import { Sidebar } from "./sidebar";
import { MobileNav } from "./mobile-nav";
import { AccountMenu, type AccountSession } from "./account-menu";
import { ThemeToggle } from "./theme-toggle";
import { GlobalSearch } from "./global-search";
import { CreditsMenu } from "./credits-menu";
import { LockedButton, UpgradeProvider } from "./upgrade";
import { ShellHeader, ShellPanel } from "./shell-panel";
import { WorkspaceStatusNotice } from "./workspace-status-notice";
import type { WorkspaceMenuPresentation, WorkspaceSwitcherItem } from "./workspace-switcher";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import { ApiErrorNotice } from "@/app/_components/query-mutation-form";
import {
  SessionGate,
  useSessionGate,
  useWorkspaceSwitch,
  WorkspaceQueryGate,
} from "@/app/_components/workspace-query-gate";
import { upgradeBillingMode } from "@/lib/billing-view-model";
import Loading from "../loading";

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
  const { dismissSelectionChanged } = useSessionGate();
  const { switchTo, pending, error } = useWorkspaceSwitch();
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
        onClick={async () => {
          if (await switchTo(workspaceId)) dismissSelectionChanged();
        }}
      >
        Continue here
      </Button>
      {error ? <ApiErrorNotice error={error} fallback="The Workspace could not be selected." /> : null}
    </Flex>
  );
}

/** The account menu wired to the app's API session: billing portal and sign-out clearing. */
function ShellAccountMenu(props: Omit<ComponentProps<typeof AccountMenu>, "session">) {
  const runtime = useApiRuntime();
  const scope = useWorkspaceScope();
  const { userId } = useAuth();
  const session = useMemo<AccountSession>(
    () => ({
      openPortal: async () => {
        if (!scope) throw new Error("No Workspace is selected");
        return createBillingActions(runtime.transport, scope).openPortal();
      },
      beginSignOut: () => {
        runtime.setIdentity(null);
        return () => runtime.setIdentity(userId ?? null);
      },
    }),
    [runtime, scope, userId],
  );
  return <AccountMenu {...props} session={session} />;
}

/** The panel header (desktop only): search, usage, plan actions and the
 *  account menu on the right. */
function DesktopTopBar({
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
}: Pick<AppChromeProps,
  | "email" | "firstName" | "lastName" | "imageUrl" | "remainingCredits" | "usedCredits" | "reservedCredits" | "limitCredits" | "creditsRenewAt" | "workspaceRole" | "workspaceStatus" | "workspaceTier" | "activeWorkspaceId">) {
  const canManageBilling = workspaceRole === "owner";
  const hasMembers = hasFeature(workspaceTier, "workspace.members");
  const membersTier = lowestTierWithFeature("workspace.members");
  const canInvite = workspaceStatus === "active" && hasMembers && (workspaceRole === "owner" || workspaceRole === "admin");
  return (
    <ShellHeader display={{ base: "none", lg: "flex" }}>
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
      <ShellAccountMenu email={email} firstName={firstName} imageUrl={imageUrl} lastName={lastName} />
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
      <ShellAccountMenu email={email} firstName={firstName} imageUrl={imageUrl} lastName={lastName} />
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
        account={<ShellAccountMenu email={email} firstName={firstName} imageUrl={imageUrl} lastName={lastName} />}
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
      <ProjectWorkspace account={<ShellAccountMenu email={email} firstName={firstName} imageUrl={imageUrl} lastName={lastName} />} themeToggle={<ThemeToggle />}>
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

function ShellPending() {
  return (
    <Box minH="100dvh" bg="bg.sidebar" color="fg">
      <Box maxW="1400px" mx="auto" px={{ base: "4", md: "10" }} py={{ base: "6", md: "10" }}>
        <Loading />
      </Box>
    </Box>
  );
}

/**
 * The shell's data: identity bootstrap first (it adopts the effective
 * Workspace), then the Workspace bootstrap and billing state for it. The
 * children, and so every screen, render only once the shell can show its
 * credits and plan, inside a Workspace that is in force for this session.
 */
function WorkspaceShell({
  bootstrap,
  scope,
  children,
}: {
  bootstrap: WorkspaceBootstrap;
  scope: WorkspaceScope;
  children: ReactNode;
}) {
  const { transport } = useApiRuntime();
  const { selectionChanged } = useSessionGate();
  // The shell reads billing only to word upgrade links; a failed read must not
  // hold the app back, so it neither retries nor blocks past its first answer.
  const billing = useQuery({
    ...billingStateQueryOptions({ transport, scope }),
    staleTime: STALE_TIME.default,
    retry: false,
  });
  if (billing.isPending) return <ShellPending />;

  const { user, workspace, memberships, capabilities, usage } = bootstrap;
  const tier = resolvePricingTier(workspace.pricingTier);
  const canManageBilling = capabilities["billing.manage"];
  let planAction: string | null = null;
  if (canManageBilling) {
    if (workspace.status === "pending_payment") planAction = "Complete setup";
    else if (workspace.status === "restricted") planAction = "Manage billing";
    else if (tier !== "business") planAction = "Upgrade your plan";
  }

  return (
    <UpgradeProvider
      currentTier={tier}
      billingMode={billing.data ? upgradeBillingMode(billing.data.view) : "billing"}
      canManageBilling={canManageBilling}
    >
      <AppChrome
        email={user.email}
        firstName={user.firstName}
        lastName={user.lastName}
        imageUrl={user.imageUrl}
        remainingCredits={usage.remainingCredits}
        usedCredits={usage.usedCredits}
        reservedCredits={usage.reservedCredits}
        limitCredits={usage.limitCredits}
        creditsRenewAt={usage.renewsAt}
        activeWorkspaceId={workspace.id}
        workspaceSelectionChanged={selectionChanged}
        workspaceRole={workspace.role}
        workspaceStatus={workspace.status}
        workspaceTier={tier}
        workspaces={memberships}
        workspaceMenu={{
          tier,
          canManageApi: capabilities["api.manage"],
          canInvite: capabilities["members.invite"] && hasFeature(workspace.pricingTier, "workspace.members"),
          planAction,
        }}
      >
        {children}
      </AppChrome>
    </UpgradeProvider>
  );
}

/** Session and Workspace gates around the app chrome: every authenticated screen renders inside it. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SessionGate fallback={<ShellPending />}>
      <WorkspaceQueryGate fallback={<ShellPending />}>
        {(bootstrap, scope) => (
          <WorkspaceShell bootstrap={bootstrap} scope={scope}>
            {children}
          </WorkspaceShell>
        )}
      </WorkspaceQueryGate>
    </SessionGate>
  );
}
