import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { isRetentionEnforcementActive, projectService,
} from "@narriflow/services";
import { DashboardView } from "../dashboard/dashboard-view";

const RECENT_PROJECTS_LIMIT = 8;

function greetingForHour(hour: number): string {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default async function HomePage() {
  const appUser = await admitWorkspacePage("content.view");
  const recentProjects = await projectService.listProjectsWithStatsPage(
    appUser.actorUserId,
    {
      limit: RECENT_PROJECTS_LIMIT,
      workspaceId: appUser.workspaceId,
    },
  );
  const firstName = appUser.firstName?.trim();
  const hourGreeting = greetingForHour(new Date().getHours());
  const greeting = firstName ? `${hourGreeting}, ${firstName}` : hourGreeting;

  return (
    <DashboardView
        greeting={greeting}
        items={recentProjects.items}
        canCreate={
          appUser.workspace.role !== "viewer" &&
          appUser.workspace.status === "active"
        }
        showRetentionBanner={
          appUser.workspace.pricingTier === "free" && isRetentionEnforcementActive()
        }
    />
  );
}
