import type { WorkspaceCapability } from "@narriflow/validators";

import { hasFeature } from "./plan-features";
import {
  workspaceService,
  type WorkspaceActorContext,
  type WorkspaceApiKeyScope,
} from "./workspace.service";

export type BusinessAutomationPrincipal =
  | {
      kind: "oauth";
      userId: string;
      clientId: string;
      scopes: readonly string[];
    }
  | {
      kind: "api_key";
      userId: string;
      apiKeyId: string;
      workspaceId: string;
      scopes: readonly string[];
    };

export type BusinessAutomationExecutionPrincipal =
  | { kind: "oauth"; clientId: string }
  | { kind: "api_key"; apiKeyId: string };

export interface BusinessAutomationActorContext extends WorkspaceActorContext {
  automationPrincipal: BusinessAutomationExecutionPrincipal;
}

export type BusinessAutomationAccessErrorCode =
  | "api_key_invalid"
  | "api_key_scope_required"
  | "workspace_boundary_violation"
  | "workspace_forbidden"
  | "workspace_access_unavailable";

export class BusinessAutomationAccessError extends Error {
  constructor(
    readonly code: BusinessAutomationAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BusinessAutomationAccessError";
  }
}

interface BusinessAutomationAccessDependencies {
  requireActor(
    userId: string,
    workspaceId: string,
    capability: WorkspaceCapability,
  ): Promise<WorkspaceActorContext>;
  getPersonalWorkspaceId(userId: string): Promise<string>;
}

const defaultDependencies: BusinessAutomationAccessDependencies = {
  requireActor: (userId, workspaceId, capability) =>
    workspaceService.requireActor(userId, workspaceId, capability),
  getPersonalWorkspaceId: (userId) =>
    workspaceService.getPersonalWorkspaceId(userId),
};

export async function authorizeBusinessAutomation(
  principal: BusinessAutomationPrincipal,
  input: {
    requestedWorkspaceId?: string;
    requiredScope: WorkspaceApiKeyScope;
    capability: WorkspaceCapability;
    integration: "api" | "mcp";
  },
  dependencies: BusinessAutomationAccessDependencies = defaultDependencies,
): Promise<BusinessAutomationActorContext> {
  if (
    principal.kind === "api_key" &&
    !principal.scopes.includes(input.requiredScope)
  ) {
    throw new BusinessAutomationAccessError(
      "api_key_scope_required",
      `This API key requires the ${input.requiredScope} scope`,
    );
  }

  if (
    principal.kind === "api_key" &&
    input.requestedWorkspaceId &&
    principal.workspaceId !== input.requestedWorkspaceId
  ) {
    throw new BusinessAutomationAccessError(
      "workspace_boundary_violation",
      "This API key is bound to a different workspace",
    );
  }

  const workspaceId =
    principal.kind === "api_key"
      ? principal.workspaceId
      : input.requestedWorkspaceId ??
        (await dependencies.getPersonalWorkspaceId(principal.userId));

  let actor: WorkspaceActorContext;
  try {
    actor = await dependencies.requireActor(
      principal.userId,
      workspaceId,
      input.capability,
    );
  } catch {
    throw new BusinessAutomationAccessError(
      "workspace_forbidden",
      "This credential cannot perform that operation",
    );
  }

  const feature = input.integration === "api" ? "integrations.api" : "integrations.mcp";
  if (
    actor.status !== "active" ||
    !hasFeature(actor.pricingTier, feature)
  ) {
    throw new BusinessAutomationAccessError(
      "workspace_access_unavailable",
      `Narriflow ${input.integration.toUpperCase()} access requires an active Business plan`,
    );
  }

  return {
    ...actor,
    automationPrincipal:
      principal.kind === "api_key"
        ? { kind: "api_key", apiKeyId: principal.apiKeyId }
        : { kind: "oauth", clientId: principal.clientId },
  };
}
