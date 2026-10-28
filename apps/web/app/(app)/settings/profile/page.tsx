import { Box, Flex, Image, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { workspaceService } from "@narriflow/services";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { getDisplayName, getInitials } from "@/lib/account-display";
import { SettingsCard, StatusPill } from "../_components/settings-ui";
import { PasskeySettings } from "./passkey-settings";

const ROLE_LABEL = { owner: "Owner", admin: "Admin", editor: "Editor", viewer: "Viewer" } as const;

export default async function ProfileSettingsPage() {
  const appUser = await admitWorkspacePage("content.view");
  const workspace = await workspaceService.getWorkspace(appUser.actorUserId, appUser.workspaceId);
  const displayName = getDisplayName(appUser.firstName, appUser.lastName);
  const initials = getInitials(appUser.firstName, appUser.lastName, appUser.primaryEmail);
  return (
    <Stack gap="6">
      <PageHeader title="Profile" description="Your account, the same in every workspace." />
      <SettingsCard>
        <Flex align="center" gap="5" wrap="wrap">
          <Flex boxSize="16" flexShrink={0} align="center" justify="center" borderRadius="full" overflow="hidden" bg="bg.soft" color="fg" fontSize="20px" fontWeight="600">
            {appUser.imageUrl ? <Image src={appUser.imageUrl} alt={displayName} w="full" h="full" objectFit="cover" /> : initials}
          </Flex>
          <Stack gap="1.5" minW="0" flex="1">
            <Text textStyle="title" fontSize="20px" truncate>
              {displayName}
            </Text>
            <Text fontSize="13.5px" color="fg.muted" truncate>
              {appUser.primaryEmail ?? "No primary email"}
            </Text>
          </Stack>
          <Box>
            <StatusPill tone="accent">
              {ROLE_LABEL[appUser.role as keyof typeof ROLE_LABEL] ?? appUser.role}
              {workspace?.name ? ` · ${workspace.name}` : ""}
            </StatusPill>
          </Box>
        </Flex>
      </SettingsCard>
      <PasskeySettings />
    </Stack>
  );
}
