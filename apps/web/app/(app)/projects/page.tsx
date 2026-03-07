import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { requireCurrentAppUser } from "@narriflow/auth";
import { projectService } from "@narriflow/services";
import { Stack, Box, Heading, Text, Flex } from "@chakra-ui/react";

export default async function ProjectsPage() {
  const appUser = await requireCurrentAppUser();
  const projects = await projectService.listProjects(appUser.id);

  return (
    <Box as="section">
      <Stack gap="8">
        <Stack gap="2">
          <Heading size="xl" fontWeight="semibold" letterSpacing="tight">Projects</Heading>
          <Text color="fg.muted">
            Manage imports, queue transcription, and review project progress.
          </Text>
        </Stack>

        <Box rounded="xl" borderWidth="1px" borderColor="border" p="6">
          <Text textStyle="sm" color="fg.muted">
            Start new imports from the dedicated upload flow.
          </Text>
          <Box mt="4">
            <Button asChild>
              <Link href="/upload">Open Upload Workspace</Link>
            </Button>
          </Box>
        </Box>

        <Stack gap="3">
          <Heading as="h2" size="lg" fontWeight="semibold">Recent Projects</Heading>
          {projects.length === 0 ? (
            <Text textStyle="sm" color="fg.muted">No projects yet.</Text>
          ) : (
            <Stack as="ul" gap="2">
              {projects.map((project) => (
                <Box
                  as="li"
                  key={project.id}
                  rounded="lg"
                  borderWidth="1px"
                  borderColor="border"
                  p="4"
                >
                  <Flex align="center" justify="space-between" gap="4">
                    <Box>
                      <Text fontWeight="medium">{project.title}</Text>
                      <Text textStyle="xs" color="fg.muted">
                        {project.sourceMediaUrl}
                      </Text>
                      <Text textStyle="xs" color="fg.muted">
                        Ingest: {project.ingestStatus}
                      </Text>
                    </Box>
                    <Button variant="outline" asChild>
                      <Link href={`/projects/${project.id}`}>Open</Link>
                    </Button>
                  </Flex>
                </Box>
              ))}
            </Stack>
          )}
        </Stack>
      </Stack>
    </Box>
  );
}
