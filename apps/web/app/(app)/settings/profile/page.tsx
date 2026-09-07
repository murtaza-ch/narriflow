import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { AccountAvatar } from "../../_components/account-menu";
import { getDisplayName, getInitials } from "@/lib/account-display";

export default async function ProfileSettingsPage() {
  const appUser = await admitWorkspacePage("content.view");
  const displayName = getDisplayName(appUser.firstName, appUser.lastName);
  return (
    <Stack gap="8">
      <PageHeader title="Profile" />
      <Box borderWidth="1px" borderColor="border" borderRadius="l2" bg="bg.panel" p="6">
        <Flex align="center" gap="4">
          <AccountAvatar
            imageUrl={appUser.imageUrl}
            initials={getInitials(appUser.firstName, appUser.lastName, appUser.primaryEmail,
            )}
            alt={displayName}
          />
          <Stack gap="0.5">
            <Text fontWeight="600">{displayName}</Text>
            <Text fontSize="13px" color="fg.muted">{appUser.primaryEmail ?? "No primary email"}</Text>
          </Stack>
        </Flex>
      </Box>
      <Box borderWidth="1px" borderColor="border" borderRadius="l2" bg="bg.panel" p="5">
        <Text fontSize="13px" color="fg.muted">
          Your authentication profile manages your name, email, password, and sign-in methods.
        </Text>
      </Box>
    </Stack>
  );
}
