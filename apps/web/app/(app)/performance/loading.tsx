import { Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";

/**
 * Mirrors /performance (What worked): header, four stat tiles, the audience
 * data card, two breakdown tables, then the platform coverage chips.
 */
export default function Loading() {
  return (
    <LoadingScreen label="Loading performance">
      <PageHeader title="What worked" description="How your clips perform on YouTube Shorts and TikTok." />
      <Stack gap="6">
        <Grid templateColumns={{ base: "repeat(2, minmax(0, 1fr))", lg: "repeat(4, minmax(0, 1fr))" }} gap="3">
          {[0, 1, 2, 3].map((tile) => (
            <Stack key={tile} gap="4" p="5" bg="bg.subtle" borderRadius="l3">
              <Flex align="center" justify="space-between" gap="2">
                <Bone h="4" w="24" my="0.5" />
                <Bone boxSize="8" borderRadius="full" />
              </Flex>
              <Bone h="30px" w="20" />
            </Stack>
          ))}
        </Grid>

        <Stack gap="4" p="5" bg="bg.subtle" borderRadius="l3">
          <Flex align="center" justify="space-between" gap="3" wrap="wrap">
            <Flex align="center" gap="2.5">
              <Bone boxSize="8" borderRadius="full" />
              <Bone h="4" w="36" my="0.5" />
            </Flex>
            <Bone h="7" w="72" maxW="full" borderRadius="full" />
          </Flex>
          <Bone h="4" w="full" maxW="68ch" my="0.5" />
          <Stack gap="2.5">
            {[0, 1, 2].map((row) => (
              <Flex key={row} gap="3" align="center">
                <Bone h="4" flex="1" my="0.5" />
                <Bone h="6px" w={{ base: "24", md: "40" }} borderRadius="full" flexShrink={0} />
                <Bone h="4" w="11" my="0.5" />
              </Flex>
            ))}
          </Stack>
        </Stack>

        <Grid templateColumns={{ base: "minmax(0, 1fr)", xl: "repeat(2, minmax(0, 1fr))" }} gap="3">
          {[0, 1].map((table) => (
            <Stack key={table} gap="3" p="5" bg="bg.subtle" borderRadius="l3" minW="0">
              <Bone h="4" w="28" my="0.5" />
              <Stack gap="1">
                {[0, 1, 2].map((row) => (
                  <Bone key={row} h="10" borderRadius="l2" />
                ))}
              </Stack>
            </Stack>
          ))}
        </Grid>

        <Stack gap="2.5">
          <Flex align="center" gap="2" wrap="wrap">
            <Text fontSize="13px" fontWeight="500" color="fg.muted">
              Platforms
            </Text>
            <Bone h="6" w="80" maxW="full" borderRadius="full" />
          </Flex>
          <Flex gap="2" wrap="wrap">
            {[0, 1, 2, 3, 4, 5].map((platform) => (
              <Bone key={platform} h="9" w="40" borderRadius="full" />
            ))}
          </Flex>
          <Text fontSize="12px" color="fg.subtle">
            Totals keep counting videos whose Project was deleted.
          </Text>
        </Stack>
      </Stack>
    </LoadingScreen>
  );
}
