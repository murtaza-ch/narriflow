import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { requireWorkspaceAppUser } from "@/lib/workspace";
import { AccountAvatar } from "../../_components/account-menu";
import { getDisplayName, getInitials } from "@/lib/account-display";

export default async function ProfileSettingsPage() {
  const appUser = await requireWorkspaceAppUser();
  const displayName = getDisplayName(appUser.firstName, appUser.lastName);
  return (
    <Stack gap="8">
      <PageHeader eyebrow="Your account" title="Profile" description="Your personal identity across every Narriflow workspace." />
      <Box borderTopWidth="1px" borderColor="border" py="6">
        <Flex align="center" gap="4">
          <AccountAvatar
            imageUrl={appUser.imageUrl}
            initials={getInitials(appUser.firstName, appUser.lastName, appUser.primaryEmail)}
            alt={displayName}
          />
          <Stack gap="0.5">
            <Text fontWeight="600">{displayName}</Text>
            <Text fontSize="13px" color="fg.muted">{appUser.primaryEmail ?? "No primary email"}</Text>
          </Stack>
        </Flex>
      </Box>
      <Box borderTopWidth="1px" borderColor="border" py="5">
        <Text fontSize="13px" color="fg.muted">
          Name, email, password, and connected sign-in methods are managed securely through your Narriflow authentication profile.
        </Text>
      </Box>
    </Stack>
  );
}
