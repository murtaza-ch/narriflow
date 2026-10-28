import { Flex, Stack, Text } from "@chakra-ui/react";
import { zoomConfigured } from "@narriflow/services";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";

/**
 * Mirrors /autopilot: header with "New rule", the Zoom strip when Zoom is
 * configured, then the rule cards (source tile, name and status, chips, actions).
 */
export default function Loading() {
  const zoom = zoomConfigured();
  return (
    <LoadingScreen label="Loading Autopilot">
      <PageHeader
        title="Autopilot"
        description={zoom ? "New episodes and Zoom recordings become clips on their own." : "New episodes become clips on their own."}
        actions={<Bone h="10" w="28" borderRadius="control" />}
      />
      {zoom ? (
        <Flex
          direction={{ base: "column", md: "row" }}
          align={{ base: "stretch", md: "center" }}
          justify="space-between"
          gap="4"
          p={{ base: "4", md: "5" }}
          bg="bg.subtle"
          borderRadius="l3"
        >
          <Stack gap="1">
            <Text as="h2" fontSize="14px" fontWeight="600">
              Zoom recordings
            </Text>
            <Text fontSize="13px" color="fg.muted">
              Connect Zoom, then add a rule to clip future cloud recordings with a Recipe.
            </Text>
          </Stack>
          <Bone h="9" w="28" borderRadius="control" />
        </Flex>
      ) : null}
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
