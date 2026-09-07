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
      <PageHeader title="Notifications" description="Updates sent for your projects and workspace." />
      <Stack gap="3">
        {NOTIFICATIONS.map(([title, description]) => (
          <Box key={title} p="5" bg="bg.panel" borderRadius="l2">
            <Text fontSize="13px" fontWeight="600">{title}</Text>
            <Text fontSize="12px" color="fg.muted" mt="1">{description}</Text>
          </Box>
        ))}
      </Stack>
    </Stack>
  );
}
