import { Flex, Stack } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";

/**
 * Mirrors /search: header, the search field and its two hint pills, then the
 * idle card (icon, two lines, example chips) that a fresh visit lands on.
 */
export default function Loading() {
  return (
    <LoadingScreen label="Loading search">
      <PageHeader title="Search" description="Find any moment across your transcripts, by meaning or exact words." />
      <Stack gap="3">
        <Bone h="14" borderRadius="l3" />
        <Flex align="center" gap="2" minH="7">
          <Bone h="7" w="32" borderRadius="full" />
          <Bone h="7" w="56" borderRadius="full" />
        </Flex>
      </Stack>
      <Stack align="center" gap="5" py={{ base: "10", md: "14" }} px="6" bg="bg.subtle" borderRadius="l3">
        <Bone boxSize="12" borderRadius="full" />
        <Stack align="center" gap="1">
          <Bone h="5" w="44" my="0.5" />
          <Bone h="4" w="72" maxW="full" my="0.5" />
        </Stack>
        <Flex gap="2" wrap="wrap" justify="center">
          {["52", "28", "36", "40"].map((width) => (
            <Bone key={width} h="8" w={width} borderRadius="full" />
          ))}
        </Flex>
      </Stack>
    </LoadingScreen>
  );
}
