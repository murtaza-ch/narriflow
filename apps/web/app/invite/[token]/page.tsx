import { admitSignedInPage } from "@/lib/authenticated-request-page";
import { workspaceService } from "@narriflow/services";
import { acceptWorkspaceInviteAction } from "./actions";
import { InviteCard, InviteUnavailable } from "./invite-view";

export default async function WorkspaceInvitePage({ params,
}: { params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const [, invite] = await Promise.all([
    admitSignedInPage(`/invite/${encodeURIComponent(token)}`), workspaceService.getInvitePreview(token),
  ]);
  if (!invite) return <InviteUnavailable />;
  return (
    <InviteCard
      workspaceName={invite.workspace.name}
      role={invite.role}
      email={invite.email}
      expiresAt={invite.expiresAt}
      action={acceptWorkspaceInviteAction.bind(null, token)}
    />
  );
}
