import { Flex, Stack } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";

/** Mirrors /whats-new: header, then the empty card (a faded timeline of notes, a title, one line, a button). */
export default function Loading() {
  return (
    <LoadingScreen label="Loading release notes">
      <PageHeader title="What's new" />
      <Flex direction="column" align="center" gap="5" py={{ base: "8", md: "10" }} px="6" bg="bg.subtle" borderRadius="l3" overflow="hidden">
        <Flex w="full" maxW="420px" gap="4">
          <Bone boxSize="9" borderRadius="full" flexShrink={0} />
          <Stack gap="3" flex="1" pb="10">
            <Bone h="24" borderRadius="l2" />
            <Bone h="24" borderRadius="l2" opacity={0.6} />
          </Stack>
        </Flex>
        <Stack align="center" gap="1" mt="-6">
          <Bone h="5" w="40" my="0.5" />
          <Bone h="4" w="64" maxW="full" my="0.5" />
        </Stack>
        <Bone h="8" w="36" borderRadius="control" />
      </Flex>
    </LoadingScreen>
  );
}
