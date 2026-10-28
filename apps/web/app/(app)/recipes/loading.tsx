import { Flex, Grid, Stack } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";

/**
 * Mirrors /recipes: header with "New Recipe", then a two-column grid of Recipe
 * cards (clip glyph, name and brand, action icons, setting chips, usage line).
 */
export default function Loading() {
  return (
    <LoadingScreen label="Loading Recipes">
      <PageHeader title="Recipes" actions={<Bone h="10" w="32" borderRadius="control" />} />
      <Grid templateColumns={{ base: "1fr", lg: "repeat(2, minmax(0, 1fr))" }} gap="4">
        {[0, 1, 2, 3].map((recipe) => (
          <Stack key={recipe} gap="5" p="5" bg="bg.subtle" borderRadius="l3" minW="0">
            <Flex gap="4" align="flex-start" minW="0">
              <Bone boxSize="14" borderRadius="12px" flexShrink={0} />
              <Stack gap="1.5" flex="1" minW="0" pt="0.5">
                <Bone h="5" w="44" maxW="80%" />
                <Bone h="4" w="32" maxW="60%" my="0.5" />
              </Stack>
              <Flex gap="0.5" flexShrink={0} mt="-1" me="-1">
                {[0, 1, 2].map((action) => (
                  <Bone key={action} boxSize="8" borderRadius="l2" />
                ))}
              </Flex>
            </Flex>
            <Flex gap="1.5" wrap="wrap">
              {["14", "20", "24", "24"].map((width, chip) => (
                <Bone key={chip} h="7" w={width} borderRadius="8px" />
              ))}
            </Flex>
            <Bone h="3.5" w="56" maxW="full" mt="auto" />
          </Stack>
        ))}
      </Grid>
    </LoadingScreen>
  );
}
