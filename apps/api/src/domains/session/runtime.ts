import { readServiceEnvironment } from "@narriflow/services/runtime-environment";
import {
  listUserWorkspaces,
  resolveWorkspaceContext,
  selectListedWorkspace,
  selectWorkspaceForActor,
} from "@narriflow/auth";
import { projectService } from "@narriflow/services/project.service";
import { workspaceMembershipService } from "@narriflow/services/workspace-membership.service";
import { workspaceService } from "@narriflow/services/workspace.service";
import { parseOrigin } from "@narriflow/validators/api/origins";
import type { ApiConfig } from "../../config";
import type { SessionRouteDeps } from "./routes";

function configuredOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? parseOrigin(trimmed) : null;
}

/** Production wiring of the session routes. */
export function createSessionRouteDeps(_config: ApiConfig): SessionRouteDeps {
  return {
    resolveWorkspaceContext,
    selectListedWorkspace,
    selectWorkspaceForActor,
    listUserWorkspaces,
    workspaceService,
    workspaceMembershipService,
    projectService,
    authContinuation: {
      issuerUrl: configuredOrigin(readServiceEnvironment().CLERK_OAUTH_ISSUER),
      consentOrigin: configuredOrigin(readServiceEnvironment().CLERK_OAUTH_CONSENT_ORIGIN),
    },
  };
}
