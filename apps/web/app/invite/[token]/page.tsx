import { InviteScreen } from "./invite-view";

// Data-free: the invitation preview and its acceptance are signed-in API calls in the client screen.
export default async function WorkspaceInvitePage({ params,
}: { params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <InviteScreen token={token} />;
}
