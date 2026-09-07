import { Box, Input, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { ActionSubmitButton } from "@narriflow/ui/components/action-submit-button";
import { Combobox } from "@narriflow/ui/components/combobox";
import { workspaceService } from "@narriflow/services";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { updateWorkspaceAction } from "../actions";
import { WorkspaceAvatarControl } from "./workspace-avatar-control";
import { AuthenticatedActionForm } from "@/app/_components/authenticated-action-form";

const TIMEZONE_ITEMS = ["UTC", ...Intl.supportedValuesOf("timeZone")].map((timezone) => ({
  value: timezone,
  label: timezone.replaceAll("_", " "),
}),
);

export default async function WorkspaceSettingsPage() {
  const appUser = await admitWorkspacePage("content.view");
  const workspace = await workspaceService.getWorkspace(appUser.actorUserId, appUser.workspaceId,
  );
  if (!workspace) return null;
  const avatarUrls = await workspaceService.getAvatarUrls(
    appUser.actorUserId,
    [appUser.workspaceId,
  ]);
  const canManage =
    appUser.workspace.role === "owner" ||
    (appUser.workspace.role === "admin" &&
      appUser.workspace.status === "active");
  return (
    <Stack gap="8">
      <PageHeader eyebrow={workspace.name} title="Workspace settings" />
      <Box borderWidth="1px" borderColor="border" borderRadius="l2" bg="bg.panel" p="6">
        <AuthenticatedActionForm action={updateWorkspaceAction}>
          <Stack gap="3" maxW="520px">
                  <label htmlFor="workspace-name"><Text as="span" fontSize="13px" fontWeight="600">Workspace name</Text></label>
            <Input id="workspace-name" name="name" defaultValue={workspace.name} maxLength={80} disabled={!canManage} />
                  <label htmlFor="workspace-timezone"><Text as="span" fontSize="13px" fontWeight="600">Timezone</Text></label>
            <Combobox id="workspace-timezone" name="timezone" ariaLabel="Workspace timezone" defaultValue={workspace.timezone} items={TIMEZONE_ITEMS} placeholder="Search timezones" disabled={!canManage} />
            <Text fontSize="11px" color="fg.subtle">Used for the calendar and publishing defaults.</Text>
            {canManage ? (
              <ActionSubmitButton pendingLabel="Saving…" size="sm" alignSelf="flex-start">Save workspace</ActionSubmitButton>
            ) : null}
          </Stack>
        </AuthenticatedActionForm>
      </Box>
      <WorkspaceAvatarControl avatarUrl={avatarUrls[appUser.workspaceId] ?? null} workspaceName={workspace.name} canManage={canManage} />
      <Box borderWidth="1px" borderColor="border" borderRadius="l2" bg="bg.panel" p="5">
        <Text fontSize="12px" color="fg.muted">
          Status:{" "}
          <Text as="span" textTransform="capitalize" color="fg">{workspace.status.replace("_", " ")}</Text>
          {workspace.personalOwnerUserId ? " · Personal workspace" : " · Collaborative workspace"}
        </Text>
      </Box>
    </Stack>
  );
}
