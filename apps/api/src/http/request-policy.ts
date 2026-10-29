import {
  roleHasWorkspaceCapability,
  type WorkspaceAccessRole,
  type WorkspaceAccessStatus,
  type WorkspaceCapability,
  workspaceAllowsCapability,
} from "@narriflow/validators";
import type { ZodIssue, ZodType } from "zod";

export type AuthenticatedRequestAdapter = "hono" | "stream";

export type AuthenticatedRequestFailureCategory =
  | "authentication"
  | "workspace_selection"
  | "authorization"
  | "missing"
  | "validation"
  | "semantic_refusal"
  | "payment_refusal"
  | "conflict"
  | "rate_limit"
  | "unavailable"
  | "accepted";

export interface AuthenticatedActorScope {
  actorUserId: string;
}

export interface ActorScope extends AuthenticatedActorScope {
  workspaceId: string;
  workspaceName: string;
  workspaceOwnerUserId: string;
  role: WorkspaceAccessRole;
  status: WorkspaceAccessStatus;
  pricingTier: string;
  isPersonalWorkspace: boolean;
  workspaceSelectionChanged: boolean;
}

export interface ActiveProjectScope {
  projectId: string;
}

export type ProjectAdmissionResult =
  | { kind: "active"; projectId: string }
  | { kind: "missing" }
  | {
      kind: "workspace_mismatch";
      projectId: string;
      workspaceId: string;
      workspaceName: string;
    };

export interface AuthenticatedRequestIssue {
  path: Array<string | number>;
  code: string;
  message: string;
}

export type AuthenticatedRequestFailureStatus =
  | 400
  | 401
  | 402
  | 403
  | 404
  | 409
  | 415
  | 422
  | 429
  | 503;

export interface AuthenticatedRequestFailureValue {
  code: string;
  category: AuthenticatedRequestFailureCategory;
  status: AuthenticatedRequestFailureStatus;
  message: string;
  requestId: string;
  issues?: AuthenticatedRequestIssue[];
  details?: Record<string, unknown>;
  retryAfterSeconds?: number;
}

type FailureWithoutRequestId = Omit<
  AuthenticatedRequestFailureValue,
  "requestId"
>;

/** An expected refusal. Thrown by actor resolvers and operations; the policy turns it into a typed result. */
export class AuthenticatedRequestFailure extends Error {
  readonly failure: FailureWithoutRequestId;

  constructor(failure: FailureWithoutRequestId) {
    super(failure.message);
    this.name = "AuthenticatedRequestFailure";
    this.failure = failure;
  }
}

/** Anything the policy did not expect. Carries the request ID so the transport answers a generic 500 with it. */
export class AuthenticatedRequestUnexpectedError extends Error {
  readonly requestId: string;
  override readonly cause: unknown;

  constructor(requestId: string, cause: unknown) {
    super("Unexpected authenticated request failure");
    this.name = "AuthenticatedRequestUnexpectedError";
    this.requestId = requestId;
    this.cause = cause;
  }
}

export type AuthenticatedRequestAdmission =
  | { kind: "signed_in" }
  | { kind: "workspace"; capability: WorkspaceCapability }
  | {
      kind: "project";
      capability: WorkspaceCapability;
      projectId: string;
    };

/**
 * The limiter's answer for the whole request. Commands that must replay an
 * accepted receipt before refusing (`deferRateRefusal`) receive it in the
 * operation context and enforce it only for genuinely new work.
 */
export interface RecordedRateLimit {
  allowed: boolean;
  availability: "available" | "unavailable";
  /** Seconds until the tightest exhausted window reopens, when known. */
  retryAfterSeconds?: number;
  /** The most constraining window, for `RateLimit-*` response headers. */
  limit?: number;
  remaining?: number;
  resetSeconds?: number;
}

export interface AuthenticatedRequestOperationContext<
  I,
  TActor extends AuthenticatedActorScope = ActorScope,
> {
  actor: TActor;
  project: ActiveProjectScope | null;
  input: I;
  requestId: string;
  /** Null when the request declared no limits. */
  rateLimit: RecordedRateLimit | null;
}

