import { Flex, Stack, Text } from "@chakra-ui/react";
import { AudioLines, ChevronDown, Upload } from "lucide-react";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";

/**
 * Mirrors the first import step, inside the funnel chrome: one 640px panel
 * with the link field, the file dropzone, the podcast row and the link
 * options. Labels are real; the field and buttons are bones. The cloud
 * pickers row depends on the deployment's configuration and is left out.
 */
export default function Loading() {
  return (
    <LoadingScreen label="Loading import" gap={{ base: "6", md: "7" }} maxW="1080px" mx="auto">
      <Stack gap="4" w="full" maxW="640px" mx="auto" bg="bg.panel" borderRadius="l3" p={{ base: "4", md: "6" }}>
        <Stack gap="2">
          <Text textStyle="eyebrow" color="fg.muted">
            Import from a link
          </Text>
          {/* Link field · Continue */}
          <Flex gap="2" align="center">
            <Bone flex="1" minW="0" h="10" borderRadius="control" />
            <Bone h="10" w="28" borderRadius="control" flexShrink={0} />
          </Flex>
        </Stack>

        <Flex align="center" gap="3" color="fg.subtle">
          <Bone flex="1" h="1px" />
          <Text fontSize="12px">or upload a file</Text>
          <Bone flex="1" h="1px" />
        </Flex>

        {/* Dropzone: the real box is minH 200/240 plus its 2px edge */}
        <Stack
          align="center"
          justify="center"
          gap="4"
          p="5"
          minH={{ base: "204px", md: "244px" }}
          bg="bg.soft"
          borderRadius="l3"
        >
          <Flex color="fg.subtle">
            <Upload size={20} strokeWidth={1.75} />
          </Flex>
          <Stack gap="1.5" align="center">
            <Text fontSize="14px" fontWeight="500">
              Drop your video here, or browse files
            </Text>
            <Text fontSize="13px" color="fg.muted">
              Video or audio · Up to 5 GB
            </Text>
          </Stack>
        </Stack>

        <Flex align="center" justify="space-between" gap="3" wrap="wrap">
          <Flex align="center" gap="2" color="fg.muted">
            <AudioLines size={16} />
            <Text fontSize="13px">Have a podcast?</Text>
          </Flex>
          <Bone h="9" w="40" borderRadius="control" />
        </Flex>

        <Flex align="center" gap="1" fontSize="13px" color="fg.muted">
          Link options <ChevronDown size={13} />
        </Flex>
      </Stack>
    </LoadingScreen>
  );
}
