import {
  type AppUser,
  type BearerAuthResult,
  getAppUserForClerkIdentity,
  type ClerkUserDirectory,
  type PlatformActor,
  resolvePlatformActor,
  resolveScopedWorkspaceContext,
  type StaffAllowlist,
  type VerifiedClerkIdentity,
  type WorkspaceActorContext,
} from "@narriflow/auth";
import { getPrismaClient } from "@narriflow/db/client";
import { checkRateLimit } from "@narriflow/services";
import { resolveAuthenticatedProject } from "./project-admission";
import {
  type ActorScope,
  type AuthenticatedActorScope,
  AuthenticatedRequestFailure,
  type AuthenticatedRequestPolicy,
  type AuthenticatedRequestPolicyDependencies,
  createAuthenticatedRequestPolicy,
} from "./request-policy";

export interface BrowserActorScope extends ActorScope, Omit<AppUser, "id"> {
  workspace: WorkspaceActorContext;
}

export interface SignedInActorScope
  extends AuthenticatedActorScope,
    Omit<AppUser, "id"> {}

/**
 * Request-local actor resolution. Each promise is created at most once for one
 * request and dies with it: the memo only deduplicates the several admissions
 * and operations of a single request, and is never shared across requests.
 */
export interface RequestActors {
  /** Verified Clerk identity, or null when no valid Bearer session exists. */
  identity(): Promise<VerifiedClerkIdentity | null>;
  signedIn(): Promise<SignedInActorScope | null>;
  /** Requires the explicit `X-Workspace-Id` selection to be a current membership. */
  workspace(): Promise<BrowserActorScope | null>;
  /** Staff only: an exact server-side allowlist match on the verified identity. */
  platform(): Promise<PlatformActor | null>;
}

export const WORKSPACE_HEADER = "x-workspace-id";

export interface RequestPolicyRuntimeOptions {
  authenticate(request: Request): Promise<BearerAuthResult>;
  loadAppUser(clerkUserId: string): Promise<AppUser>;
  resolveScopedWorkspace(
    user: Pick<AppUser, "id">,
    requestedWorkspaceId: string | undefined,
  ): Promise<WorkspaceActorContext | null>;
  staffAllowlist: StaffAllowlist;
  policy: AuthenticatedRequestPolicyDependencies;
}

export interface RequestPolicyRuntime {
  policy: AuthenticatedRequestPolicy;
  /** Fresh actor promises for one request. Call again to re-verify, e.g. for each stream heartbeat. */
  actorsFor(request: Request): RequestActors;
}

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= load();
    return pending;
  };
}

function workspaceSelectionChanged(): AuthenticatedRequestFailure {
  return new AuthenticatedRequestFailure({
    code: "workspace_selection_changed",
    category: "workspace_selection",
    status: 409,
    message: "Your Workspace selection changed. Reload to continue.",
  });
}

export function createRequestPolicyRuntime(
  options: RequestPolicyRuntimeOptions,
): RequestPolicyRuntime {
  return {
    policy: createAuthenticatedRequestPolicy(options.policy),
    actorsFor(request) {
      const identity = once(async () => {
        const result = await options.authenticate(request);
        if (result.status === "authenticated") return result.identity;
        if (result.status === "unavailable") {
          throw new AuthenticatedRequestFailure({
            code: "authentication_unavailable",
            category: "unavailable",
            status: 503,
            message: "Sign-in is temporarily unavailable. Try again shortly.",
            retryAfterSeconds: 5,
          });
        }
        return null;
      });
      const appUser = once(async () => {
        const verified = await identity();
        return verified ? options.loadAppUser(verified.clerkUserId) : null;
      });
      const signedIn = once(async (): Promise<SignedInActorScope | null> => {
        const user = await appUser();
        if (!user) return null;
        const { id, ...rest } = user;
        return { ...rest, actorUserId: id };
      });
      const workspace = once(async (): Promise<BrowserActorScope | null> => {
        const user = await appUser();
        if (!user) return null;
        const hint = request.headers.get(WORKSPACE_HEADER)?.trim() || undefined;
        const context = await options.resolveScopedWorkspace(user, hint);
        // An absent or removed selection never falls through to another Workspace.
        if (!context || context.userId !== user.id) {
          throw workspaceSelectionChanged();
        }
        const { id, ...rest } = user;
        return {
          ...rest,
          actorUserId: id,
          workspaceId: context.workspaceId,
          workspaceName: context.workspaceName,
          workspaceOwnerUserId: context.workspaceOwnerUserId,
          role: context.role,
          status: context.status,
          pricingTier: context.pricingTier,
          isPersonalWorkspace: context.isPersonal,
          workspaceSelectionChanged: context.workspaceSelectionChanged,
          workspace: context,
        };
      });
      const platform = once(async () => {
        const verified = await identity();
        return verified
          ? resolvePlatformActor(verified, options.staffAllowlist)
          : null;
      });
      return { identity, signedIn, workspace, platform };
    },
  };
}

function logDiagnostic(
  diagnostic: Parameters<
    NonNullable<AuthenticatedRequestPolicyDependencies["recordDiagnostic"]>
  >[0],
): void {
  console.warn(
    JSON.stringify({
      level: diagnostic.disposition === "failed" ? "error" : "info",
      message: "authenticated_request_decision",
      ...diagnostic,
    }),
  );
}

/** Production wiring: Clerk Bearer verification, the shared Prisma client and Redis limiter. */
export function createProductionRequestPolicyRuntime(config: {
  authenticate: RequestPolicyRuntimeOptions["authenticate"];
  clerkClient: ClerkUserDirectory;
  staffAllowlist: StaffAllowlist;
}): RequestPolicyRuntime {
  return createRequestPolicyRuntime({
    authenticate: config.authenticate,
    loadAppUser: (clerkUserId) =>
      getAppUserForClerkIdentity(clerkUserId, config.clerkClient),
    resolveScopedWorkspace: resolveScopedWorkspaceContext,
    staffAllowlist: config.staffAllowlist,
    policy: {
      async resolveProject(input) {
        const prisma = getPrismaClient();
        if (!prisma) {
          throw new Error("DATABASE_URL is required for Project admission");
        }
        return resolveAuthenticatedProject(prisma, input);
      },
      rateLimit: ({ key, limit, windowSeconds }) =>
        checkRateLimit(key, limit, windowSeconds),
      now: Date.now,
      recordDiagnostic: logDiagnostic,
    },
  });
}
