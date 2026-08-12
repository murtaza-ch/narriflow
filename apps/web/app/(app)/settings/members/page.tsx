import { Stack } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { workspaceService } from "@narriflow/services";
import { requireWorkspaceAppUser } from "@/lib/workspace";
import { MembersPanel } from "./members-panel";

export default async function MembersSettingsPage() {
  const appUser = await requireWorkspaceAppUser();
  const data = await workspaceService.listMembers(appUser.actorUserId, appUser.workspaceId);
  return (
    <Stack gap="8">
      <PageHeader eyebrow={appUser.workspace.workspaceName} title="Members" description="Invite people and control what they can do across this workspace." />
      <MembersPanel
        actorRole={appUser.workspace.role}
        isBusiness={appUser.workspace.pricingTier === "business"}
        workspaceStatus={appUser.workspace.status}
        members={data.members.map((member) => ({ ...member, joinedAt: member.joinedAt.toISOString() }))}
        invites={data.invites.map((invite) => ({ ...invite, expiresAt: invite.expiresAt.toISOString(), createdAt: invite.createdAt.toISOString() }))}
      />
    </Stack>
  );
}
