import { redirect } from "next/navigation";
import { listUserWorkspaces } from "@narriflow/auth";
import { admitOptionalWorkspacePage } from "@/lib/authenticated-request-page";
import { Box } from "@chakra-ui/react";
import { hasFeature, resolvePricingTier } from "@narriflow/validators";
import { AppChrome } from "./_components/app-chrome";
import { UpgradeProvider } from "./_components/upgrade";
import { upgradeBillingMode } from "@/lib/billing-view-model";
import { getCachedUsageSummary } from "./_components/usage";
import { billingService, workspaceService, workspaceAllowsCapability,
} from "@narriflow/services";

export default async function AppLayout({ children,
}: { children: React.ReactNode;
}) {
  const appUser = await admitOptionalWorkspacePage("content.view");

  if (!appUser) {
    redirect("/?auth=sign-in");
  }

  const [stats, memberships, billingView] = await Promise.all([
    getCachedUsageSummary(appUser.actorUserId, appUser.workspaceId),
    listUserWorkspaces(appUser.actorUserId),
    billingService.readBillingState(appUser.workspaceId),
  ]);
  const avatarUrls = await workspaceService.getAvatarUrls(
    appUser.actorUserId,
    memberships.map((membership) => membership.workspace.id),
  );
  const workspaces = memberships.map(({ role, workspace }) => ({
    id: workspace.id,
    name: workspace.name,
    role,
    isPersonal: workspace.personalOwnerUserId !== null,
    avatarUrl: avatarUrls[workspace.id] ?? null,
  }));

  let planAction: string | null = null;
  if (workspaceAllowsCapability(appUser.workspace, "billing.manage")) {
    if (appUser.workspace.status === "pending_payment") planAction = "Complete setup";
    else if (appUser.workspace.status === "restricted") planAction = "Manage billing";
    else if (resolvePricingTier(appUser.workspace.pricingTier) !== "business") planAction = "Upgrade your plan";
  }

  return (
    <Box minH="100dvh" bg="bg.sidebar" color="fg">
      {/* AppChrome (client) owns the sidebar/offset/mobile-nav vs. /upload
          funnel split — see its own comment for why that needs to be one
          pathname check rather than each piece hiding itself. */}
      <UpgradeProvider
        currentTier={resolvePricingTier(appUser.workspace.pricingTier)}
        billingMode={upgradeBillingMode(billingView)}
        canManageBilling={workspaceAllowsCapability(appUser.workspace, "billing.manage")}
      >
      <AppChrome
        email={appUser.primaryEmail}
        firstName={appUser.firstName}
        imageUrl={appUser.imageUrl}
        lastName={appUser.lastName}
        remainingCredits={stats.remainingCredits}
        usedCredits={stats.usedCredits}
        reservedCredits={stats.reservedCredits}
        limitCredits={stats.limitCredits}
        creditsRenewAt={stats.renewsAt.toISOString()}
        activeWorkspaceId={appUser.workspaceId}
        workspaceSelectionChanged={appUser.workspaceSelectionChanged}
        workspaceRole={appUser.workspace.role}
        workspaceStatus={appUser.workspace.status}
        workspaceTier={resolvePricingTier(appUser.workspace.pricingTier)}
        workspaces={workspaces}
        workspaceMenu={{
          tier: resolvePricingTier(appUser.workspace.pricingTier),
          canManageApi: workspaceAllowsCapability(appUser.workspace, "api.manage"),
          canInvite: workspaceAllowsCapability(appUser.workspace, "members.invite") && hasFeature(appUser.workspace.pricingTier, "workspace.members"),
          planAction,
        }}
      >
        {children}
      </AppChrome>
      </UpgradeProvider>
    </Box>
  );
}
