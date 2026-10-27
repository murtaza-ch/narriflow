import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { workspaceLibraryService } from "@narriflow/services";
import { planLimits, resolvePricingTier, workspaceAllowsCapability } from "@narriflow/validators";
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
  const recentProjects = await workspaceLibraryService.listProjects(appUser, {limit: RECENT_PROJECTS_LIMIT});
  const firstName = appUser.firstName?.trim();
  const hourGreeting = greetingForHour(new Date().getHours());
  const greeting = firstName ? `${hourGreeting}, ${firstName}` : hourGreeting;

  return (
    <DashboardView
        greeting={greeting}
        items={recentProjects.items}
        canCreate={workspaceAllowsCapability(appUser.workspace, "content.edit")}
        readOnlyReason={
          appUser.workspace.role === "viewer" ? "viewer" : appUser.workspace.status === "active" ? null : "paused"
        }
        canManageBilling={appUser.workspace.role === "owner"}
        showRetentionBanner={
          planLimits(resolvePricingTier(appUser.workspace.pricingTier)).projectRetentionHours !== null
        }
    />
  );
}
