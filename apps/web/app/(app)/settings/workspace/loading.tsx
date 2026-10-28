import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { Building2, Sparkles } from "lucide-react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";
import { SettingsCard } from "../_components/settings-ui";
import { TextBone } from "../_components/settings-skeleton";

/** Workspace settings: the Workspace card (status pills, avatar, name and timezone fields, save), then the Clip picking card. */
export default function Loading() {
  return (
    <LoadingScreen label="Loading workspace settings" gap="6">
      <PageHeader title="Workspace settings" description="Name, timezone, and how Narriflow picks clips here." />
      <SettingsCard
        icon={<Building2 size={16} />}
        title="Workspace"
        action={
          <>
            <Bone h="6" w="16" borderRadius="full" />
            <Bone h="6" w="24" borderRadius="full" />
          </>
        }
      >
        <Flex gap={{ base: "5", md: "8" }} direction={{ base: "column", md: "row" }} align={{ md: "flex-start" }}>
          <Stack gap="2.5" align={{ base: "flex-start", md: "center" }} flexShrink={0}>
            <Bone boxSize="24" borderRadius="l3" />
            <Bone h="8" w="20" borderRadius="control" />
          </Stack>
          <Box flex="1" minW="0" maxW={{ md: "560px" }}>
            <Stack gap="4">
              <Stack gap="1.5">
                <Text fontSize="13px" fontWeight="500">Name</Text>
                <Bone h="10" borderRadius="control" />
              </Stack>
              <Stack gap="1.5">
                <Text fontSize="13px" fontWeight="500">Timezone</Text>
                <Bone h="10" borderRadius="control" />
                <Text fontSize="12px" color="fg.subtle">Used for the calendar and publishing defaults.</Text>
              </Stack>
              <Bone h="9" w="28" borderRadius="control" />
            </Stack>
          </Box>
        </Flex>
      </SettingsCard>
      <SettingsCard icon={<Sparkles size={16} />} title="Clip picking" description="Let what performed well guide which moments become clips.">
        <Stack gap="4" maxW="640px">
          <Stack gap="3">
            <Flex align="center" gap="3">
              <Bone h="6" w="11" borderRadius="full" flexShrink={0} />
              <TextBone w="64" />
            </Flex>
            <Stack gap="0">
              <TextBone w="full" line="18px" h="2.5" />
              <TextBone w="full" line="18px" h="2.5" />
              <TextBone w="60%" line="18px" h="2.5" />
            </Stack>
          </Stack>
          <Bone h="9" w="20" borderRadius="control" />
        </Stack>
      </SettingsCard>
    </LoadingScreen>
  );
}
