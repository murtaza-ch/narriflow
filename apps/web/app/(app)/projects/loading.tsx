import Link from "next/link";
import { Box, Stack } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { ProjectsGridSkeleton } from "./_components/projects-skeleton";

/**
 * Route-level loading state — mirrors the final page exactly: the real
 * PageHeader (static content, so no pop-in on resolve) above the toolbar +
 * grid skeleton.
 */
export default function ProjectsLoading() {
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
        <ProjectsGridSkeleton />
      </Box>
    </Stack>
  );
}
