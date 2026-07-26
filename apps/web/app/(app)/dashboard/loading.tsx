import { Box, SimpleGrid, Skeleton, Stack } from "@chakra-ui/react";

/**
 * Mirrors the dashboard 1:1: hero band (eyebrow, headline, description,
 * paste-link row, secondary action) then the recent-projects grid of
 * card skeletons (matching the projects page's SkeletonCard footprint).
 */
export default function DashboardLoading() {
  return (
    <Stack gap="8" maxW="1080px" mx="auto">
      {/* Hero */}
      <Box
        borderWidth="1px"
        borderColor="border"
        borderRadius="l2"
        p={{ base: 6, md: 10 }}
      >
        <Stack gap="5" align="center" maxW="560px" mx="auto">
          <Skeleton variant="shine" height="2.5" width="32" />
          <Stack gap="2" align="center" w="full">
            <Skeleton variant="shine" height="9" width="80%" maxW="440px" />
            <Skeleton variant="shine" height="9" width="55%" maxW="260px" />
          </Stack>
          <Skeleton variant="shine" height="4" width="90%" maxW="400px" />

          <Stack gap="2" w="full" maxW="480px" pt="2">
            <Skeleton variant="shine" height="12" width="full" borderRadius="l2" />
            <Skeleton variant="shine" height="3" width="40%" maxW="200px" />
          </Stack>

          <Stack gap="2" align="center" pt="3">
            <Skeleton variant="shine" height="3" width="6" />
            <Skeleton variant="shine" height="9" width="40" borderRadius="l2" />
            <Skeleton variant="shine" height="3" width="52" maxW="full" />
          </Stack>
        </Stack>
      </Box>

      {/* Recent projects */}
      <Box>
        <Skeleton variant="shine" height="2.5" width="32" mb="2" />
        <Box layerStyle="band">
          <SimpleGrid columns={{ base: 1, sm: 2, lg: 3, "2xl": 4 }} gap="5">
            {Array.from({ length: 8 }).map((_, index) => (
              <SkeletonCard key={index} />
            ))}
          </SimpleGrid>
        </Box>
      </Box>
    </Stack>
  );
}

function SkeletonCard() {
  return (
    <Stack gap="3">
      <Skeleton variant="shine" aspectRatio={16 / 9} borderRadius="l2" />
      <Stack gap="1.5">
        <Skeleton variant="shine" height="14px" width="90%" />
        <Skeleton variant="shine" height="14px" width="55%" />
        <Skeleton variant="shine" height="10px" width="45%" />
      </Stack>
    </Stack>
  );
}
