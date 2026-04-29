import {
  AspectRatio,
  Box,
  Flex,
  SimpleGrid,
  Skeleton,
  Stack,
} from "@chakra-ui/react";

export function ProjectsGridSkeleton() {
  return (
    <Stack gap="20px">
      <Skeleton
        variant="shine"
        height="92px"
        borderRadius="14px"
      />
      <SimpleGrid columns={{ base: 1, sm: 2, lg: 3, "2xl": 4 }} gap="20px">
        {Array.from({ length: 6 }).map((_, index) => (
          <SkeletonCard key={index} />
        ))}
      </SimpleGrid>
    </Stack>
  );
}

function SkeletonCard() {
  return (
    <Box
      overflow="hidden"
      borderRadius="14px"
      borderWidth="1px"
      borderColor="border"
      bg="bg.panel"
    >
      <AspectRatio ratio={16 / 9}>
        <Skeleton variant="shine" />
      </AspectRatio>
      <Stack p="16px" gap="10px">
        <Skeleton variant="shine" height="10px" width="80px" />
        <Skeleton variant="shine" height="14px" width="100%" />
        <Skeleton variant="shine" height="14px" width="60%" />
        <Box h="6px" />
        <Flex justify="space-between">
          <Skeleton variant="shine" height="10px" width="70px" />
          <Skeleton variant="shine" height="10px" width="50px" />
        </Flex>
      </Stack>
    </Box>
  );
}
