import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { isRetentionEnforcementActive, workspaceLibraryService,
} from "@narriflow/services";
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
