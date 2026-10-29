import { Flex, Stack } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";

/**
 * Mirrors /integrations/mcp/upload: header, the generation summary line, then
 * the picker (labelled file field with helper text, upload button, hint).
 */
export default function Loading() {
  return (
    <LoadingScreen label="Loading upload" gap="6" maxW="800px" mx="auto">
      <PageHeader
        title="Choose a video for your assistant"
        description="The assistant's generation settings are committed with this upload. File bytes travel directly to Narriflow storage."
      />
      <Bone h="4" w="56" maxW="full" my="0.5" />
      <Stack gap="5">
        <Stack gap="1.5">
          <Bone h="4" w="36" my="0.5" />
          <Bone h="10" borderRadius="control" />
          <Bone h="3" w="80" maxW="full" my="0.5" />
        </Stack>
        <Flex gap="3" wrap="wrap">
          <Bone h="10" w="52" borderRadius="control" />
        </Flex>
        <Bone h="4" w="96" maxW="full" my="0.5" />
      </Stack>
    </LoadingScreen>
  );
}
