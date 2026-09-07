import { Box, Flex, Grid, SimpleGrid, Skeleton, Stack } from "@chakra-ui/react";

/** Shared loading layouts use the same panels and spacing as their destination. */
export function PageLoading({
  layout = "rows",
  label = "Loading page",
}: {
  layout?: "rows" | "library" | "project" | "import" | "settings";
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
      ) : layout === "project" ? (
        <>
          <Flex gap="6" overflow="hidden">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} h="4" minW="16" />
            ))}
          </Flex>
          <Grid templateColumns={{ base: "1fr", xl: "210px minmax(0, 1fr)" }} gap="6">
            <Stack display={{ base: "none", xl: "flex" }} gap="3">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} h="16" borderRadius="l2" />
              ))}
            </Stack>
            <Stack gap="4">
              {[0, 1, 2].map((i) => (
                <Flex
                  key={i}
                  gap="6"
                  p="5"
                  bg="bg.panel"
                  borderWidth="1px"
                  borderColor="border"
                  borderRadius="l3"
                  direction={{ base: "column", md: "row" }}
                >
                  <Skeleton
                    w="200px"
                    maxW="full"
                    aspectRatio={9 / 16}
                    borderRadius="l2"
                    alignSelf="center"
                    flexShrink={0}
                  />
                  <Stack gap="5" flex="1">
                    <Skeleton h="6" w="85%" />
                    <Skeleton h="5" w="20" />
                    <Skeleton h="3" w="full" />
                    <Skeleton h="3" w="90%" />
                    <Skeleton h="3" w="70%" />
                    <Flex mt="auto" gap="2">
                      <Skeleton h="8" w="28" borderRadius="full" />
                      <Skeleton h="8" w="20" borderRadius="full" />
                    </Flex>
                  </Stack>
                </Flex>
              ))}
            </Stack>
          </Grid>
        </>
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
              borderColor="border"
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
