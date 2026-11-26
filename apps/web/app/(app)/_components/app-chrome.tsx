"use client";

import { usePathname } from "next/navigation";
import { type ComponentProps, Fragment, type ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Box, Flex, Text } from "@chakra-ui/react";
import { UserPlus } from "lucide-react";
import { STALE_TIME, type WorkspaceScope } from "@narriflow/api-client";
import { billingStateQueryOptions, createBillingActions } from "@narriflow/api-client/billing";
import {
  hasFeature,
  lowestTierWithFeature,
  planUpgradeHighlight,
  type PricingTier,
  resolvePricingTier,
} from "@narriflow/validators";
import type { WorkspaceBootstrap } from "@narriflow/validators/api/workspace";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@narriflow/ui/components/button";
import { Logo } from "@narriflow/ui/components/logo";
import { Bone } from "@narriflow/ui/components/page-loading";
import { SettingsChrome } from "./settings-chrome";
import { SettingsReturnTracker } from "./use-settings-return";
import { isSettingsPath, type SettingsReturnState } from "@/lib/settings-return";
import { ProjectWorkspace } from "./project-workspace";
import { Sidebar, type SidebarWorkspace } from "./sidebar";
import { MobileNav, type ShellAccount } from "./mobile-nav";
import { AccountAvatarPlaceholder, AccountMenu, type AccountSession } from "./account-menu";
import { ThemeToggle } from "./theme-toggle";
import { GlobalSearch, GlobalSearchPlaceholder } from "./global-search";
import { CreditsMenu, CreditsMenuPlaceholder } from "./credits-menu";
import { LockedButton, UpgradeProvider } from "./upgrade";
import { ShellHeader, ShellPanel } from "./shell-panel";
import { WorkspaceStatusNotice } from "./workspace-status-notice";
import type { WorkspaceMenuPresentation, WorkspaceSwitcherItem } from "./workspace-switcher";
import { beginSignOut, useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import { routeReads } from "./route-reads";
import { ApiErrorNotice } from "@/app/_components/query-mutation-form";
import {
  GateFailure,
  useWorkspaceGate,
  useWorkspaceSwitch,
  WorkspaceGateProvider,
} from "@/app/_components/workspace-query-gate";
import { upgradeBillingMode } from "@/lib/billing-view-model";
import { CHROME_SLOT, CHROME_TOP_BAR, chromeVar, rememberChromeLayout } from "@/lib/chrome-layout-hint";

/** Everything the chrome shows of the open Workspace. Null while it opens. */
interface ShellData {
  account: ShellAccount;
  remainingCredits: number;
  usedCredits: number;
  reservedCredits: number;
  limitCredits: number;
  creditsRenewAt: string;
  workspaceId: string;
  workspaceRole: "owner" | "admin" | "editor" | "viewer";
  workspaceStatus: "active" | "pending_payment" | "restricted";
  workspaceTier: PricingTier;
  workspaces: WorkspaceSwitcherItem[];
  workspaceMenu: WorkspaceMenuPresentation;
  canManageBilling: boolean;
  selectionChanged: boolean;
  dismissSelectionChanged(): void;
}

function shellData(
  { user, workspace, memberships, capabilities, usage }: WorkspaceBootstrap,
  selectionChanged: boolean,
  dismissSelectionChanged: () => void,
): ShellData {
  const tier = resolvePricingTier(workspace.pricingTier);
  const canManageBilling = capabilities["billing.manage"];
  let planAction: string | null = null;
  if (canManageBilling) {
    if (workspace.status === "pending_payment") planAction = "Complete setup";
    else if (workspace.status === "restricted") planAction = "Manage billing";
    else if (tier !== "business") planAction = "Upgrade your plan";
  }
  return {
    account: { email: user.email, firstName: user.firstName, lastName: user.lastName, imageUrl: user.imageUrl },
    remainingCredits: usage.remainingCredits,
    usedCredits: usage.usedCredits,
    reservedCredits: usage.reservedCredits,
    limitCredits: usage.limitCredits,
    creditsRenewAt: usage.renewsAt,
    workspaceId: workspace.id,
    workspaceRole: workspace.role,
    workspaceStatus: workspace.status,
    workspaceTier: tier,
    workspaces: memberships,
    workspaceMenu: {
      tier,
      canManageApi: capabilities["api.manage"],
      canInvite: capabilities["members.invite"] && hasFeature(workspace.pricingTier, "workspace.members"),
      planAction,
    },
    canManageBilling,
    selectionChanged,
    dismissSelectionChanged,
  };
}

/** Whether "New project" is shown. */
function canCreateProjects(data: ShellData): boolean {
  return data.workspaceRole !== "viewer" && data.workspaceStatus === "active";
}

function sidebarWorkspace(data: ShellData | null): SidebarWorkspace | null {
  if (!data) return null;
  return {
    remainingCredits: data.remainingCredits,
    limitCredits: data.limitCredits,
    activeWorkspaceId: data.workspaceId,
    workspaces: data.workspaces,
    canCreate: canCreateProjects(data),
    workspaceMenu: data.workspaceMenu,
  };
}

function WorkspaceChangedNotice({ workspaceId, onDismiss }: { workspaceId: string; onDismiss: () => void }) {
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
          if (await switchTo(workspaceId)) onDismiss();
        }}
      >
        Continue here
      </Button>
      {error ? <ApiErrorNotice error={error} fallback="The Workspace could not be selected." /> : null}
    </Flex>
  );
}

