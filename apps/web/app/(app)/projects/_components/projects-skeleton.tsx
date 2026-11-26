import { Flex, Grid, Stack } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";
import { FolderPlus, Plus } from "lucide-react";

/**
 * ProjectsGridSkeleton — mirror of the explorer below the page header: the
 * filter and view controls on the right, then the grid of 16:9 wells, each
 * with its title (up to two lines) and its meta line underneath.
 *
 * The folders panel and the retention banner are left out on purpose: whether
 * they show depends on the workspace, so a placeholder would shift the grid
 * for everyone who has neither.
 *
 * The cards carry no entrance animation on purpose. A skeleton is a
 * placeholder held in reserved space, not an arrival — giving it the same
 * staggered fade-up as the real cards made the grid animate in twice per
 * navigation (once for the placeholder, once on resolve). The pulse is the
 * only motion it needs, and the content replaces it at once.
 */
export function ProjectsGridSkeleton() {
  return (
    <Stack gap="5">
      {/* Filters icon button · grid/list toggle — both 36px controls */}
      <Flex justify="flex-end" gap="2">
        <Bone boxSize="9" borderRadius="l2" />
        <Bone h="9" w="84px" borderRadius="control" />
      </Flex>
      <Grid gap="4" templateColumns="repeat(auto-fill, minmax(min(100%, 260px), 1fr))">
        {Array.from({ length: 8 }).map((_, index) => (
          <ProjectCardSkeleton key={index} />
        ))}
      </Grid>
    </Stack>
  );
}

/**
 * The page header as an editor sees it: the title, then "New folder" and
 * "New project" as hidden stand-ins inside bones, so the boxes are the
 * buttons' own. On a phone the actions sit under the title, so leaving them
 * out would move the grid when they arrive.
 */
export function ProjectsHeaderSkeleton() {
  return (
    <PageHeader
      title="Projects"
      actions={
        <Flex align="center" gap="2" aria-hidden>
          <Bone borderRadius="control">
            <Button asChild size="sm" variant="subtle">
              <span>
                <FolderPlus size={16} />
                New folder
              </span>
            </Button>
          </Bone>
          <Bone borderRadius="control">
            <Button asChild size="sm">
              <span>
                <Plus size={16} />
                New project
              </span>
            </Button>
          </Bone>
        </Flex>
      }
    />
  );
}

/** One project card: the well, then the title lines and the meta line. */
export function ProjectCardSkeleton() {
  return (
    <Stack gap="3">
      <Bone aspectRatio={16 / 9} borderRadius="l2" />
      <Stack gap="1">
        {/* Bones sit inside the real line boxes: 14px/1.35 title, 12px meta. */}
        <TextLine h="19px" w="90%" />
        <TextLine h="19px" w="55%" />
        <TextLine h="18px" w="40%" small />
      </Stack>
    </Stack>
  );
}

function TextLine({ h, w, small = false }: { h: string; w: string; small?: boolean }) {
  return (
    <Flex h={h} align="center">
      <Bone h={small ? "2.5" : "3"} w={w} />
    </Flex>
  );
}

/** The Projects page while it loads: the header, then the grid of wells. */
export function ProjectsListLoading() {
  return (
    <LoadingScreen label="Loading projects">
      <ProjectsHeaderSkeleton />
      <ProjectsGridSkeleton />
    </LoadingScreen>
  );
}
