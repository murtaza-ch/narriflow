"use client";

import { Box, Flex, Image, Stack, Text } from "@chakra-ui/react";
import { type WorkspaceScope } from "@narriflow/api-client";
import { workspaceBootstrapQuery } from "@narriflow/api-client/workspace";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { useQuery } from "@tanstack/react-query";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import { QueryLoadError } from "@/app/_components/query-mutation-form";
import { getDisplayName, getInitials } from "@/lib/account-display";
import { SettingsCard, StatusPill } from "../_components/settings-ui";
import ProfileLoading from "./loading";
import { PasskeySettings } from "./passkey-settings";

const ROLE_LABEL = { owner: "Owner", admin: "Admin", editor: "Editor", viewer: "Viewer" } as const;

export default function ProfileSettingsPage() {
  const scope = useWorkspaceScope();
  return scope ? <ProfileContent scope={scope} /> : <ProfileLoading />;
}

function ProfileContent({ scope }: { scope: WorkspaceScope }) {
  const { transport } = useApiRuntime();
  // The shell already read this; it is a cache hit unless the data went stale.
  const bootstrap = useQuery(workspaceBootstrapQuery(transport, scope));
  if (bootstrap.isError) {
    return (
      <Stack gap="6">
        <PageHeader title="Profile" description="Your account, the same in every workspace." />
        <QueryLoadError error={bootstrap.error} what="Your profile" onRetry={() => void bootstrap.refetch()} />
      </Stack>
    );
  }
  if (!bootstrap.data) return <ProfileLoading />;

  const { user, workspace } = bootstrap.data;
  const displayName = getDisplayName(user.firstName, user.lastName);
  const initials = getInitials(user.firstName, user.lastName, user.email);
  return (
    <Stack gap="6">
      <PageHeader title="Profile" description="Your account, the same in every workspace." />
      <SettingsCard>
        <Flex align="center" gap="5" wrap="wrap">
          <Flex boxSize="16" flexShrink={0} align="center" justify="center" borderRadius="full" overflow="hidden" bg="bg.soft" color="fg" fontSize="20px" fontWeight="600">
            {user.imageUrl ? <Image src={user.imageUrl} alt={displayName} w="full" h="full" objectFit="cover" /> : initials}
          </Flex>
          <Stack gap="1.5" minW="0" flex="1">
            <Text textStyle="title" fontSize="20px" truncate>
              {displayName}
            </Text>
            <Text fontSize="13.5px" color="fg.muted" truncate>
              {user.email ?? "No primary email"}
            </Text>
          </Stack>
          <Box>
            <StatusPill tone="accent">
              {ROLE_LABEL[workspace.role] ?? workspace.role}
              {workspace.name ? ` · ${workspace.name}` : ""}
            </StatusPill>
          </Box>
        </Flex>
      </SettingsCard>
      <PasskeySettings />
    </Stack>
  );
}
