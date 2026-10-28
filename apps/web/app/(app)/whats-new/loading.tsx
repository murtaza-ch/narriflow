import { Stack } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";

/** Mirrors /whats-new: header, then the empty-state card (icon, title, one line). */
export default function Loading() {
  return (
    <LoadingScreen label="Loading release notes">
      <PageHeader title="What's new" />
      <Stack align="center" gap="4" py={{ base: "10", md: "14" }} px="6" bg="bg.subtle" borderRadius="l3">
        <Bone boxSize="11" borderRadius="full" />
        <Stack align="center" gap="1">
          <Bone h="5" w="40" my="0.5" />
          <Bone h="4" w="64" maxW="full" my="0.5" />
        </Stack>
      </Stack>
    </LoadingScreen>
  );
}
