import { Flex, Stack } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";

/**
 * Mirrors /autopilot: header with "New rule", then the rule cards (source tile, name and status,
 * chips, actions). Whether Zoom is configured is only known with the data, so the Zoom strip and
 * its header wording are not drawn here.
 */
export default function Loading() {
  return (
    <LoadingScreen label="Loading Autopilot">
      <PageHeader
        title="Autopilot"
        description="New episodes become clips on their own."
        actions={<Bone h="10" w="28" borderRadius="control" />}
      />
      <Stack gap="2.5">
        {[0, 1, 2].map((rule) => (
          <Flex key={rule} gap="4" align="flex-start" wrap="wrap" p="4" ps="5" bg="bg.subtle" borderRadius="l3">
            <Bone boxSize="11" borderRadius="12px" flexShrink={0} />
            <Stack gap="0" flex="1" minW="0">
              <Flex align="center" gap="2.5">
                <Bone h="5" w="44" maxW="60%" />
                <Bone h="6" w="20" borderRadius="full" />
              </Flex>
              <Bone h="4" w="80" maxW="full" mt="1.5" mb="0.5" />
              <Flex mt="3" gap="1.5" wrap="wrap">
                {["28", "24", "44", "40", "32"].map((width) => (
                  <Bone key={width} h="7" w={width} borderRadius="8px" />
                ))}
              </Flex>
            </Stack>
            <Flex gap="2" align="center" flexShrink={0}>
              <Bone h="5" w="9" borderRadius="full" />
              <Bone h="9" w="24" borderRadius="control" />
              <Bone boxSize="8" borderRadius="l2" />
              <Bone boxSize="8" borderRadius="l2" />
            </Flex>
          </Flex>
        ))}
      </Stack>
    </LoadingScreen>
  );
}
