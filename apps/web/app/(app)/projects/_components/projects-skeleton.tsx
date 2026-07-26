import { Box, Flex, HStack, SimpleGrid, Skeleton, Stack } from "@chakra-ui/react";
import { Toolbar } from "@narriflow/ui/components/toolbar";

/**
 * ProjectsGridSkeleton — 1:1 mirror of the real explorer: the actual Toolbar
 * chrome (same minH/py/gaps) holding placeholder controls at their real
 * rendered sizes, above the de-carded grid of 16:9 wells with the exact
 * title / score / meta text block underneath.
 */
export function ProjectsGridSkeleton() {
  return (
    <Stack gap="5">
      <ToolbarSkeleton />
      <SimpleGrid columns={{ base: 1, sm: 2, lg: 3, "2xl": 4 }} gap="5">
        {Array.from({ length: 8 }).map((_, index) => (
          <Box
            key={index}
            animation="fade-up"
            animationFillMode="backwards"
            style={{ animationDelay: `${index * 60}ms` }}
          >
            <SkeletonCard />
          </Box>
        ))}
      </SimpleGrid>
    </Stack>
  );
}

/** Real chip label widths: All · Ready · Processing · Queued · Failed. */
const CHIP_WIDTHS = [46, 62, 94, 70, 62];

function ToolbarSkeleton() {
  return (
    <Toolbar h="auto" minH="12" py="2" flexWrap="wrap" gap="2" columnGap="3">
      {/* Search input — 32px control */}
      <Skeleton
        variant="pulse"
        bg="bg.muted"
        h="8"
        w={{ base: "full", md: "220px" }}
        flexShrink={0}
        borderRadius="l2"
      />

      {/* Status chips — text-height ghosts inside the 32px row */}
      <HStack gap="1" display={{ base: "none", md: "flex" }}>
        {CHIP_WIDTHS.map((width, index) => (
          <Skeleton
            key={index}
            variant="pulse"
            bg="bg.muted"
            h="6"
            style={{ width: `${width}px` }}
            borderRadius="l2"
          />
        ))}
      </HStack>

      <Box flex="1" minW="2" />

      {/* "N of N shown" counter */}
      <Skeleton
        variant="pulse"
        bg="bg.muted"
        h="10px"
        w="88px"
        flexShrink={0}
        borderRadius="l1"
        display={{ base: "none", sm: "block" }}
      />

      {/* Source select · sort select · view toggle — all 32px controls */}
      <HStack gap="2" flexShrink={0}>
        <Skeleton variant="pulse" bg="bg.muted" h="8" w="128px" borderRadius="l2" />
        <Skeleton variant="pulse" bg="bg.muted" h="8" w="136px" borderRadius="l2" />
        <Skeleton variant="pulse" bg="bg.muted" h="8" w="80px" borderRadius="l2" />
      </HStack>
    </Toolbar>
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
        {/* Title (up to two 14px lines) beside the sm ScoreMeter */}
        <Flex align="flex-start" justify="space-between" gap="3">
          <Stack gap="1.5" flex="1" minW="0" pt="0.5">
            <Skeleton variant="pulse" bg="bg.muted" h="14px" w="90%" borderRadius="l1" />
            <Skeleton variant="pulse" bg="bg.muted" h="14px" w="55%" borderRadius="l1" />
          </Stack>
          {/* ScoreMeter: 14px numeral over the 24px × 3px track */}
          <Stack gap="1" align="flex-start" flexShrink={0} pt="0.5">
            <Skeleton variant="pulse" bg="bg.muted" h="14px" w="18px" borderRadius="l1" />
            <Skeleton variant="pulse" bg="bg.muted" h="3px" w="24px" borderRadius="full" />
          </Stack>
        </Flex>

        {/* StatusBadge (square + eyebrow) · meta line */}
        <HStack gap="2.5" h="16px" align="center">
          <Skeleton
            variant="pulse"
            bg="bg.muted"
            w="8px"
            h="8px"
            borderRadius="2px"
            flexShrink={0}
          />
          <Skeleton variant="pulse" bg="bg.muted" h="10px" w="56px" borderRadius="l1" />
          <Skeleton variant="pulse" bg="bg.muted" h="10px" w="45%" borderRadius="l1" />
        </HStack>
      </Stack>
    </Stack>
  );
}
