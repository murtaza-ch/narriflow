import { listUserWorkspaces } from "@narriflow/auth";
import { workspaceAllowsCapability } from "@narriflow/validators";
import { admitSignedInPage } from "@/lib/authenticated-request-page";
import { WorkspaceUnavailableView } from "./workspace-unavailable-view";

/**
 * Where a member lands when the selected workspace is paused for billing and
 * only its owner can resolve it. It sits outside the app shell (which needs
 * access to the selected workspace), so there is always a way out.
 */
export default async function WorkspaceUnavailablePage() {
  const actor = await admitSignedInPage("/home");
  const memberships = await listUserWorkspaces(actor.actorUserId);
  const workspaces = memberships.map(({ role, workspace }) => ({
    id: workspace.id,
    name: workspace.personalOwnerUserId ? "Personal workspace" : workspace.name,
    paused: workspace.status !== "active",
    canOpen: workspaceAllowsCapability({ role, status: workspace.status }, "content.view"),
  }));

  return <WorkspaceUnavailableView workspaces={workspaces} />;
}
