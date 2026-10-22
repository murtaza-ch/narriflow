import { Box, Flex, SimpleGrid, Skeleton, Stack } from "@chakra-ui/react";

/** Shared loading layouts use the same panels and spacing as their destination. */
export function PageLoading({
  layout = "rows",
  label = "Loading page",
}: {
  layout?: "rows" | "library" | "import" | "settings";
  label?: string;
}) {
  return (
    <Stack gap="8" w="full" aria-busy="true" aria-label={label}>
      <Flex justify="space-between" gap="4" align="center">
        <Stack gap="3" flex="1">
          <Skeleton h="8" w="56" maxW="70%" />
          <Skeleton h="3" w="80" maxW="80%" />
        </Stack>
        <Skeleton h="9" w="24" borderRadius="full" />
      </Flex>
      {layout === "import" ? (
        <Stack gap="7" maxW="780px" w="full" mx="auto">
          <SimpleGrid columns={3} gap="4">
            {[0, 1, 2].map((i) => (
              <Stack key={i} gap="3">
                <Skeleton h={{ base: "24", md: "36" }} borderRadius="l2" />
                <Skeleton h="3" w="24" maxW="full" />
                <Skeleton h="3" w="full" />
              </Stack>
            ))}
          </SimpleGrid>
          <Skeleton h="12" borderRadius="full" />
          <Flex justify="space-between">
            <Skeleton h="3" w="32" />
            <Skeleton h="9" w="28" borderRadius="full" />
          </Flex>
        </Stack>
      ) : layout === "library" ? (
        <SimpleGrid columns={{ base: 1, sm: 2, xl: 3 }} gap="5">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Stack key={i} gap="3">
              <Skeleton aspectRatio={16 / 9} borderRadius="l2" />
              <Skeleton h="4" w="80%" />
              <Skeleton h="3" w="50%" />
            </Stack>
          ))}
        </SimpleGrid>
      ) : (
        <Stack gap="3">
          {[0, 1, 2].map((i) => (
            <Flex
              key={i}
              p="5"
              gap="4"
              align="center"
              bg="bg.panel"
              borderWidth="1px"
              borderColor="border.card"
              borderRadius="l2"
            >
              <Skeleton boxSize="10" borderRadius="l2" flexShrink={0} />
              <Stack gap="3" flex="1" minW="0">
                <Skeleton h="4" w="44" maxW="80%" />
                <Skeleton h="3" w="72" maxW="90%" />
              </Stack>
              <Box display={{ base: "none", md: "block" }}>
                <Skeleton h="9" w="24" borderRadius="full" />
              </Box>
            </Flex>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
