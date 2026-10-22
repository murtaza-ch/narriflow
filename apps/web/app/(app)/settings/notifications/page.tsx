import { Box, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";

const NOTIFICATIONS = [
  ["Processing complete", "Receive an email when a project finishes generating clips."],
  ["Publishing failures", "Be notified when a scheduled social post needs attention."],
  ["Workspace invitations", "Receive membership and role-change notifications."],
] as const;

export default function NotificationSettingsPage() {
  return (
    <Stack gap="8">
      <PageHeader title="Notifications" />
      <Stack gap="3">
        {NOTIFICATIONS.map(([title, description]) => (
          <Box key={title} p="5" bg="bg.panel" borderRadius="l3" borderWidth="1px" borderColor="border.card">
            <Text fontSize="14px" fontWeight="500">{title}</Text>
            <Text fontSize="13px" color="fg.muted" mt="1">{description}</Text>
          </Box>
        ))}
      </Stack>
    </Stack>
  );
}
