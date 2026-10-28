import { Box, Flex, Grid, Stack } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";

/** Exports, grid view: header, filter row, status + layout switches, then 9:16 export cards in their 2/3/4/5-column grid. */
export default function ExportsLoading() {
  return (
    <LoadingScreen label="Loading Exports" gap="6">
      <Box mb="2">
        <PageHeader title="Exports" description="Every rendered clip, ready to download." />
      </Box>

      <Flex gap="2" wrap="wrap" align="center">
        <Bone h="9" flex={{ base: "1 1 100%", md: "1 1 240px" }} maxW={{ md: "340px" }} borderRadius="control" />
        <Bone h="9" w="200px" borderRadius="control" />
        <Bone h="9" w="140px" borderRadius="control" />
        <Bone h="9" w="150px" borderRadius="control" />
        <Bone h="9" w="150px" borderRadius="control" />
      </Flex>

      <Flex gap="3" wrap="wrap" align="center" justify="space-between">
        <Bone h="9" w="64" borderRadius="control" />
        <Bone h="9" w="36" borderRadius="control" />
      </Flex>

      <Grid
        templateColumns={{ base: "repeat(2, minmax(0, 1fr))", md: "repeat(3, minmax(0, 1fr))", lg: "repeat(4, minmax(0, 1fr))", xl: "repeat(5, minmax(0, 1fr))" }}
        gap="4"
        rowGap="6"
      >
        {Array.from({ length: 10 }, (_, index) => (
          <Stack key={index} gap="3" minW="0">
            <Bone aspectRatio={9 / 16} borderRadius="l2" />
            <Stack gap="1.5">
              <Bone h="3.5" w="90%" />
              <Bone h="3" w="60%" />
              <Bone h="3" w="40%" />
            </Stack>
            <Bone h="8" w="24" borderRadius="control" />
          </Stack>
        ))}
      </Grid>
    </LoadingScreen>
  );
}