export interface RateLimitRule<TActor extends AuthenticatedActorScope> {
  key(actor: TActor): string;
  limit: number;
  windowSeconds: number;
}

interface AuthenticatedRequestCommon<
  O,
  TActor extends AuthenticatedActorScope,
> {
  adapter: AuthenticatedRequestAdapter;
  operationName: string;
  admission: AuthenticatedRequestAdmission;
  /** Every rule is checked in order; the first exhausted window refuses the request. */
  rateLimit?: RateLimitRule<TActor> | readonly RateLimitRule<TActor>[];
  /**
   * Record limiter outcomes instead of refusing. Receipt-backed commands set
   * this so an immutable replay is answered before an exhausted or unavailable
   * limiter can refuse, then enforce the recorded outcome in `beforeAccept`.
   */
  deferRateRefusal?: boolean;
  diagnoseResult?(value: O): Promise<{
    disposition: "refused" | "failed";
    failureCode: string;
    status: number;
  } | null>;
}

export type AuthenticatedRequest<
  I,
  O,
  TActor extends AuthenticatedActorScope = ActorScope,
> = AuthenticatedRequestCommon<O, TActor> &
  (
    | {
        input: {
          load(): Promise<unknown>;
          schema: ZodType<I>;
        };
        operation(
          context: AuthenticatedRequestOperationContext<I, TActor>,
        ): Promise<O>;
      }
    | {
        input?: never;
        operation(
          context: AuthenticatedRequestOperationContext<undefined, TActor>,
        ): Promise<O>;
      }
  );

export type AuthenticatedRequestResult<O> =
  | { ok: true; requestId: string; value: O }
  | { ok: false; requestId: string; failure: AuthenticatedRequestFailureValue };

export interface RateLimitCheck {
  allowed: boolean;
  availability?: "available" | "unavailable";
  limit?: number;
  remaining?: number;
  retryAfterSeconds?: number;
}

export interface AuthenticatedRequestDiagnostic {
  requestId: string;
  adapter: AuthenticatedRequestAdapter;
  operationName: string;
  failureCode?: string;
  status?: number;
  actorUserId?: string;
  workspaceId?: string;
  projectId?: string;
  elapsedMs: number;
  disposition: "succeeded" | "refused" | "failed";
}

/** Process-wide collaborators. Nothing here is request-scoped, so nothing authorization-related is cached. */
export interface AuthenticatedRequestPolicyDependencies {
  resolveProject(input: {
    actor: ActorScope;
    projectId: string;
  }): Promise<ProjectAdmissionResult>;
  rateLimit(input: {
    key: string;
    limit: number;
    windowSeconds: number;
  }): Promise<RateLimitCheck>;
  now(): number;
  recordDiagnostic?(diagnostic: AuthenticatedRequestDiagnostic): void;
}

/**
 * The per-request half of an execution: the outer request ID (the policy never
 * generates its own) and the request-local actor promise. Resolving may return
 * `null` for "not signed in" or throw `AuthenticatedRequestFailure` for a
 * typed refusal such as an unavailable identity provider.
 */
export interface AuthenticatedRequestInvocation<
  TActor extends AuthenticatedActorScope,
> {
  requestId: string;
  resolveActor(): Promise<TActor | null>;
}

function failure(
  requestId: string,
  value: FailureWithoutRequestId,
): AuthenticatedRequestResult<never> {
  return {
    ok: false,
    requestId,
    failure: { ...value, requestId },
  };
}

export function boundedIssue(issue: ZodIssue): AuthenticatedRequestIssue {
  return {
    path: issue.path
      .slice(0, 5)
      .map((part) =>
        typeof part === "symbol" ? (part.description ?? "field") : part,
      ),
    code: issue.code,
    message: issue.message.slice(0, 240),
  };
}

