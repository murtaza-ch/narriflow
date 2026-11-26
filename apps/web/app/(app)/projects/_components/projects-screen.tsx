"use client";

import { HStack, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { LoadingScreen } from "@narriflow/ui/components/page-loading";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, FolderOpen } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { explorerFiltersFromSearch, explorerQueryOptions, type LibraryApi, useLibraryApi } from "../_lib/api";
import { FoldersPanel } from "./folders-panel";
import { LoadFailure } from "./load-failure";
import { ProjectsExplorer } from "./projects-explorer";
import { ProjectsHeaderActions } from "./projects-header-actions";
import { ProjectsGridSkeleton, ProjectsHeaderSkeleton } from "./projects-skeleton";
import { RetentionBanner } from "./retention-banner";
import { WorkspaceMismatchNotice } from "./workspace-mismatch-notice";

/** The explorer's filters as the URL carries them. */
function useUrlFilters() {
  const text = useSearchParams().toString();
  return useMemo(() => explorerFiltersFromSearch(new URLSearchParams(text)), [text]);
}

/** The Projects page: header, Workspace-mismatch recovery, folders and the explorer. */
export function ProjectsScreen() {
  const api = useLibraryApi();
  return (
    <Stack gap="8">
      {api ? <ProjectsContent api={api} /> : <ProjectsPending />}
    </Stack>
  );
}

/** The same busy region as `loading.tsx`, so the route boundary hands over without a repaint. */
function ProjectsPending() {
  return (
    <LoadingScreen label="Loading projects">
      <ProjectsHeaderSkeleton />
      <ProjectsGridSkeleton />
    </LoadingScreen>
  );
}

/** A Project opened in another Workspace lands here with the facts to offer a switch. */
function WorkspaceRecovery() {
  const params = useSearchParams();
  const workspaceId = params.get("workspaceId");
  if (params.get("requestFailure") !== "active_workspace_mismatch" || !workspaceId) return null;
  return (
    <WorkspaceMismatchNotice
      workspaceId={workspaceId}
      workspaceName={params.get("workspaceName")?.slice(0, 120) || "another Workspace"}
      returnTo={params.get("returnTo") || "/projects"}
    />
  );
}

function ProjectsContent({ api }: { api: LibraryApi }) {
  const filters = useUrlFilters();
  const queryClient = useQueryClient();
  const explorer = useQuery({
    ...explorerQueryOptions(queryClient, api, filters),
    // The previous filters' page stays on screen while the new one loads.
    placeholderData: keepPreviousData,
  });

  if (explorer.isError) {
    return (
      <>
        <PageHeader title="Projects" />
        <WorkspaceRecovery />
        <LoadFailure what="Projects" error={explorer.error} onRetry={() => void explorer.refetch()} />
      </>
    );
  }
  if (!explorer.data) {
    return (
      <LoadingScreen label="Loading projects">
        <ProjectsHeaderSkeleton />
        <WorkspaceRecovery />
        <ProjectsGridSkeleton />
      </LoadingScreen>
    );
  }

  const { folders, activeFolder, access } = explorer.data;
  const hasFilters = Boolean(filters.q) || filters.status !== "all" || filters.source !== "all" || Boolean(filters.folder);
  const empty = explorer.data.page.items.length === 0 && !hasFilters;
  const folderViews = folders.map((folder) => ({ id: folder.id, name: folder.name, count: folder.projectCount }));
  const retentionBanner = access.showRetentionBanner ? (
    <RetentionBanner canManageBilling={access.canManageBilling} />
  ) : null;

  return (
    <>
      <PageHeader
        title={
          activeFolder ? (
            <HStack as="span" gap="2">
              <Text asChild color="fg.muted" fontSize="inherit" fontWeight="inherit">
                <Link href="/projects">Projects</Link>
              </Text>
              <ChevronRight size={16} aria-hidden="true" />
              <Text as="span" fontSize="inherit" fontWeight="inherit">
                {activeFolder.name}
              </Text>
            </HStack>
          ) : (
            "Projects"
          )
        }
        actions={
          access.canCreate || access.canEdit ? (
            <ProjectsHeaderActions
              api={api}
              canCreate={access.canCreate}
              canEdit={access.canEdit}
              folders={folders}
            />
          ) : undefined
        }
      />
      <WorkspaceRecovery />
      {empty ? (
        <Stack gap="5">
          <FoldersPanel api={api} folders={folderViews} canEdit={access.canEdit} />
          {retentionBanner}
          <EmptyState
            icon={<FolderOpen size={20} strokeWidth={1.5} />}
            title="No projects yet"
            description={access.canCreate ? undefined : "Videos your team imports will appear here."}
            action={
              access.canCreate ? (
                <Button size="sm" variant="subtle" asChild>
                  <Link href="/upload">Start upload</Link>
                </Button>
              ) : undefined
            }
          />
        </Stack>
      ) : (
        <Stack gap="5">
          {!activeFolder ? <FoldersPanel api={api} folders={folderViews} canEdit={access.canEdit} /> : null}
          {retentionBanner}
          <ProjectsExplorer
            api={api}
            filters={filters}
            // Page 1 for these filters is in the cache once the explorer has resolved for them.
            ready={!explorer.isPlaceholderData}
            folderName={activeFolder?.name}
            folders={folders.map((folder) => ({ id: folder.id, name: folder.name }))}
            canEdit={access.canEdit}
          />
        </Stack>
      )}
    </>
  );
}
