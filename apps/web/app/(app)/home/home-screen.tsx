"use client";

import { Stack } from "@chakra-ui/react";
import { projectQueries } from "@narriflow/api-client/projects";
import { useQuery } from "@tanstack/react-query";
import { LoadFailure } from "../projects/_components/load-failure";
import { useLibraryApi } from "../projects/_lib/api";
import { DashboardView } from "./dashboard-view";
import HomeLoading from "./loading";
import { HomeRequestNotice } from "./request-failure-notice";

/** The dashboard: one aggregate read (`GET /api/home`) for the selected Workspace. */
export function HomeScreen() {
  const api = useLibraryApi();
  return (
    <Stack gap={{ base: "6", md: "8" }}>
      <HomeRequestNotice />
      {api ? <HomeContent api={api} /> : <HomeLoading />}
    </Stack>
  );
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
