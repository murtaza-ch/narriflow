import { Suspense } from "react";
import Link from "next/link";
import { Box, Stack } from "@chakra-ui/react";
import { FolderOpen } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { requireCurrentAppUser } from "@narriflow/auth";
import { projectService } from "@narriflow/services";
import { ProjectsExplorer } from "./_components/projects-explorer";
import { ProjectsGridSkeleton } from "./_components/projects-skeleton";

export default async function ProjectsPage() {
  const appUser = await requireCurrentAppUser();

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

      <Box
        animation="fade-up"
        animationFillMode="backwards"
        style={{ animationDelay: "60ms" }}
      >
        <Suspense fallback={<ProjectsGridSkeleton />}>
          <ProjectsData userId={appUser.id} />
        </Suspense>
      </Box>
    </Stack>
  );
}

async function ProjectsData({ userId }: { userId: string }) {
  const page = await projectService.listProjectsWithStatsPage(userId);
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
