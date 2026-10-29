import {
  type AppUser,
  ClerkDirectoryUnavailableError,
  type BearerAuthResult,
  getAppUserForClerkIdentity,
  isWorkspaceId,
  readWorkspaceRequestActor,
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
  /**
   * Single-round-trip answer for a provisioned, fresh user with a current
   * membership of the selected Workspace. Null means "take the full path"
   * (`loadAppUser` then `resolveScopedWorkspace`), which provisions, refreshes
   * or refuses; it is never a refusal by itself.
   */
  readWorkspaceActor?(
    clerkUserId: string,
    requestedWorkspaceId: string | undefined,
  ): Promise<{ user: AppUser; context: WorkspaceActorContext } | null>;
  /**
   * Whether a non-empty `X-Workspace-Id` is shaped like a Workspace id. A
   * header that is not is a 400 `invalid_input` before any read; a well-formed
   * id that is not a current membership stays a 409. Defaults to accepting any.
   */
  isWorkspaceHint?(hint: string): boolean;
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

/** A header that is not a Workspace id at all is a malformed request, not a stale selection. */
function malformedWorkspaceHeader(): AuthenticatedRequestFailure {
  return new AuthenticatedRequestFailure({
    code: "invalid_input",
    category: "validation",
    status: 400,
    message: "Check the highlighted fields and try again.",
    issues: [{ path: ["header", WORKSPACE_HEADER], code: "invalid_string", message: "Must be a Workspace id" }],
  });
}

function authenticationUnavailable(): AuthenticatedRequestFailure {
  return new AuthenticatedRequestFailure({
    code: "authentication_unavailable",
    category: "unavailable",
    status: 503,
    message: "Sign-in is temporarily unavailable. Try again shortly.",
    retryAfterSeconds: 5,
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
          throw authenticationUnavailable();
        }
        return null;
      });
      const appUser = once(async () => {
        const verified = await identity();
        if (!verified) return null;
        try {
          return await options.loadAppUser(verified.clerkUserId);
        } catch (error) {
          // The session is valid; only the Clerk directory lookup that
          // provisions or refreshes the App User could not be answered.
          if (error instanceof ClerkDirectoryUnavailableError) throw authenticationUnavailable();
          throw error;
        }
      });
      const signedIn = once(async (): Promise<SignedInActorScope | null> => {
        const user = await appUser();
        if (!user) return null;
        const { id, ...rest } = user;
        return { ...rest, actorUserId: id };
      });
      const workspace = once(async (): Promise<BrowserActorScope | null> => {
        const verified = await identity();
        if (!verified) return null;
        const hint = request.headers.get(WORKSPACE_HEADER)?.trim() || undefined;
        if (hint !== undefined && options.isWorkspaceHint?.(hint) === false) throw malformedWorkspaceHeader();
        const fast = await options.readWorkspaceActor?.(verified.clerkUserId, hint);
        let user: AppUser;
        let context: WorkspaceActorContext | null;
        if (fast) {
          ({ user, context } = fast);
        } else {
          const loaded = await appUser();
          if (!loaded) return null;
          user = loaded;
          context = await options.resolveScopedWorkspace(user, hint);
        }
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
    readWorkspaceActor: readWorkspaceRequestActor,
    isWorkspaceHint: isWorkspaceId,
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
