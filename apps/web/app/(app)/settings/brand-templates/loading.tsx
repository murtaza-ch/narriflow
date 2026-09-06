import { Box, Flex, Grid, Skeleton, Stack } from "@chakra-ui/react";

export default function BrandTemplatesLoading() {
  return (
    <Stack gap="8">
      {/* PageHeader: rule, title/description, and action. */}
      <Box>
        <Box h="1.5px" bg="border.strong" />
        <Flex align="flex-start" justify="space-between" gap="4" pt="4">
          <Stack gap="2" flex="1">
            <Skeleton variant="shine" height="30px" width="240px" />
            <Skeleton variant="shine" height="14px" width="70%" />
          </Stack>
          <Skeleton variant="shine" height="40px" width="130px" borderRadius="l2" />
        </Flex>
      </Box>

      {/* Two band sections of 9:16 preview tiles + radio/name/menu meta row */}
      {Array.from({ length: 2 }).map((_, section) => (
        <Box key={section}>
          <Skeleton variant="shine" height="11px" width="100px" mb="2" />
          <Box layerStyle="band">
            <Grid
              templateColumns={{
                base: "repeat(2, 1fr)",
                md: "repeat(3, 1fr)",
                lg: "repeat(4, 1fr)",
              }}
              gap="4"
            >
              {Array.from({ length: 4 }).map((_, index) => (
                <Stack key={index} gap="2">
                  <Skeleton variant="shine" borderRadius="l2" css={{ aspectRatio: "9 / 16" }} />
                  <Flex align="center" justify="space-between" gap="1">
                    <Flex align="center" gap="1.5" minW="0" flex="1">
                      <Skeleton
                        variant="shine"
                        boxSize="3.5"
                        borderRadius="full"
                        flexShrink={0}
                      />
                      <Skeleton variant="shine" height="13px" width="60%" />
                    </Flex>
                    <Skeleton
                      variant="shine"
                      boxSize="6"
                      borderRadius="l1"
                      flexShrink={0}
                    />
                  </Flex>
                </Stack>
              ))}
            </Grid>
          </Box>
        </Box>
      ))}
    </Stack>
  );
}
