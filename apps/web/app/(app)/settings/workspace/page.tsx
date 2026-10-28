import { Box, Flex, Input, Stack, Text } from "@chakra-ui/react";
import { Building2, Sparkles } from "lucide-react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { ActionSubmitButton } from "@narriflow/ui/components/action-submit-button";
import { Combobox } from "@narriflow/ui/components/combobox";
import { autoCensorService, performanceService, workspaceService } from "@narriflow/services";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { updatePerformanceGuidanceAction, updateWorkspaceAction } from "../actions";
import { CensorWordsCard } from "./censor-words-card";
import { PerformanceGuidanceField } from "./performance-guidance-field";
import { WorkspaceAvatarControl } from "./workspace-avatar-control";
import { AuthenticatedActionForm } from "@/app/_components/authenticated-action-form";
import { workspaceAllowsCapability } from "@narriflow/validators";
import { AccessNote } from "../_components/access-note";
import { SettingsCard, StatusPill } from "../_components/settings-ui";

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
  const [guidance, censorWords] = await Promise.all([
    performanceService.guidance(appUser),
    autoCensorService.getWorkspaceWords(appUser),
  ]);
  const avatarUrls = await workspaceService.getAvatarUrls(
    appUser.actorUserId,
    [appUser.workspaceId,
  ]);
  // The same capability the save actions and avatar routes admit with.
  const canManage = workspaceAllowsCapability(appUser.workspace, "workspace.manage");
  return (
    <Stack gap="6">
      <PageHeader title="Workspace settings" description="Name, timezone, and how Narriflow picks clips here." />
      <AccessNote access={appUser.workspace} capability="workspace.manage" action="change workspace settings" mt="-2" />
      <SettingsCard
        icon={<Building2 size={16} />}
        title="Workspace"
        action={
          <>
            <StatusPill tone={workspace.status === "active" ? "accent" : "warning"}>
              <Text as="span" textTransform="capitalize">{workspace.status.replace("_", " ")}</Text>
            </StatusPill>
            <StatusPill>{workspace.personalOwnerUserId ? "Personal" : "Collaborative"}</StatusPill>
          </>
        }
      >
        <Flex gap={{ base: "5", md: "8" }} direction={{ base: "column", md: "row" }} align={{ md: "flex-start" }}>
          <WorkspaceAvatarControl avatarUrl={avatarUrls[appUser.workspaceId] ?? null} workspaceName={workspace.name} canManage={canManage} />
          <Box flex="1" minW="0" maxW={{ md: "560px" }}>
            <AuthenticatedActionForm action={updateWorkspaceAction}>
              <Stack gap="4">
                <Stack gap="1.5">
                  <label htmlFor="workspace-name"><Text as="span" fontSize="13px" fontWeight="500">Name</Text></label>
                  <Input id="workspace-name" name="name" defaultValue={workspace.name} maxLength={80} disabled={!canManage} />
                </Stack>
                <Stack gap="1.5">
                  <label htmlFor="workspace-timezone"><Text as="span" fontSize="13px" fontWeight="500">Timezone</Text></label>
                  <Combobox id="workspace-timezone" name="timezone" ariaLabel="Workspace timezone" defaultValue={workspace.timezone} items={TIMEZONE_ITEMS} placeholder="Search timezones" disabled={!canManage} />
                  <Text fontSize="12px" color="fg.subtle">Used for the calendar and publishing defaults.</Text>
                </Stack>
                {canManage ? (
                  <ActionSubmitButton pendingLabel="Saving…" size="sm" alignSelf="flex-start">Save changes</ActionSubmitButton>
                ) : null}
              </Stack>
            </AuthenticatedActionForm>
          </Box>
        </Flex>
      </SettingsCard>
      <SettingsCard icon={<Sparkles size={16} />} title="Clip picking" description="Let what performed well guide which moments become clips.">
        <AuthenticatedActionForm action={updatePerformanceGuidanceAction}>
          <Stack gap="4" maxW="640px">
            <PerformanceGuidanceField
              enabled={guidance.enabled}
              qualifies={guidance.qualifies}
              minimumClips={guidance.minimumWorkspacePosts}
              canManage={canManage}
            />
            {canManage ? (
              <ActionSubmitButton pendingLabel="Saving…" size="sm" alignSelf="flex-start">Save</ActionSubmitButton>
            ) : null}
          </Stack>
        </AuthenticatedActionForm>
      </SettingsCard>
      <CensorWordsCard initialWords={censorWords.words} customized={censorWords.customized} canManage={canManage} />
    </Stack>
  );
}