/** The selection-changed banner and the Workspace status notice; neither has a placeholder. */
function ShellNotices({ data, pathname }: { data: ShellData | null; pathname: string }) {
  if (!data) return null;
  return (
    <>
      {data.selectionChanged ? (
        <WorkspaceChangedNotice workspaceId={data.workspaceId} onDismiss={data.dismissSelectionChanged} />
      ) : null}
      <WorkspaceStatusNotice status={data.workspaceStatus} role={data.workspaceRole} pathname={pathname} />
    </>
  );
}

/** The account menu wired to the app's API session: billing portal and sign-out clearing. */
function ShellAccountMenu({ account }: { account: ShellAccount | null }) {
  if (!account) return <AccountAvatarPlaceholder />;
  return <ConnectedAccountMenu {...account} />;
}

function ConnectedAccountMenu(props: Omit<ComponentProps<typeof AccountMenu>, "session">) {
  const runtime = useApiRuntime();
  const scope = useWorkspaceScope();
  const session = useMemo<AccountSession>(
    () => ({
      openPortal: async () => {
        if (!scope) throw new Error("No Workspace is selected");
        return createBillingActions(runtime.transport, scope).openPortal();
      },
      beginSignOut: () => beginSignOut(runtime),
    }),
    [runtime, scope],
  );
  return <AccountMenu {...props} session={session} />;
}

/**
 * "Invite" while the Workspace opens: the subtle button's own box, hidden. It
 * opens nothing. Its width, and whether it takes space at all, follow the last
 * ready render (chrome-layout-hint): a locked Invite's gem, or no Invite.
 */
function InvitePlaceholder() {
  return (
    <Bone
      borderRadius="control"
      aria-hidden
      w={chromeVar("invite", "auto")}
      display={chromeVar("inviteDisplay", "block")}
    >
      <Button asChild variant="subtle" size="sm">
        <span>
          <UserPlus size={14} />
          Invite
        </span>
      </Button>
    </Bone>
  );
}

function InviteSlot({ data }: { data: ShellData | null }) {
  // Pending shows the common case (present); a person who gets neither collapses once.
  if (!data) return <InvitePlaceholder />;
  const { workspaceRole, workspaceStatus, workspaceTier } = data;
  const canManageBilling = workspaceRole === "owner";
  const hasMembers = hasFeature(workspaceTier, "workspace.members");
  const membersTier = lowestTierWithFeature("workspace.members");
  const canInvite = workspaceStatus === "active" && hasMembers && (workspaceRole === "owner" || workspaceRole === "admin");
  if (canInvite) {
    return (
      <Button variant="subtle" size="sm" asChild {...{ [CHROME_SLOT]: "invite" }}>
        <Link href="/settings/members"><UserPlus size={14} />Invite</Link>
      </Button>
    );
  }
  if (!hasMembers && membersTier && canManageBilling && workspaceStatus === "active") {
    return (
      <LockedButton
        {...{ [CHROME_SLOT]: "invite" }}
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
    );
  }
  return null;
}

function ShellCredits({ data }: { data: ShellData | null }) {
  if (!data) return <CreditsMenuPlaceholder />;
  const owner = data.workspaceRole === "owner";
  return (
    <CreditsMenu
      remainingCredits={data.remainingCredits}
      usedCredits={data.usedCredits}
      reservedCredits={data.reservedCredits}
      limitCredits={data.limitCredits}
      renewsAt={data.creditsRenewAt}
      tier={data.workspaceTier}
      canManageBilling={owner && data.workspaceStatus === "active"}
      askOwner={!owner}
    />
  );
}

