import { AspectRatio, Box, Flex, Grid, Skeleton, Stack } from "@chakra-ui/react";

export default function EditBrandTemplateLoading() {
  return (
    <Stack gap="8">
      {/* PageHeader: eyebrow · rule · title/description · action */}
      <Box>
        <Skeleton variant="shine" height="11px" width="140px" mb="2" />
        <Box h="1.5px" bg="border.strong" />
        <Flex align="flex-start" justify="space-between" gap="4" pt="4">
          <Stack gap="2" flex="1">
            <Skeleton variant="shine" height="30px" width="260px" />
            <Skeleton variant="shine" height="14px" width="60%" />
          </Stack>
          <Skeleton variant="shine" height="40px" width="90px" borderRadius="l2" />
        </Flex>
      </Box>

      {/* Form bands left, phone-frame preview right */}
      <Grid
        templateColumns={{ base: "1fr", lg: "minmax(0, 1fr) 320px" }}
        gap={{ base: "8", lg: "12" }}
        alignItems="start"
      >
        <Stack gap="8" minW="0">
          {Array.from({ length: 4 }).map((_, index) => (
            <Box key={index}>
              <Skeleton variant="shine" height="11px" width="80px" mb="2" />
              <Box layerStyle="band">
                <Stack gap="4">
                  <Skeleton variant="shine" height="36px" width="60%" borderRadius="l2" />
                  <Skeleton variant="shine" height="36px" width="80%" borderRadius="l2" />
                </Stack>
              </Box>
            </Box>
          ))}
          {/* Footer: hairline rule + submit button, right-aligned */}
          <Flex justify="flex-end" borderTopWidth="1px" borderColor="border" pt="5">
            <Skeleton variant="shine" height="40px" width="140px" borderRadius="l2" />
          </Flex>
        </Stack>

        {/* Phone frame + live-preview meta lines */}
        <Stack gap="3" justifySelf="center" align={{ base: "center", lg: "flex-start" }}>
          <Box w={{ base: "240px", lg: "280px" }}>
            <AspectRatio ratio={9 / 16}>
              <Skeleton variant="shine" borderRadius="18px" />
            </AspectRatio>
          </Box>
          <Stack gap="1.5" px="1" w={{ base: "240px", lg: "280px" }}>
            <Skeleton variant="shine" height="11px" width="70px" />
            <Skeleton variant="shine" height="13px" width="140px" />
            <Skeleton variant="shine" height="11px" width="180px" />
          </Stack>
        </Stack>
      </Grid>
    </Stack>
  );
}
