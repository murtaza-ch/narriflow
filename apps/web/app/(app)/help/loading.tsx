import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";

const columns = { base: "1fr", sm: "repeat(2, minmax(0, 1fr))", lg: "repeat(3, minmax(0, 1fr))" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Stack gap="3">
      <Text as="h2" fontSize="14px" fontWeight="500" color="fg.muted">
        {title}
      </Text>
      <Grid templateColumns={columns} gap="2">
        {children}
      </Grid>
    </Stack>
  );
}

function RowTiles({ tiles }: { tiles: number }) {
  return Array.from({ length: tiles }, (_, tile) => (
    <Flex key={tile} align="center" gap="3" p="3.5" minH="68px" bg="bg.subtle" borderRadius="l2">
      <Bone boxSize="36px" borderRadius="10px" flexShrink={0} />
      <Stack gap="1.5" minW="0" flex="1">
        <Bone h="4" w="24" />
        <Bone h="3.5" w="40" maxW="full" />
      </Stack>
    </Flex>
  ));
}

/** Mirrors /help: header, the docs banner, then Get started (three cards), Popular guides (six) and Browse by topic (three). */
export default function Loading() {
  return (
    <LoadingScreen label="Loading help" maxW="1120px" mx="auto">
      <PageHeader title="Tutorials &amp; help" />
      <Flex
        borderRadius="l3"
        bgGradient="to-r"
        gradientFrom="accent.subtle"
        gradientTo="accent.muted"
        minH={{ base: "auto", md: "220px" }}
        align="stretch"
      >
        <Stack gap="4" px={{ base: "6", md: "9" }} py={{ base: "6", md: "8" }} flex="1" justify="center">
          <Bone h="6" w="44" />
          <Stack gap="2.5">
            <Bone h="4" w="72" maxW="full" />
            <Bone h="4" w="64" maxW="full" />
          </Stack>
          <Bone h="8" w="28" borderRadius="control" mt="2" />
        </Stack>
        <Box display={{ base: "none", md: "block" }} flexShrink={0} w={{ md: "320px", xl: "400px" }} />
      </Flex>
      <Section title="Get started">
        {Array.from({ length: 3 }, (_, card) => (
          <Stack key={card} gap="4" p="4" minH="132px" bg="bg.subtle" borderRadius="l2">
            <Bone boxSize="44px" borderRadius="12px" />
            <Stack gap="1.5">
              <Bone h="4" w="28" />
              <Bone h="3.5" w="40" maxW="full" />
            </Stack>
          </Stack>
        ))}
      </Section>
      <Section title="Popular guides">
        <RowTiles tiles={6} />
      </Section>
      <Section title="Browse by topic">
        <RowTiles tiles={3} />
      </Section>
    </LoadingScreen>
  );
}