/** The panel header (desktop only): search, usage, plan actions and the
 *  account menu on the right. */
function DesktopTopBar({ data }: { data: ShellData | null }) {
  return (
    <ShellHeader display={{ base: "none", lg: "flex" }} {...{ [CHROME_TOP_BAR]: "" }}>
      {data ? <GlobalSearch workspaceId={data.workspaceId} /> : <GlobalSearchPlaceholder />}
      <InviteSlot data={data} />
      <ShellCredits data={data} />
      <ThemeToggle />
      <ShellAccountMenu account={data?.account ?? null} />
    </ShellHeader>
  );
}

function FocusedTopBar({ data }: { data: ShellData | null }) {
  return (
    <ShellHeader
      start={
        <Link href="/home" aria-label="Narriflow home">
          <Logo size="md" />
        </Link>
      }
    >
      <ShellCredits data={data} />
      <ThemeToggle />
      <ShellAccountMenu account={data?.account ?? null} />
    </ShellHeader>
  );
}

/**
 * Owns the pathname-based split between the normal app shell (fixed
 * sidebar + its 256px content offset + mobile nav bar), the settings chrome,
 * an open Project, and the /upload funnel, which is a focused, Vizard-style
 * flow with no nav chrome — the focused top bar provides the home link and
 * remaining usage. AppLayout stays a server component while every piece
 * (offset, mobile nav, sidebar) reacts to the same route check together.
 *
 * Every variant renders while the Workspace opens (`data` is null): static
 * parts are real from the first byte and each data slot holds its final box,
 * so nothing moves when it fills in. Nothing here reads storage, the clock or
 * the URL's query while pending, so the server render and hydration agree.
 */
function AppChrome({ data, children }: { data: ShellData | null; children: ReactNode }) {
  const pathname = usePathname();
  const isUploadFunnel = pathname?.startsWith("/upload") ?? false;
  // The sidebar's collapsed state lives in memory only.
  const [collapsed, setCollapsed] = useState(false);
  const workspace = sidebarWorkspace(data);
  const account = data?.account ?? null;

  // Once ready, remember the variable slots' sizes for the next hard load's
  // placeholders. Again on each route: settings and an open Project show no pill.
  useEffect(() => {
    if (!data || !pathname) return;
    return rememberChromeLayout(canCreateProjects(data));
  }, [data, pathname]);

  // Settings' Back follows the pages visited outside settings, per Workspace. It
  // reads the URL's query, so it sits in its own boundary and runs only while a
  // Workspace is open; Back is /home unless the destination belongs to the open one.
  const [back, setBack] = useState<SettingsReturnState | null>(null);
  const backHref = data && back?.workspaceId === data.workspaceId ? back.destination : "/home";
  // Pages left while the Workspace opens, which the tracker is not mounted to see:
  // the first admission takes the last one outside settings. Only the first: while
  // a later Workspace opens, the URL can still be a page of the one just left.
  const pendingVisit = useRef<string | null>(null);
  const admittedOnce = useRef(false);
  useEffect(() => {
    if (data) admittedOnce.current = true;
    else if (!admittedOnce.current && !isSettingsPath(pathname)) pendingVisit.current = `${pathname}${window.location.search}`;
  }, [data, pathname]);
  const takePendingVisit = useCallback(() => {
    const visit = pendingVisit.current;
    pendingVisit.current = null;
    return visit;
  }, []);
  const settingsReturn = data ? (
    <Suspense fallback={null}>
      <SettingsReturnTracker workspaceId={data.workspaceId} takePendingVisit={takePendingVisit} onChange={setBack} />
    </Suspense>
  ) : null;

  let chrome: ReactNode;
  if (isSettingsPath(pathname)) {
    chrome = (
      <SettingsChrome
        workspaceName={data ? (data.workspaces.find((entry) => entry.id === data.workspaceId)?.name ?? "Workspace") : null}
        canManageApi={data ? data.workspaceMenu.canManageApi : null}
        backHref={backHref}
        account={<ShellAccountMenu account={account} />}
        themeToggle={<ThemeToggle />}
      >
        <ShellNotices data={data} pathname={pathname} />
        {children}
      </SettingsChrome>
    );
  } else if (/^\/projects\/[^/]+(?:\/|$)/.test(pathname)) {
    // An open project is a focused Vizard-style workspace too: no sidebar, the
    // page renders its own back-arrow bar. The /projects LIST keeps the normal
    // shell; the Studio route is a fixed overlay and never sees this chrome.
    chrome = (
      <ProjectWorkspace account={<ShellAccountMenu account={account} />} themeToggle={<ThemeToggle />}>
        <ShellNotices data={data} pathname={pathname} />
        {children}
      </ProjectWorkspace>
    );
  } else if (isUploadFunnel) {
    chrome = (
      <Flex direction="column" minH="100dvh" p={{ base: "0", lg: "2" }}>
        <ShellPanel>
          <FocusedTopBar data={data} />
          <ShellNotices data={data} pathname={pathname} />
          <Box as="main" flex="1" w="full" maxW="1400px" mx="auto" px={{ base: "4", md: "10" }} py={{ base: "5", md: "6" }}>
            {children}
          </Box>
        </ShellPanel>
      </Flex>
    );
  } else {
    chrome = (
      <>
        {/* Desktop sidebar — sits on the frame; the account lives in the panel header */}
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((value) => !value)} workspace={workspace} />

        {/* Mobile nav */}
        <MobileNav workspace={workspace} account={account} />

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
            <DesktopTopBar data={data} />
            <ShellNotices data={data} pathname={pathname} />

            {/* Page content */}
            <Box as="main" flex="1" w="full" maxW="1400px" mx="auto" px={{ base: "4", md: "10" }} py={{ base: "6", md: "10" }}>
              {children}
            </Box>
          </ShellPanel>
        </Flex>
      </>
    );
  }

  return (
    <>
      {settingsReturn}
      {chrome}
    </>
  );
}

