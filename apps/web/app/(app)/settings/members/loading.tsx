import { Box, Flex, Stack } from "@chakra-ui/react";
import { UserPlus, Users } from "lucide-react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";
import { SettingsCard } from "../_components/settings-ui";
import { TextBone } from "../_components/settings-skeleton";

/** Members: summary chips, the invite card (email, role, send), then the Members card with its role filter and rows. */
export default function Loading() {
  return (
    <LoadingScreen label="Loading members" gap="8">
      <PageHeader title="Members" description="Invite your team and choose what each person can do." />
      <Stack gap="6">
        <Flex gap="2" wrap="wrap">
          {["24", "28", "32"].map((w) => (
            <Bone key={w} h="7" w={w} borderRadius="full" />
          ))}
        </Flex>
        <SettingsCard icon={<UserPlus size={16} />} title="Invite a member" description="They get an email with a secure link to join.">
          <Stack gap="3">
            <Flex direction={{ base: "column", md: "row" }} gap="2" align={{ md: "center" }}>
              <Bone flex="1" h="42px" borderRadius="control" />
              <Bone w={{ base: "full", md: "150px" }} h="10" borderRadius="control" flexShrink={0} />
              <Bone h="9" w="28" borderRadius="control" flexShrink={0} />
            </Flex>
            <TextBone w="56" line="18px" h="2.5" />
          </Stack>
        </SettingsCard>
        <SettingsCard icon={<Users size={16} />} title="Members" action={<Bone h="9" w="150px" borderRadius="control" />}>
          <Stack gap="1">
            {[0, 1, 2].map((row) => (
              <Flex key={row} align="center" gap="3" py="2.5" px="2" mx="-2">
                <Bone boxSize="9" borderRadius="full" flexShrink={0} />
                <Box flex="1" minW="0">
                  <TextBone w="40" />
                  <TextBone w="64" line="18px" h="2.5" />
                </Box>
                <Bone h="9" w="130px" borderRadius="control" flexShrink={0} />
                <Bone boxSize="9" borderRadius="control" flexShrink={0} />
              </Flex>
            ))}
          </Stack>
        </SettingsCard>
      </Stack>
    </LoadingScreen>
  );
}
