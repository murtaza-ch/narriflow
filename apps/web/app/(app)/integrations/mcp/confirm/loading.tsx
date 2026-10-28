import { Flex, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";

const FACTS = ["Workspace", "Destination account", "Platform", "Clip", "Editor revision", "Export", "Export variant", "Output format", "Scheduled time", "Delivery mode"];

/**
 * Mirrors /integrations/mcp/confirm: header, the fact list (label, value), the
 * caption and provider settings, then Review / Confirm / Decline.
 */
export default function Loading() {
  return (
    <LoadingScreen label="Loading confirmation" gap="6" maxW="800px" mx="auto">
      <PageHeader
        title="Confirm this exact publication"
        description="Review the frozen clip revision, destination and caption. Narriflow checks review approval again before scheduling."
      />
      <Stack gap="3">
        {FACTS.map((label) => (
          <Flex key={label} gap="4" direction={{ base: "column", md: "row" }}>
            <Text minW="160px" fontWeight="500">
              {label}
            </Text>
            <Bone h="4" w="72" maxW="full" my="1" />
          </Flex>
        ))}
      </Stack>
      <Stack gap="2">
        <Text as="h2" fontSize="16px" fontWeight="500">
          Caption
        </Text>
        <Bone h="4" w="full" my="1" />
        <Bone h="4" w="60%" my="1" />
      </Stack>
      <Stack gap="2">
        <Text as="h2" fontSize="16px" fontWeight="500">
          Provider settings
        </Text>
        <Bone h="24" borderRadius="l2" />
      </Stack>
      <Bone h="10" w="40" borderRadius="control" />
      <Stack gap="3">
        <Bone h="4" w="72" maxW="full" my="0.5" />
        <Flex gap="3">
          <Bone h="10" w="44" borderRadius="control" />
          <Bone h="10" w="24" borderRadius="control" />
        </Flex>
      </Stack>
    </LoadingScreen>
  );
}
