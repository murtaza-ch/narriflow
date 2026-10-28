import { Flex, Stack } from "@chakra-ui/react";
import { KeyRound } from "lucide-react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";
import { SettingsCard } from "../_components/settings-ui";
import { TextBone } from "../_components/settings-skeleton";

/** Profile: the identity card (avatar, name, email, role pill), then the Passkeys card with its empty row. */
export default function Loading() {
  return (
    <LoadingScreen label="Loading profile" gap="6">
      <PageHeader title="Profile" description="Your account, the same in every workspace." />
      <SettingsCard>
        <Flex align="center" gap="5" wrap="wrap">
          <Bone boxSize="16" borderRadius="full" flexShrink={0} />
          <Stack gap="1.5" minW="0" flex="1">
            <TextBone w="44" line="24px" h="4" />
            <TextBone w="56" line="20px" />
          </Stack>
          <Bone h="6" w="40" borderRadius="full" />
        </Flex>
      </SettingsCard>
      <SettingsCard
        icon={<KeyRound size={16} />}
        title="Passkeys"
        description="Sign in with your fingerprint, face, or device PIN. Optional."
        action={<Bone h="9" w="36" borderRadius="control" />}
      >
        <Bone h="12" borderRadius="l2" />
      </SettingsCard>
    </LoadingScreen>
  );
}
