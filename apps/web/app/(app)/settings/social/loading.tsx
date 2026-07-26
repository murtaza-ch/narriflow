import { Box, Flex, Skeleton, Stack } from "@chakra-ui/react";

export default function SocialAccountsLoading() {
  return (
    <Stack gap="8">
      {/* PageHeader: eyebrow · rule · title · description */}
      <Box>
        <Skeleton variant="shine" height="11px" width="60px" mb="2" />
        <Box h="1.5px" bg="border.strong" />
        <Stack gap="2" pt="4">
          <Skeleton variant="shine" height="30px" width="220px" />
          <Skeleton variant="shine" height="14px" width="420px" maxW="full" />
        </Stack>
      </Box>

      {/* Platform hairline rows: stripe gutter · icon tile · text · button */}
      <Box>
        <Skeleton variant="shine" height="11px" width="70px" mb="2" />
        <Stack gap="0" layerStyle="band" pt="0">
          {Array.from({ length: 5 }).map((_, index) => (
            <Flex
              key={index}
              gap="3"
              align="flex-start"
              py="3.5"
              pl="4"
              borderBottomWidth="1px"
              borderColor="border"
            >
              <Skeleton
                variant="shine"
                boxSize="10"
                borderRadius="l2"
                flexShrink={0}
              />
              <Flex align="center" justify="space-between" gap="3.5" flex="1">
                <Stack gap="1.5" flex="1">
                  <Flex align="center" gap="3">
                    <Skeleton variant="shine" height="14px" width="120px" />
                    <Skeleton variant="shine" height="11px" width="80px" />
                  </Flex>
                  <Skeleton variant="shine" height="12px" width="60%" />
                </Stack>
                <Skeleton
                  variant="shine"
                  height="32px"
                  width="100px"
                  borderRadius="l2"
                  flexShrink={0}
                />
              </Flex>
            </Flex>
          ))}
        </Stack>
      </Box>
    </Stack>
  );
}
