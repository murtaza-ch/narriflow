import { Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";

const columns = { base: "1fr", sm: "repeat(2, minmax(0, 1fr))", lg: "repeat(3, minmax(0, 1fr))" };

function Section({ title, tiles }: { title: string; tiles: number }) {
  return (
    <Stack gap="3">
      <Text as="h2" fontSize="14px" fontWeight="500" color="fg.muted">
        {title}
      </Text>
      <Grid templateColumns={columns} gap="2">
        {Array.from({ length: tiles }, (_, tile) => (
          <Flex key={tile} align="center" gap="3" p="3.5" minH="68px" bg="bg.subtle" borderRadius="12px">
            <Bone boxSize="36px" borderRadius="10px" flexShrink={0} />
            <Stack gap="1.5" minW="0">
              <Bone h="4" w="24" />
              <Bone h="3.5" w="40" maxW="full" />
            </Stack>
          </Flex>
        ))}
      </Grid>
    </Stack>
  );
}

/** Mirrors /help: header, the docs card, then the Popular (six) and Get started (two) tiles. */
export default function Loading() {
  return (
    <LoadingScreen label="Loading help" maxW="1120px" mx="auto">
      <PageHeader title="Tutorials &amp; help" />
      <Flex
        align={{ base: "flex-start", md: "center" }}
        justify="space-between"
        direction={{ base: "column", md: "row" }}
        gap="5"
        p={{ base: "5", md: "6" }}
        bg="bg.subtle"
        borderRadius="14px"
      >
        <Flex align="center" gap="4" minW="0">
          <Bone boxSize="48px" borderRadius="14px" flexShrink={0} />
          <Stack gap="1" minW="0">
            <Bone h="6" w="40" />
            <Bone h="5" w="64" maxW="full" />
          </Stack>
        </Flex>
        <Bone h="9" w="28" borderRadius="control" flexShrink={0} />
      </Flex>
      <Section title="Popular" tiles={6} />
      <Section title="Get started" tiles={2} />
    </LoadingScreen>
  );
}
