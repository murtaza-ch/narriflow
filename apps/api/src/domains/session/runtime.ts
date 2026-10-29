import {
  listUserWorkspaces,
  resolveWorkspaceContext,
  selectWorkspaceForActor,
} from "@narriflow/auth";
import { projectService, workspaceMembershipService, workspaceService } from "@narriflow/services";
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
    selectWorkspaceForActor,
    listUserWorkspaces,
    workspaceService,
    workspaceMembershipService,
    projectService,
    authContinuation: {
      issuerUrl: configuredOrigin(process.env.CLERK_OAUTH_ISSUER),
      consentOrigin: configuredOrigin(process.env.CLERK_OAUTH_CONSENT_ORIGIN),
    },
  };
}
