import { Suspense } from "react";
import Link from "next/link";
import { Stack } from "@chakra-ui/react";
import { FolderOpen } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { SectionHeader } from "@narriflow/ui/components/section-header";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { requireCurrentAppUser } from "@narriflow/auth";
import { projectService } from "@narriflow/services";
import { ProjectsExplorer } from "./_components/projects-explorer";
import { ProjectsGridSkeleton } from "./_components/projects-skeleton";

export default async function ProjectsPage() {
  const appUser = await requireCurrentAppUser();

  return (
    <Stack gap="32px">
      <SectionHeader
        title="Projects"
        description="Manage imports, queue transcription, and review project progress."
        action={
          <Button asChild>
            <Link href="/upload">New Upload</Link>
          </Button>
        }
      />

      <Suspense fallback={<ProjectsGridSkeleton />}>
        <ProjectsData userId={appUser.id} />
      </Suspense>
    </Stack>
  );
}

async function ProjectsData({ userId }: { userId: string }) {
  const items = await projectService.listProjectsWithStats(userId);

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<FolderOpen size={22} />}
        title="No projects yet"
        description="Import your first piece of content to get started."
        action={
          <Button size="sm" asChild>
            <Link href="/upload">Start Upload</Link>
          </Button>
        }
      />
    );
  }

  return <ProjectsExplorer initialProjects={items} />;
}
