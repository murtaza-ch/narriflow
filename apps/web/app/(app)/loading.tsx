import { Stack } from "@chakra-ui/react";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";

/**
 * Fallback for any route without its own skeleton, and for the moment an async
 * layout resolves: a header (title, one line) and two soft content blocks.
 */
export default function Loading() {
  return (
    <LoadingScreen label="Loading page">
      <Stack gap="1.5">
        <Bone h="8" w="56" maxW="70%" my="0.5" />
        <Bone h="4" w="80" maxW="80%" my="0.5" />
      </Stack>
      <Stack gap="4">
        {[0, 1].map((block) => (
          <Stack key={block} gap="3" p="5" bg="bg.subtle" borderRadius="l3">
            <Bone h="4" w="40" />
            <Bone h="4" w="full" />
            <Bone h="4" w="70%" />
          </Stack>
        ))}
      </Stack>
    </LoadingScreen>
  );
}