function isWorkspaceActorScope(
  actor: AuthenticatedActorScope,
): actor is ActorScope {
  return (
    "workspaceId" in actor &&
    typeof actor.workspaceId === "string" &&
    "role" in actor &&
    typeof actor.role === "string" &&
    "status" in actor &&
    typeof actor.status === "string"
  );
}

function ruleList<TActor extends AuthenticatedActorScope>(
  value: AuthenticatedRequestCommon<unknown, TActor>["rateLimit"],
): readonly RateLimitRule<TActor>[] {
  if (!value) return [];
  return "key" in value ? [value] : value;
}

export function createAuthenticatedRequestPolicy(
  dependencies: AuthenticatedRequestPolicyDependencies,
) {
  return {
    async execute<
      I,
      O,
      TActor extends AuthenticatedActorScope = ActorScope,
    >(
      request: AuthenticatedRequest<I, O, TActor>,
      invocation: AuthenticatedRequestInvocation<TActor>,
    ): Promise<AuthenticatedRequestResult<O>> {
      const { requestId } = invocation;
      const startedAt = dependencies.now();
      let actor: TActor | null = null;
      const record = (
        disposition: "succeeded" | "refused" | "failed",
        failureCode?: string,
        status?: number,
      ) =>
        dependencies.recordDiagnostic?.({
          requestId,
          adapter: request.adapter,
          operationName: request.operationName,
          ...(failureCode ? { failureCode } : {}),
          ...(status ? { status } : {}),
          ...(actor ? { actorUserId: actor.actorUserId } : {}),
          ...(actor && isWorkspaceActorScope(actor)
            ? { workspaceId: actor.workspaceId }
            : {}),
          ...(request.admission.kind === "project"
            ? { projectId: request.admission.projectId }
            : {}),
          elapsedMs: Math.max(0, dependencies.now() - startedAt),
          disposition,
        });
      const failed = (
        value: FailureWithoutRequestId,
      ): AuthenticatedRequestResult<never> => {
        record("refused", value.code, value.status);
        return failure(requestId, value);
      };

      try {
        // 1. Identity, and for scoped admissions the explicitly selected Workspace.
        actor = await invocation.resolveActor();

        if (!actor) {
          return failed({
            code: "authentication_required",
            category: "authentication",
            status: 401,
            message: "Sign in to continue.",
          });
        }

        // 2. Capability and Workspace status.
        let workspaceActor: (TActor & ActorScope) | null = null;
        if (request.admission.kind !== "signed_in") {
          if (!isWorkspaceActorScope(actor)) {
            throw new Error(
              "Workspace and Project admission require a Workspace actor resolver",
            );
          }
          workspaceActor = actor;
          const { capability } = request.admission;
          if (!roleHasWorkspaceCapability(workspaceActor.role, capability)) {
            return failed({
              code: "capability_denied",
              category: "authorization",
              status: 403,
              message: "You do not have permission to perform this action.",
            });
          }
          if (!workspaceAllowsCapability(workspaceActor, capability)) {
            return failed({
              code: "workspace_restricted",
              category: "authorization",
              status: 403,
              message:
                workspaceActor.role === "owner"
                  ? "Resolve Workspace billing to continue."
                  : "Ask the Workspace owner to resolve billing before trying again.",
              details: { ownerCanResolve: workspaceActor.role === "owner" },
            });
          }
        }

        // The Project read does not depend on the limiter's answer, so it starts
        // now and overlaps the limiter round trips. The decision order is
        // unchanged: a rate refusal is answered before the Project is
        // consulted, and an unused read is discarded.
        const admission = request.admission;
        const projectRead =
          admission.kind === "project" && workspaceActor
            ? dependencies.resolveProject({
                actor: workspaceActor,
                projectId: admission.projectId,
              })
            : null;
        projectRead?.catch(() => undefined);

        // 3. Rate limits.
        let recorded: RecordedRateLimit | null = null;
        for (const rule of ruleList(request.rateLimit)) {
          const check = await dependencies.rateLimit({
            key: rule.key(actor),
            limit: rule.limit,
            windowSeconds: rule.windowSeconds,
          });
          recorded = mergeRateLimit(
            recorded,
            check,
            rule.windowSeconds,
            dependencies.now(),
          );
          if (!check.allowed) {
            if (request.deferRateRefusal) break;
            return failed({
              code: "rate_limited",
              category: "rate_limit",
              status: 429,
              message: "Too many requests. Wait before trying again.",
              retryAfterSeconds: recorded.retryAfterSeconds ?? rule.windowSeconds,
            });
          }
        }

        // 4. Project concealment and Workspace mismatch.
        let project: ActiveProjectScope | null = null;
        if (projectRead) {
          const admitted = await projectRead;
          if (admitted.kind === "missing") {
            return failed({
              code: "project_not_found",
              category: "missing",
              status: 404,
              message: "This Project is unavailable.",
            });
          }
          if (admitted.kind === "workspace_mismatch") {
            return failed({
              code: "active_workspace_mismatch",
              category: "workspace_selection",
              status: 409,
              message: "Switch Workspaces to open this Project.",
              details: {
                workspaceId: admitted.workspaceId,
                workspaceName: admitted.workspaceName,
              },
            });
          }
          project = { projectId: admitted.projectId };
        }

        // 5. Input.
        let input: I | undefined;
        if (request.input) {
          const parsed = request.input.schema.safeParse(
            await request.input.load(),
          );
          if (!parsed.success) {
            return failed({
              code: "invalid_input",
              category: "validation",
              status: 400,
              message: "Check the highlighted fields and try again.",
              issues: parsed.error.issues.slice(0, 8).map(boundedIssue),
            });
          }
          input = parsed.data;
        }

        // 6. Operation.
        const operation = request.operation as (
          context: AuthenticatedRequestOperationContext<I, TActor>,
        ) => Promise<O>;
        const value = await operation({
          actor,
          project,
          input,
          requestId,
          rateLimit: recorded,
        } as AuthenticatedRequestOperationContext<I, TActor>);
        const diagnosed = await request.diagnoseResult?.(value);
        if (diagnosed) {
          record(
            diagnosed.disposition,
            diagnosed.failureCode,
            diagnosed.status,
          );
        } else {
          record("succeeded");
        }
        return { ok: true, requestId, value };
      } catch (error) {
        if (error instanceof AuthenticatedRequestFailure) {
          return failed(error.failure);
        }
        if (error instanceof AuthenticatedRequestUnexpectedError) throw error;
        record("failed", "internal_error", 500);
        throw new AuthenticatedRequestUnexpectedError(requestId, error);
      }
    },
  };
}

