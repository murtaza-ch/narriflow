import { Box, Flex, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";
import { TextBone } from "../_components/settings-skeleton";

/** Social accounts: connected-account cards (2 columns), the connect heading with its plan meter, then the six platform tiles. */
export default function Loading() {
  return (
    <LoadingScreen label="Loading social accounts" gap="8">
      <PageHeader title="Social accounts" description="The accounts Narriflow publishes your clips to." />
      <Stack gap="8">
        <Stack gap="3">
          <Flex align="center" gap="2">
            <Text as="h2" fontSize="14px" fontWeight="500" color="fg.muted">
              Connected accounts
            </Text>
            <Bone h="5" w="6" borderRadius="full" />
          </Flex>
          <SimpleGrid columns={{ base: 1, md: 2 }} gap="2">
            {[0, 1].map((card) => (
              <Flex key={card} align="center" gap="3.5" minW="0" p="3.5" borderRadius="12px" bg="bg.subtle">
                <Bone boxSize="10" borderRadius="full" flexShrink={0} />
                <Stack gap="0.5" flex="1" minW="0">
                  <TextBone w="36" />
                  <TextBone w="24" line="18px" h="2.5" />
                </Stack>
                <Bone boxSize="9" borderRadius="control" flexShrink={0} />
              </Flex>
            ))}
          </SimpleGrid>
        </Stack>
        <Stack gap="4">
          <Flex align={{ base: "flex-start", md: "flex-end" }} justify="space-between" gap="4" wrap="wrap">
            <Stack gap="1" maxW="560px">
              <TextBone w="44" line="24px" h="4" />
              <TextBone w="80" line="20px" />
            </Stack>
            <Stack gap="1.5" minW="200px">
              <TextBone w="full" line="18px" h="2.5" />
              <Bone h="6px" borderRadius="full" />
            </Stack>
          </Flex>
          <SimpleGrid columns={{ base: 1, sm: 2, lg: 3 }} gap="2">
            {[0, 1, 2, 3, 4, 5].map((tile) => (
              <Flex key={tile} align="center" gap="3" p="3.5" borderRadius="12px" bg="bg.subtle">
                <Bone boxSize="36px" borderRadius="8px" flexShrink={0} />
                <Box flex="1" minW="0">
                  <TextBone w="20" />
                  <TextBone w="28" line="18px" h="2.5" />
                </Box>
                <Bone boxSize="7" borderRadius="8px" flexShrink={0} />
              </Flex>
            ))}
          </SimpleGrid>
        </Stack>
      </Stack>
    </LoadingScreen>
  );
}
