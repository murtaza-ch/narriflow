import { Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";

const columns = { base: "1fr", sm: "repeat(2, minmax(0, 1fr))", lg: "repeat(3, minmax(0, 1fr))" };

/** One integration tile: logo, name and status, trailing mark. */
function Tile() {
  return (
    <Flex align="center" gap="3" p="3.5" minH="67px" bg="bg.subtle" borderRadius="12px">
      <Bone boxSize="36px" borderRadius="10px" flexShrink={0} />
      <Stack gap="1.5" flex="1" minW="0">
        <Bone h="4" w="20" />
        <Bone h="3" w="32" maxW="full" />
      </Stack>
      <Bone boxSize="7" borderRadius="8px" flexShrink={0} />
    </Flex>
  );
}

function Section({ title, tiles, meta = false }: { title: string; tiles: number; meta?: boolean }) {
  return (
    <Stack gap="3">
      <Flex align="center" gap="2">
        <Text as="h2" fontSize="14px" fontWeight="500" color="fg.muted">
          {title}
        </Text>
        {meta ? <Bone h="5" w="24" borderRadius="full" /> : null}
      </Flex>
      <Grid templateColumns={columns} gap="2">
        {Array.from({ length: tiles }, (_, tile) => (
          <Tile key={tile} />
        ))}
      </Grid>
    </Stack>
  );
}

/**
 * Mirrors /integrations: header, the AI-assistant card, then the Publishing
 * (six) and Automation (three) tile grids.
 */
export default function Loading() {
  return (
    <LoadingScreen label="Loading integrations">
      <PageHeader title="Integrations" description="Where your clips get posted, and the tools that can run Narriflow for you." />
      <Flex
        align={{ base: "flex-start", md: "center" }}
        justify="space-between"
        direction={{ base: "column", md: "row" }}
        gap="5"
        p={{ base: "5", md: "6" }}
        bg="bg.subtle"
        borderRadius="14px"
      >
        <Stack gap="4" minW="0">
          <Flex gap="2">
            {[0, 1, 2, 3].map((brand) => (
              <Bone key={brand} boxSize="12" borderRadius="14px" />
            ))}
          </Flex>
          <Stack gap="1">
            <Bone h="6" w="72" maxW="full" />
            <Bone h="5" w="80" maxW="full" />
          </Stack>
        </Stack>
        <Bone h="9" w="24" borderRadius="control" flexShrink={0} />
      </Flex>
      <Section title="Publishing" tiles={6} meta />
      <Section title="Automation" tiles={3} />
    </LoadingScreen>
  );
}
