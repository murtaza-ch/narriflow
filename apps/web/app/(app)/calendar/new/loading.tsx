import { Box, Stack } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";

/** Choose a clip: the 760px column with header, search field and button, then the clip cards. */
export default function ChooseClipLoading() {
  return (
    <LoadingScreen label="Loading clips" gap="6" maxW="760px" mx="auto">
      <PageHeader
        title="Choose a clip"
        description="Open the publishing drawer to choose accounts, write a description, and schedule delivery."
        actions={<Bone h="9" w="36" borderRadius="control" />}
      />
      <Stack gap="2">
        <Bone h="9" borderRadius="control" />
        <Bone h="9" w="16" borderRadius="control" />
      </Stack>
      {[0, 1, 2, 3, 4].map((index) => (
        <Box key={index} p="4" bg="bg.panel" borderRadius="l3">
          <Bone h="4" w="64" maxW="80%" />
          <Bone h="3" w="40" maxW="50%" mt="2.5" />
        </Box>
      ))}
    </LoadingScreen>
  );
}
