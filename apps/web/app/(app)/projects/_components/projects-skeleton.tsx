import { Flex, Grid, Skeleton, Stack } from "@chakra-ui/react";

/**
 * ProjectsGridSkeleton — 1:1 mirror of the real explorer: the right-aligned
 * filter + view controls above the grid of 16:9 wells with the date / title
 * text block underneath.
 *
 * The cards carry no entrance animation on purpose. A skeleton is a
 * placeholder held in reserved space, not an arrival — giving it the same
 * staggered fade-up as the real cards made the grid animate in twice per
 * navigation (once for the placeholder, once on resolve). The pulse is the
 * only motion it needs; the fade-up belongs to the content that replaces it.
 */
export function ProjectsGridSkeleton() {
  return (
    <Stack gap="5">
      <ToolbarSkeleton />
      <Grid
        gap="4"
        templateColumns="repeat(auto-fill, minmax(min(100%, 260px), 1fr))"
      >
        {Array.from({ length: 8 }).map((_, index) => (
          <SkeletonCard key={index} />
        ))}
      </Grid>
    </Stack>
  );
}

function ToolbarSkeleton() {
  return (
    <Flex justify="flex-end" gap="2">
      {/* Filters icon button · grid/list toggle — both 36px controls */}
      <Skeleton variant="pulse" bg="bg.muted" boxSize="9" borderRadius="l1" />
      <Skeleton variant="pulse" bg="bg.muted" h="9" w="84px" borderRadius="l2" />
    </Flex>
  );
}

function SkeletonCard() {
  return (
    <Stack gap="3">
      {/* MediaWell stand-in — same border-box 16:9 footprint and radius */}
      <Skeleton
        variant="pulse"
        bg="bg.muted"
        aspectRatio={16 / 9}
        borderRadius="l2"
      />

      <Stack gap="1.5">
        {/* Date line, then the title (up to two 14px lines) */}
        <Skeleton variant="pulse" bg="bg.muted" h="12px" w="40%" borderRadius="l1" />
        <Skeleton variant="pulse" bg="bg.muted" h="14px" w="90%" borderRadius="l1" />
        <Skeleton variant="pulse" bg="bg.muted" h="14px" w="55%" borderRadius="l1" />
      </Stack>
    </Stack>
  );
}
