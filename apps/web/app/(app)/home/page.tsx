import { requireWorkspaceAppUser } from "@/lib/workspace";
import { isRetentionEnforcementActive, projectService } from "@narriflow/services";
import { UpgradedToast } from "../dashboard/dashboard-client";
import { DashboardView } from "../dashboard/dashboard-view";

const RECENT_PROJECTS_LIMIT = 8;

function greetingForHour(hour: number): string {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ upgraded?: string; session_id?: string }>;
}) {
  const appUser = await requireWorkspaceAppUser();
  const [recentProjects, params] = await Promise.all([
    projectService.listProjectsWithStatsPage(appUser.actorUserId, {
      limit: RECENT_PROJECTS_LIMIT,
      workspaceId: appUser.workspaceId,
    }),
    searchParams,
  ]);
  const firstName = appUser.firstName?.trim();
  const hourGreeting = greetingForHour(new Date().getHours());
  const greeting = firstName ? `${hourGreeting}, ${firstName}` : hourGreeting;

  return (
    <>
      {params.upgraded === "1" ? <UpgradedToast sessionId={params.session_id ?? null} /> : null}
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
    </>
  );
}