const NO_WORKSPACE: WorkspaceScope = { userId: "", workspaceId: "" };

/**
 * Remounts the page when the admitted Workspace changes from one Workspace to
 * another, so no screen state (a captured intent, a draft) from one survives
 * into the other and a refused command never replays there. The first
 * admission, and a re-admission of the same Workspace, keep the page mounted.
 */
function usePageKey(workspaceId: string | null): number {
  const [state, setState] = useState<{ workspaceId: string | null; generation: number }>({
    workspaceId: null,
    generation: 0,
  });
  if (workspaceId !== null && workspaceId !== state.workspaceId) {
    const generation = state.workspaceId === null ? state.generation : state.generation + 1;
    // Adjusting state while rendering: React re-renders before any child commits.
    setState({ workspaceId, generation });
    return generation;
  }
  return state.generation;
}

/**
 * The app shell: the gate, the upgrade context, the chrome and the page. All
 * of it renders from the first byte; the gate fills the chrome when the
 * Workspace is ready, and screens wait on `useWorkspaceScope()`, not on this
 * tree. Billing state only words the upgrade links and settles beside the
 * screen: the links say "billing" until it answers, and a failed read neither
 * retries nor blocks.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const runtime = useApiRuntime();
  // Called once, when the identity is ready: the page being loaded is the one in the address bar.
  const prefetchUnderHint = useCallback(
    (scope: WorkspaceScope) => routeReads(runtime, scope, `${window.location.pathname}${window.location.search}`),
    [runtime],
  );
  return (
    <WorkspaceGateProvider prefetchUnderHint={prefetchUnderHint}>
      <ShellView>{children}</ShellView>
    </WorkspaceGateProvider>
  );
}

function ShellView({ children }: { children: ReactNode }) {
  const gate = useWorkspaceGate();
  const ready = gate.status === "ready" ? gate : null;
  const { transport } = useApiRuntime();
  const billing = useQuery({
    ...billingStateQueryOptions({ transport, scope: ready?.scope ?? NO_WORKSPACE }),
    enabled: ready !== null,
    staleTime: STALE_TIME.default,
    retry: false,
  });
  const data = useMemo(
    () => (ready ? shellData(ready.bootstrap, ready.selectionChanged, ready.dismissSelectionChanged) : null),
    [ready],
  );
  const pageKey = usePageKey(ready?.scope.workspaceId ?? null);

  return (
    <UpgradeProvider
      workspaceId={ready?.scope.workspaceId ?? null}
      currentTier={data?.workspaceTier ?? "free"}
      billingMode={data && billing.data ? upgradeBillingMode(billing.data.view) : "billing"}
      canManageBilling={data?.canManageBilling ?? false}
    >
      <AppChrome data={data}>
        {gate.status === "failed" ? (
          <GateFailure variant="panel" title={gate.title} error={gate.error} fallback={gate.message} onRetry={gate.retry} />
        ) : (
          <Fragment key={pageKey}>{children}</Fragment>
        )}
      </AppChrome>
    </UpgradeProvider>
  );
}
