import { Flex, Stack } from "@chakra-ui/react";
import { Clapperboard, MessageSquareText, ShieldAlert } from "lucide-react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";
import { SettingsCard } from "../_components/settings-ui";
import { TextBone } from "../_components/settings-skeleton";

const GROUPS = [
  { title: "Projects", icon: <Clapperboard size={16} />, rows: 4 },
  { title: "Finishing and review", icon: <MessageSquareText size={16} />, rows: 2 },
  { title: "Automation", icon: <ShieldAlert size={16} />, rows: 2 },
];

/** Notifications: three titled cards of email rows (icon, title, line, "Email · on" pill). */
export default function Loading() {
  return (
    <LoadingScreen label="Loading notifications" gap="6">
      <PageHeader title="Notifications" description="Emails Narriflow sends to your sign-in address. They're always on for now." />
      {GROUPS.map((group) => (
        <SettingsCard key={group.title} icon={group.icon} title={group.title}>
          <Stack gap="0">
            {Array.from({ length: group.rows }, (_, row) => (
              <Flex key={row} align="center" gap="4" py="3">
                <Bone boxSize="8" borderRadius="10px" flexShrink={0} />
                <Stack gap="0.5" flex="1" minW="0">
                  <TextBone w="32" />
                  <TextBone w="72" line="19px" h="2.5" />
                </Stack>
                <Bone h="6" w="20" borderRadius="full" flexShrink={0} />
              </Flex>
            ))}
          </Stack>
        </SettingsCard>
      ))}
    </LoadingScreen>
  );
}
