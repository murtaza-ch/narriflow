import { Box, Flex, SimpleGrid, Skeleton, Stack } from "@chakra-ui/react";

export default function HomeLoading() {
  return (
    <Stack gap="10" aria-busy="true" aria-label="Loading dashboard">
      <Stack gap="5" pt="5">
        <Skeleton h={{ base: "9", md: "12" }} w="64" />
        <Skeleton h="4" w="96" maxW="90%" />
        <Skeleton h="16" w="full" maxW="740px" borderRadius="l3" mt="3" />
        <Skeleton h="3" w="60" />
      </Stack>
      <SimpleGrid columns={{ base: 2, xl: 4 }} gap="3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} h="20" borderRadius="l2" />
        ))}
      </SimpleGrid>
      <Flex justify="space-between">
        <Skeleton h="5" w="36" />
        <Skeleton h="5" w="24" />
      </Flex>
      <SimpleGrid columns={{ base: 1, sm: 2, xl: 3 }} gap="5">
        {[0, 1, 2].map((i) => (
          <Stack key={i} gap="3">
            <Skeleton aspectRatio={16 / 9} borderRadius="l2" />
            <Skeleton h="4" w="80%" />
            <Skeleton h="3" w="50%" />
          </Stack>
        ))}
      </SimpleGrid>
      <Box>
        <Skeleton h="24" borderRadius="l2" />
      </Box>
    </Stack>
  );
}
