import { Suspense } from "react";
import Link from "next/link";
import { Stack } from "@chakra-ui/react";
import { FolderOpen } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import {
  isRetentionEnforcementActive,
  projectService,
  type ProjectListSort,
  type ProjectListSourceFilter,
  type ProjectListStatusFilter,
} from "@narriflow/services";
import { ProjectsExplorer } from "./_components/projects-explorer";
import { ProjectsGridSkeleton } from "./_components/projects-skeleton";
import { RetentionBanner } from "./_components/retention-banner";
import { FoldersPanel } from "./_components/folders-panel";
import { workspaceLibraryService } from "@narriflow/services";
import { WorkspaceMismatchNotice } from "./_components/workspace-mismatch-notice";

/**
 * Deliberately NOT async, and deliberately without a sibling `loading.tsx`.
 *
 * `loading.tsx` compiles to a Suspense boundary around the whole page, so a
 * route with both `loading.tsx` and an in-page `<Suspense>` runs two
 * boundaries back to back on every navigation. Awaiting auth in the page body
 * made that worse: with the await above the in-page boundary there was no
 * static shell left, so the route-level fallback had to stand in for the
 * header too, and the grid entrance played once for the skeleton and again for
 * the real cards.
 *
 * Streaming rule (Next.js "Streaming" guide): everything ABOVE a Suspense
 * boundary is the static shell and ships immediately. So the header stays
 * synchronous here and every await lives in `ProjectsData`, below the single
 * boundary — the header paints at once, and the grid slot resolves exactly
 * once, in place.
 */
type ProjectsSearchParams = {
  folder?: string;
  q?: string;
  status?: string;
  source?: string;
  sort?: string;
  requestFailure?: string;
  workspaceId?: string;
  workspaceName?: string;
  returnTo?: string;
};

const PROJECT_STATUSES = new Set<ProjectListStatusFilter>([
  "all",
  "ready",
  "processing",
  "queued",
  "failed",
]);
const PROJECT_SOURCES = new Set<ProjectListSourceFilter>([
  "all",
  "youtube",
  "link",
  "upload",
  "rss",
]);
const PROJECT_SORTS = new Set<ProjectListSort>([
  "newest",
  "oldest",
  "title",
  "clips",
]);

export default function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<ProjectsSearchParams>;
}) {
  return (
    <Stack gap="8">
      <PageHeader
        eyebrow="Library"
        title="Projects"
        description="Manage imports, queue transcription, and review project progress."
        actions={
          <Suspense fallback={null}>
            <ProjectsHeaderAction />
          </Suspense>
        }
      />

      <Suspense fallback={null}>
        <WorkspaceRecovery searchParams={searchParams} />
      </Suspense>

      {/* No entrance animation on this wrapper: the grid's own staggered
          card fade-up is the entrance, and wrapping the boundary in a second
          fade-up meant the region animated in with the skeleton and then the
          cards animated in again on resolve. */}
      <Suspense fallback={<ProjectsGridSkeleton />}>
        <ProjectsData searchParams={searchParams} />
      </Suspense>
    </Stack>
  );
}

async function WorkspaceRecovery({
  searchParams,
}: {
  searchParams: Promise<ProjectsSearchParams>;
}) {
  const params = await searchParams;
  if (
    params.requestFailure !== "active_workspace_mismatch" ||
    !params.workspaceId
  ) {
    return null;
  }
  return (
    <WorkspaceMismatchNotice
      workspaceId={params.workspaceId}
      workspaceName={params.workspaceName?.slice(0, 120) || "another Workspace"}
      returnTo={params.returnTo || "/projects"}
    />
  );
}

async function ProjectsHeaderAction() {
  const appUser = await admitWorkspacePage("content.view");
  if (
    appUser.workspace.role === "viewer" ||
    appUser.workspace.status !== "active"
  ) {
    return null;
  }
  return (
    <Button asChild>
      <Link href="/upload">New upload</Link>
    </Button>
  );
}

async function ProjectsData({
  searchParams,
}: {
  searchParams: Promise<ProjectsSearchParams>;
}) {
  const appUser = await admitWorkspacePage("content.view");
  const params = await searchParams;
  const query = params.q?.trim().slice(0, 200) ?? "";
  const status = PROJECT_STATUSES.has(params.status as ProjectListStatusFilter)
    ? (params.status as ProjectListStatusFilter)
    : "all";
  const source = PROJECT_SOURCES.has(params.source as ProjectListSourceFilter)
    ? (params.source as ProjectListSourceFilter)
    : "all";
  const sort = PROJECT_SORTS.has(params.sort as ProjectListSort)
    ? (params.sort as ProjectListSort)
    : "newest";
  const [page, folders] = await Promise.all([
    projectService.listProjectsWithStatsPage(appUser.actorUserId, {
      workspaceId: appUser.workspaceId,
      folderId: params.folder,
      query,
      status,
      source,
      sort,
    }),
    workspaceLibraryService.listFolders(appUser.actorUserId, appUser.workspaceId,
    ),
  ]);
  const items = page.items;
  const canEdit =
    appUser.workspace.role !== "viewer" &&
    (appUser.workspace.status === "active" ||
      appUser.workspace.role === "owner");
  const canCreate =
    appUser.workspace.role !== "viewer" &&
    appUser.workspace.status === "active";
  const retentionBanner =
    appUser.workspace.pricingTier === "free" && isRetentionEnforcementActive()
      ? (
      <RetentionBanner />
    ) : null;
  const hasFilters =
    query !== "" || status !== "all" || source !== "all" || Boolean(params.folder);

  if (items.length === 0 && !hasFilters) {
    return (
      <Stack gap="5">
        <FoldersPanel folders={folders.map((folder) => ({ id: folder.id, name: folder.name, count: folder._count.projects,
          }))} activeFolderId={params.folder ?? null} canEdit={canEdit} />
        {retentionBanner}
        <EmptyState
          icon={<FolderOpen size={22} strokeWidth={1.5} />}
          title="No projects yet"
          description="Import your first piece of content to get started."
          action={canCreate ? (
            <Button size="sm" variant="outline" asChild>
              <Link href="/upload">Start upload</Link>
            </Button>
          ) : undefined}
        />
      </Stack>
    );
  }

  return (
    <Stack gap="5">
      <FoldersPanel folders={folders.map((folder) => ({ id: folder.id, name: folder.name, count: folder._count.projects,
        }))} activeFolderId={params.folder ?? null} canEdit={canEdit} />
      {retentionBanner}
      <ProjectsExplorer
        initialProjects={items}
        initialNextCursor={page.nextCursor}
        totalCount={page.totalCount}
        initialStatusCounts={page.statusCounts}
        initialQuery={query}
        initialStatus={status}
        initialSource={source}
        initialSort={sort}
        folderId={params.folder}
        folders={folders.map((folder) => ({ id: folder.id, name: folder.name,
        }))}
        canEdit={canEdit}
      />
    </Stack>
  );
}
