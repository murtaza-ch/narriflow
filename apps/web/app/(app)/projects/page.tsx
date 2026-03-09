import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { SectionHeader } from "@narriflow/ui/components/section-header";
import { StatusBadge } from "@narriflow/ui/components/status-badge";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { requireCurrentAppUser } from "@narriflow/auth";
import { projectService } from "@narriflow/services";
import { Stack, Box, Text, Flex } from "@chakra-ui/react";
import { FolderOpen, ChevronRight } from "lucide-react";

export default async function ProjectsPage() {
  const appUser = await requireCurrentAppUser();
  const projects = await projectService.listProjects(appUser.id);

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

      {projects.length === 0 ? (
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
      ) : (
        <Stack gap="8px">
          {projects.map((project) => (
            <Link key={project.id} href={`/projects/${project.id}`} style={{ textDecoration: "none" }}>
              <Flex
                align="center"
                justify="space-between"
                gap="16px"
                borderRadius="12px"
                borderWidth="1px"
                borderColor="border"
                bg="bg.panel"
                p="16px"
                transition="border-color 150ms ease"
                _hover={{ borderColor: "border.accent" }}
              >
                <Box overflow="hidden">
                  <Text fontSize="14px" fontWeight="500" color="fg" truncate>
                    {project.title}
                  </Text>
                  <Text fontSize="12px" color="fg.subtle" mt="2px" truncate>
                    {project.sourceMediaUrl}
                  </Text>
                </Box>
                <Flex align="center" gap="12px" flexShrink={0}>
                  <StatusBadge status={project.ingestStatus as "queued" | "processing" | "ready" | "failed"} />
                  <ChevronRight size={16} color="var(--chakra-colors-fg-subtle)" />
                </Flex>
              </Flex>
            </Link>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
