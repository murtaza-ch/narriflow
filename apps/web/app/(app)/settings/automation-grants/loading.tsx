import { Flex, Stack } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";
import { TextBone } from "../_components/settings-skeleton";

/** Automation grants: the "N of M active" line with the New grant button, then grant cards (rule, status, usage meters, expiry, history). */
export default function Loading() {
  return (
    <LoadingScreen label="Loading automation grants" gap="8">
      <PageHeader title="Automation grants" description="Let an Autopilot rule post or send review rounds without a click." />
      <Stack gap="5">
        <Flex justify="space-between" align="center" gap="4" wrap="wrap">
          <TextBone w="28" line="20px" />
          <Bone h="9" w="28" borderRadius="control" />
        </Flex>
        <Stack gap="2">
          {[0, 1].map((card) => (
            <Stack key={card} gap="4" bg="bg.subtle" borderRadius="l3" p={{ base: "4", md: "5" }}>
              <Flex justify="space-between" align="flex-start" gap="3">
                <Flex gap="3" minW="0" align="flex-start">
                  <Bone boxSize="9" borderRadius="10px" flexShrink={0} />
                  <Stack gap="1" minW="0">
                    <Flex align="center" gap="2.5">
                      <TextBone w="40" line="23px" h="3.5" />
                      <Bone h="6" w="16" borderRadius="full" />
                    </Flex>
                    <TextBone w="64" line="20px" />
                  </Stack>
                </Flex>
                <Bone boxSize="9" borderRadius="control" flexShrink={0} />
              </Flex>
              <Flex gap="5" wrap="wrap" align="flex-end">
                {[0, 1].map((meter) => (
                  <Stack key={meter} gap="1.5" minW="150px" flex="1">
                    <TextBone w="32" line="19px" h="2.5" />
                    <Bone h="4px" borderRadius="full" />
                  </Stack>
                ))}
                <Bone h="7" w="40" borderRadius="8px" flexShrink={0} />
              </Flex>
              <Flex align="center" justify="space-between" gap="3" wrap="wrap">
                <Bone h="8" w="20" borderRadius="control" />
                <TextBone w="32" line="18px" h="2.5" />
              </Flex>
            </Stack>
          ))}
        </Stack>
      </Stack>
    </LoadingScreen>
  );
}
