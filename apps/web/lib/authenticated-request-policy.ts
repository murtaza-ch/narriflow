import {
  roleHasWorkspaceCapability,
  workspaceAllowsCapability,
  type WorkspaceAccessRole,
  type WorkspaceAccessStatus,
  type WorkspaceCapability,
} from "@narriflow/validators";
import type { ZodType, ZodIssue } from "zod";

export type AuthenticatedRequestAdapter =
  "hono" | "server_action" | "page" | "stream";

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

export interface AuthenticatedRequestFailureValue {
  code: string;
  category: AuthenticatedRequestFailureCategory;
  status: 400 | 401 | 402 | 403 | 404 | 409 | 422 | 429 | 503;
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

export class AuthenticatedRequestFailure extends Error {
  readonly failure: FailureWithoutRequestId;

  constructor(failure: FailureWithoutRequestId) {
    super(failure.message);
    this.name = "AuthenticatedRequestFailure";
    this.failure = failure;
  }
}

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

export interface AuthenticatedRequestOperationContext<
  I,
  TActor extends AuthenticatedActorScope = ActorScope,
> {
  actor: TActor;
  project: ActiveProjectScope | null;
  input: I;
  requestId: string;
}

interface AuthenticatedRequestCommon<
  O,
  TActor extends AuthenticatedActorScope,
> {
  adapter: AuthenticatedRequestAdapter;
  operationName: string;
  admission: AuthenticatedRequestAdmission;
  rateLimit?: {
    key(actor: TActor): string;
    limit: number;
    windowSeconds: number;
  };
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

export interface AuthenticatedRequestPolicyDependencies<
  TActor extends AuthenticatedActorScope = ActorScope,
> {
  resolveActorScope(): Promise<TActor | null>;
  resolveProject(input: {
    actor: TActor & ActorScope;
    projectId: string;
  }): Promise<ProjectAdmissionResult>;
  rateLimit(input: {
    key: string;
    limit: number;
    windowSeconds: number;
  }): Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
  createRequestId(): string;
  now(): number;
  recordDiagnostic?(diagnostic: {
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
  }): void;
  rethrowFrameworkControlFlow?(error: unknown): void;
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

function boundedIssue(issue: ZodIssue): AuthenticatedRequestIssue {
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

export function createAuthenticatedRequestPolicy<
  TActor extends AuthenticatedActorScope = ActorScope,
>(dependencies: AuthenticatedRequestPolicyDependencies<TActor>) {
  return {
    async execute<I, O>(
      request: AuthenticatedRequest<I, O, TActor>,
    ): Promise<AuthenticatedRequestResult<O>> {
      const requestId = dependencies.createRequestId();
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
        actor = await dependencies.resolveActorScope();

        if (!actor) {
          return failed({
            code: "authentication_required",
            category: "authentication",
            status: 401,
            message: "Sign in to continue.",
          });
        }

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

        if (request.rateLimit) {
          const rateLimit = await dependencies.rateLimit({
            key: request.rateLimit.key(actor),
            limit: request.rateLimit.limit,
            windowSeconds: request.rateLimit.windowSeconds,
          });
          if (!rateLimit.allowed) {
            return failed({
              code: "rate_limited",
              category: "rate_limit",
              status: 429,
              message: "Too many requests. Wait before trying again.",
              retryAfterSeconds: Math.max(
                1,
                Math.ceil(
                  rateLimit.retryAfterSeconds ??
                    request.rateLimit.windowSeconds,
                ),
              ),
            });
          }
        }

        let project: ActiveProjectScope | null = null;
        if (request.admission.kind === "project") {
          if (!workspaceActor) {
            throw new Error("Project admission requires a Workspace actor");
          }
          const admitted = await dependencies.resolveProject({
            actor: workspaceActor,
            projectId: request.admission.projectId,
          });
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

        const operation = request.operation as (
          context: AuthenticatedRequestOperationContext<I, TActor>,
        ) => Promise<O>;
        const value = await operation({
          actor,
          project,
          input,
          requestId,
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
        dependencies.rethrowFrameworkControlFlow?.(error);
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

export type AuthenticatedRequestPolicy = ReturnType<
  typeof createAuthenticatedRequestPolicy
>;
