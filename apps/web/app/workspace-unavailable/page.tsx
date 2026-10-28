import { WorkspaceUnavailableScreen } from "./workspace-unavailable-view";

/**
 * Where a member lands when the selected workspace is paused for billing and
 * only its owner can resolve it. It sits outside the app shell (which needs
 * access to the selected workspace), so there is always a way out: it reads
 * only the identity bootstrap, which never looks at any one workspace's status.
 */
export default function WorkspaceUnavailablePage() {
  return <WorkspaceUnavailableScreen />;
}
