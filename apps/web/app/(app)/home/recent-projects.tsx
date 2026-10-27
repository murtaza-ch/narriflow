import Link from "next/link";
import { Heading, SimpleGrid, Stack } from "@chakra-ui/react";
import { FolderOpen } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import type { ProjectListItem } from "@narriflow/services";
import { ProjectCard } from "../projects/_components/project-card";

export function RecentProjects({
  items,
  canCreate,
}: {
  items: ProjectListItem[];
  canCreate: boolean;
}) {
  return (
    <Stack as="section" gap="5">
      <Heading as="h2" fontSize="md" fontWeight="500">
        Recent projects
      </Heading>
      {items.length === 0 ? (
        <EmptyState
          icon={<FolderOpen size={20} />}
          title="No projects yet"
          description={canCreate ? "Your imported videos and clips will appear here." : "Videos your team imports will appear here."}
          action={
            canCreate ? (
              <Button asChild>
                <Link href="/upload">Import a video</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <SimpleGrid columns={{ base: 1, sm: 2, xl: 3 }} gap="5">
          {items.map((project, index) => (
            <ProjectCard key={project.id} project={project} priority={index < 3} canDelete={canCreate} />
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}
