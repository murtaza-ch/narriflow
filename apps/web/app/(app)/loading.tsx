import { Box, Flex, Skeleton, Stack } from "@chakra-ui/react";

/**
 * Route-level skeleton for the app shell content region. The sidebar and top
 * bar persist in the layout; this mirrors the common PageHeader rhythm
 * (ink rule, title, and action) plus a band of hairline rows so
 * navigation feels app-like, not page-like.
 */
export default function AppLoading() {
  return (
    <Box w="full" aria-busy="true" aria-label="Loading page">
      {/* PageHeader silhouette */}
      <Box h="1.5px" bg="border.strong" animation="rule-in" />
      <Flex align="flex-start" justify="space-between" gap="4" wrap="wrap" pt="4">
        <Stack gap="2" minW="0" flex="1">
          <Skeleton h="7" w="60" maxW="70vw" />
        </Stack>
        <Skeleton h="9" w="28" borderRadius="l2" />
      </Flex>

      {/* Content rows — hairline-divided list silhouette */}
      <Stack gap="0" mt="10">
        {[0, 1, 2, 3].map((row) => (
          <Flex
            key={row}
            align="center"
            gap="4"
            py="4"
            borderBottomWidth="1px"
            borderColor="border.subtle"
          >
            <Skeleton boxSize="9" borderRadius="l1" flexShrink={0} />
            <Stack gap="1.5" flex="1" minW="0">
              <Skeleton h="3" w="48" maxW="50vw" />
              <Skeleton h="2.5" w="32" maxW="35vw" />
            </Stack>
            <Skeleton h="3" w="16" display={{ base: "none", md: "block" }} />
          </Flex>
        ))}
      </Stack>
    </Box>
  );
}
