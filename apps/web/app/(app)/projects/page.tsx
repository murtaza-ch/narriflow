import { Suspense } from "react";
import Link from "next/link";
import { Stack } from "@chakra-ui/react";
import { FolderOpen } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { requireCurrentAppUser } from "@narriflow/auth";
import { projectService } from "@narriflow/services";
import { ProjectsExplorer } from "./_components/projects-explorer";
import { ProjectsGridSkeleton } from "./_components/projects-skeleton";

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
export default function ProjectsPage() {
  return (
    <Stack gap="8">
      <PageHeader
        eyebrow="Library"
        title="Projects"
        description="Manage imports, queue transcription, and review project progress."
        actions={
          <Button asChild>
            <Link href="/upload">New upload</Link>
          </Button>
        }
      />

      {/* No entrance animation on this wrapper: the grid's own staggered
          card fade-up is the entrance, and wrapping the boundary in a second
          fade-up meant the region animated in with the skeleton and then the
          cards animated in again on resolve. */}
      <Suspense fallback={<ProjectsGridSkeleton />}>
        <ProjectsData />
      </Suspense>
    </Stack>
  );
}

async function ProjectsData() {
  const appUser = await requireCurrentAppUser();
  const page = await projectService.listProjectsWithStatsPage(appUser.id);
  const items = page.items;

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<FolderOpen size={22} strokeWidth={1.5} />}
        title="No projects yet"
        description="Import your first piece of content to get started."
        action={
          <Button size="sm" variant="outline" asChild>
            <Link href="/upload">Start upload</Link>
          </Button>
        }
      />
    );
  }

  return (
    <ProjectsExplorer
      initialProjects={items}
      initialNextCursor={page.nextCursor}
      totalCount={page.totalCount}
    />
  );
}
