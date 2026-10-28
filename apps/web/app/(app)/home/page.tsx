import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { autopilotService, workspaceLibraryService } from "@narriflow/services";
import { hasFeature, lowestTierWithFeature, planLimits, resolvePricingTier, workspaceAllowsCapability } from "@narriflow/validators";
import { DashboardView } from "./dashboard-view";

const RECENT_PROJECTS_LIMIT = 8;

function greetingForHour(hour: number): string {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default async function HomePage() {
  const appUser = await admitWorkspacePage("content.view");
  const canCreate = workspaceAllowsCapability(appUser.workspace, "content.edit");
  const [recentProjects, autopilotRules] = await Promise.all([
    workspaceLibraryService.listProjects(appUser, {limit: RECENT_PROJECTS_LIMIT}),
    // Only editors see the Autopilot card.
    canCreate ? autopilotService.listRules(appUser) : [],
  ]);
  const firstName = appUser.firstName?.trim();
  const hourGreeting = greetingForHour(new Date().getHours());
  const greeting = firstName ? `${hourGreeting}, ${firstName}` : hourGreeting;

  return (
    <DashboardView
        greeting={greeting}
        items={recentProjects.items}
        canCreate={canCreate}
        readOnlyReason={
          appUser.workspace.role === "viewer" ? "viewer" : appUser.workspace.status === "active" ? null : "paused"
        }
        canManageBilling={appUser.workspace.role === "owner"}
        autopilot={{
          lockedTier: hasFeature(appUser.pricingTier, "automation.autopilot") ? null : lowestTierWithFeature("automation.autopilot"),
          rules: autopilotRules.length,
          activeRules: autopilotRules.filter((rule) => rule.status === "active" || rule.status === "running").length,
        }}
        showRetentionBanner={
          planLimits(resolvePricingTier(appUser.workspace.pricingTier)).projectRetentionHours !== null
        }
    />
  );
}
