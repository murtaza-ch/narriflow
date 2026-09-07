import "server-only";

import { randomUUID } from "node:crypto";
import { cache } from "react";
import { unstable_rethrow } from "next/navigation";
import {
  getCurrentAppUser,
  getWorkspaceContextForUser,
  type AppUser,
  type WorkspaceActorContext,
} from "@narriflow/auth";
import { getPrismaClient } from "@narriflow/db/client";
import { checkRateLimit } from "@narriflow/services";
import {
  createAuthenticatedRequestPolicy,
  type ActorScope,
  type AuthenticatedActorScope,
  type AuthenticatedRequestPolicyDependencies,
} from "./authenticated-request-policy";
import { resolveAuthenticatedProject } from "./authenticated-request-project";

export interface BrowserActorScope extends ActorScope, Omit<AppUser, "id"> {
  workspace: WorkspaceActorContext;
}

export interface BrowserSignedInActorScope
  extends AuthenticatedActorScope,
    Omit<AppUser, "id"> {}

async function resolveBrowserSignedInActorScopeUncached(): Promise<BrowserSignedInActorScope | null> {
  const appUser = await getCurrentAppUser();
  if (!appUser) return null;
  const { id: _actorId, ...actorUser } = appUser;
  return { ...actorUser, actorUserId: appUser.id };
}

async function resolveBrowserActorScopeUncached(): Promise<BrowserActorScope | null> {
  const appUser = await getCurrentAppUser();
  if (!appUser) return null;

  const workspace = await getWorkspaceContextForUser(appUser);
  if (!workspace || workspace.userId !== appUser.id) return null;

  const { id: _actorId, ...actorUser } = appUser;
  return {
    ...actorUser,
    actorUserId: appUser.id,
    workspaceId: workspace.workspaceId,
    workspaceName: workspace.workspaceName,
    workspaceOwnerUserId: workspace.workspaceOwnerUserId,
    role: workspace.role,
    status: workspace.status,
    pricingTier: workspace.pricingTier,
    isPersonalWorkspace: workspace.isPersonal,
    workspaceSelectionChanged: workspace.workspaceSelectionChanged,
    workspace,
  };
}

export const resolveBrowserActorScope = cache(resolveBrowserActorScopeUncached);
export const resolveFreshBrowserActorScope = resolveBrowserActorScopeUncached;
export const resolveBrowserSignedInActorScope = cache(
  resolveBrowserSignedInActorScopeUncached,
);

async function resolveProject<TActor extends AuthenticatedActorScope>(input: {
  actor: TActor & ActorScope;
  projectId: string;
}) {
  const prisma = getPrismaClient();
  if (!prisma)
    throw new Error("DATABASE_URL is required for Project admission");
  return resolveAuthenticatedProject(prisma, input);
}

function dependencies<TActor extends AuthenticatedActorScope>(
  resolveActorScope: () => Promise<TActor | null>,
): AuthenticatedRequestPolicyDependencies<TActor> {
  return {
    resolveActorScope,
    resolveProject,
    rateLimit: async ({ key, limit, windowSeconds }) =>
      checkRateLimit(key, limit, windowSeconds),
    createRequestId: randomUUID,
    now: Date.now,
    rethrowFrameworkControlFlow: unstable_rethrow,
    recordDiagnostic: (diagnostic) =>
      console.warn(
        JSON.stringify({
          level: diagnostic.disposition === "failed" ? "error" : "info",
          message: "authenticated_request_decision",
          ...diagnostic,
        }),
      ),
  };
}

export const authenticatedRequestPolicy = createAuthenticatedRequestPolicy(
  dependencies(resolveBrowserActorScope),
);

export const freshAuthenticatedRequestPolicy = createAuthenticatedRequestPolicy(
  dependencies(resolveFreshBrowserActorScope),
);

export const signedInAuthenticatedRequestPolicy =
  createAuthenticatedRequestPolicy(
    dependencies(resolveBrowserSignedInActorScope),
  );
