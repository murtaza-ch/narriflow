import { Box, Flex, Grid, Stack } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";
import { BrandTabsLoading } from "./_components/brand-kit-loading";

/** Brand kit, Profiles tab: header with its one action, the tab bar, and the profile cards in their 1/2/3-column grid. */
export default function BrandKitLoading() {
  return (
    <LoadingScreen label="Loading Brand kit">
      <PageHeader
        title="Brand kit"
        description="Manage your brand colors, fonts, assets, and caption styles."
        actions={<Bone h="9" w="28" borderRadius="control" />}
      />
      <Stack gap="6">
        <BrandTabsLoading labels={["Profiles", "Caption styles", "Fonts"]} counted={["Profiles", "Caption styles", "Fonts"]} />
        <Grid templateColumns={{ base: "1fr", md: "repeat(2, minmax(0, 1fr))", xl: "repeat(3, minmax(0, 1fr))" }} gap="4">
          {[0, 1, 2].map((index) => (
            <ProfileCardLoading key={index} />
          ))}
        </Grid>
      </Stack>
    </LoadingScreen>
  );
}

/** A profile card: 16:9 cover, then mark + name + palette dots, then the four counts. */
function ProfileCardLoading() {
  return (
    <Box bg="bg.subtle" borderRadius="l3" overflow="hidden">
      <Bone aspectRatio={16 / 9} borderRadius="0" />
      <Stack gap="3.5" p="4">
        <Flex align="center" gap="3">
          <Bone boxSize="10" borderRadius="10px" flexShrink={0} />
          <Stack gap="3" flex="1" minW="0">
            <Bone h="4" w="36" maxW="full" />
            <Bone h="3.5" w="52" maxW="full" />
          </Stack>
          <Bone h="3.5" w="50px" borderRadius="full" flexShrink={0} />
        </Flex>
        <Flex gap="4" h="4.5" align="center">
          {[0, 1, 2, 3].map((index) => (
            <Bone key={index} h="3" w="14" />
          ))}
        </Flex>
      </Stack>
    </Box>
  );
}
