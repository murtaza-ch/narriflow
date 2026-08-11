import { requireCurrentAppUser } from "@narriflow/auth";
import {
  isRetentionEnforcementActive,
  projectService,
} from "@narriflow/services";
import { UpgradedToast } from "./dashboard-client";
import { DashboardView } from "./dashboard-view";

const RECENT_PROJECTS_LIMIT = 8;

function greetingForHour(hour: number): string {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ upgraded?: string; session_id?: string }>;
}) {
  const appUser = await requireCurrentAppUser();
  const [recentProjects, params] = await Promise.all([
    projectService.listProjectsWithStatsPage(appUser.id, {
      limit: RECENT_PROJECTS_LIMIT,
    }),
    searchParams,
  ]);
  const justUpgraded = params.upgraded === "1";

  const firstName = appUser.firstName?.trim();
  const hourGreeting = greetingForHour(new Date().getHours());
  const greeting = firstName ? `${hourGreeting}, ${firstName}` : hourGreeting;

  return (
    <>
      {justUpgraded ? (
        <UpgradedToast sessionId={params.session_id ?? null} />
      ) : null}
      <DashboardView
        greeting={greeting}
        items={recentProjects.items}
        showRetentionBanner={
          appUser.pricingTier === "free" && isRetentionEnforcementActive()
        }
      />
    </>
  );
}