function mergeRateLimit(
  previous: RecordedRateLimit | null,
  check: RateLimitCheck,
  windowSeconds: number,
  nowMs: number,
): RecordedRateLimit {
  const retryAfterSeconds = check.allowed
    ? previous?.retryAfterSeconds
    : Math.max(1, Math.ceil(check.retryAfterSeconds ?? windowSeconds));
  const tighter =
    check.availability !== "unavailable" &&
    check.limit !== undefined &&
    check.remaining !== undefined &&
    (previous?.remaining === undefined || check.remaining < previous.remaining);
  const window = tighter
    ? {
        limit: check.limit,
        remaining: check.remaining,
        resetSeconds:
          windowSeconds - (Math.floor(nowMs / 1000) % windowSeconds),
      }
    : {
        limit: previous?.limit,
        remaining: previous?.remaining,
        resetSeconds: previous?.resetSeconds,
      };
  return {
    allowed: (previous?.allowed ?? true) && check.allowed,
    availability:
      check.availability === "unavailable" ||
      previous?.availability === "unavailable"
        ? "unavailable"
        : "available",
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    ...(window.limit === undefined ? {} : { limit: window.limit }),
    ...(window.remaining === undefined ? {} : { remaining: window.remaining }),
    ...(window.resetSeconds === undefined
      ? {}
      : { resetSeconds: window.resetSeconds }),
  };
}

export type AuthenticatedRequestPolicy = ReturnType<
  typeof createAuthenticatedRequestPolicy
>;
