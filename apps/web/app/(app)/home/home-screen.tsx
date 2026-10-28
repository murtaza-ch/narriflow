"use client";

import { projectQueries } from "@narriflow/api-client/projects";
import { useQuery } from "@tanstack/react-query";
import { LoadFailure } from "../projects/_components/load-failure";
import { useLibraryApi } from "../projects/_lib/api";
import { DashboardView } from "./dashboard-view";
import HomeLoading from "./loading";

/** The dashboard: one aggregate read (`GET /api/home`) for the selected Workspace. */
export function HomeScreen() {
  const api = useLibraryApi();
  if (!api) return <HomeLoading />;
  return <HomeContent api={api} />;
}

function HomeContent({ api }: { api: NonNullable<ReturnType<typeof useLibraryApi>> }) {
  const home = useQuery(projectQueries.home(api.projects, api.scope));
  if (home.isError) {
    return <LoadFailure what="Your dashboard" error={home.error} onRetry={() => void home.refetch()} />;
  }
  if (!home.data) return <HomeLoading />;
  const { items, canCreate, readOnlyReason, canManageBilling, autopilot, showRetentionBanner } = home.data;
  return (
    <DashboardView
      items={items}
      canCreate={canCreate}
      readOnlyReason={readOnlyReason}
      canManageBilling={canManageBilling}
      autopilot={autopilot}
      showRetentionBanner={showRetentionBanner}
    />
  );
}
