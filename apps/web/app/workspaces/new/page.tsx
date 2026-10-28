import { admitSignedInPage } from "@/lib/authenticated-request-page";
import { NewWorkspaceScreen } from "./new-workspace-screen";

export default async function NewWorkspacePage() {
  await admitSignedInPage("/workspaces/new");

  return <NewWorkspaceScreen />;
}
