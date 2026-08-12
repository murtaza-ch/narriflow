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
      <PageHeader eyebrow="Your account" title="Notifications" description="Choose the events Narriflow should bring to your attention." />
      <Stack gap="0" borderTopWidth="1px" borderColor="border">
        {NOTIFICATIONS.map(([title, description]) => (
          <Box key={title} py="5" borderBottomWidth="1px" borderColor="border.subtle">
            <Text fontSize="13px" fontWeight="600">{title}</Text>
            <Text fontSize="12px" color="fg.muted" mt="1">{description}</Text>
          </Box>
        ))}
      </Stack>
    </Stack>
  );
}
