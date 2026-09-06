import { Box, Flex, Skeleton, Stack } from "@chakra-ui/react";

/** Mirrors the autopilot console: header band + hairline rule rows. */
export default function AutopilotLoading() {
  return (
    <Stack gap="8" maxW="1080px" mx="auto">
      {/* Page header: rule, title, and action. */}
      <Box>
        <Box h="1.5px" bg="border.strong" />
        <Flex justify="space-between" align="flex-start" gap="4" wrap="wrap" pt="4">
          <Stack gap="1.5" flex="1" minW="0">
            <Skeleton variant="shine" height="9" width="40" />
          </Stack>
          <Skeleton variant="shine" height="10" width="28" borderRadius="l2" />
        </Flex>
      </Box>

      {/* Rules band: eyebrow + count chip, then hairline rows with status stripes */}
      <Box>
        <Flex align="center" gap="2.5" mb="2">
          <Skeleton variant="shine" height="2.5" width="12" />
          <Skeleton variant="shine" height="5" width="6" borderRadius="l1" />
        </Flex>
        <Box layerStyle="band" pt="0">
          {Array.from({ length: 3 }).map((_, index) => (
            <Box
              key={index}
              position="relative"
              borderBottomWidth="1px"
              borderBottomColor="border.subtle"
            >
              <Box
                position="absolute"
                insetInlineStart="0"
                top="4"
                bottom="4"
                w="3px"
                borderRadius="full"
                bg="bg.muted"
              />
              <Flex ps="5" pe="2" py="4" gap="4" align="center">
                <Stack gap="2" flex="1" minW="0">
                  <Skeleton variant="shine" height="3.5" width="44" maxW="full" />
                  <Skeleton variant="shine" height="3" width="64" maxW="full" />
                  <Skeleton variant="shine" height="3" width="80" maxW="full" />
                </Stack>
                <Flex gap="2" align="center" flexShrink={0}>
                  <Skeleton variant="shine" height="5" width="9" borderRadius="full" />
                  <Skeleton variant="shine" height="8" width="20" borderRadius="l2" />
                  <Skeleton variant="shine" height="8" width="8" borderRadius="l2" />
                </Flex>
              </Flex>
            </Box>
          ))}
        </Box>
      </Box>
    </Stack>
  );
}
