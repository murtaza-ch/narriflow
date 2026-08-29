import "server-only";

import type { WorkspaceCapability } from "@narriflow/validators";
import { hasUserErrorMessage, userErrorMessage } from "@narriflow/validators";
import type { ZodType } from "zod";
import {
  authenticatedRequestPolicy,
  signedInAuthenticatedRequestPolicy,
} from "./authenticated-request-policy.server";
import type {
  AuthenticatedActorScope,
  AuthenticatedRequest,
  AuthenticatedRequestAdmission,
  AuthenticatedRequestFailureValue,
  AuthenticatedRequestOperationContext,
  AuthenticatedRequestResult,
} from "./authenticated-request-policy";
import { AuthenticatedRequestUnexpectedError } from "./authenticated-request-policy";
import type {
  BrowserActorScope,
  BrowserSignedInActorScope,
} from "./authenticated-request-policy.server";

export interface AuthenticatedActionFailure {
  ok: false;
  error: string;
  code: string;
  message: string;
  requestId: string;
  issues?: AuthenticatedRequestFailureValue["issues"];
  details?: AuthenticatedRequestFailureValue["details"];
  retryAfterSeconds?: number;
}

function serializedActionFailure(
  failure: AuthenticatedRequestFailureValue,
): AuthenticatedActionFailure {
  return {
    ok: false,
    error: failure.code,
    code: failure.code,
    message: failure.message,
    requestId: failure.requestId,
    ...(failure.issues ? { issues: failure.issues } : {}),
    ...(failure.details ? { details: failure.details } : {}),
    ...(failure.retryAfterSeconds
      ? { retryAfterSeconds: failure.retryAfterSeconds }
      : {}),
  };
}

export function authenticatedActionErrorMessage(
  error: unknown,
  fallback: string,
): string {
  rethrowUnexpectedActionError(error);
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : null;
  const message = code ? userErrorMessage(code) : null;
  if (!code || !hasUserErrorMessage(code) || !message) throw error;
  return message ?? fallback;
}

export function authenticatedActionResultError(
  error: unknown,
  fallback: string,
): {
  message: string;
  errorCode: string;
  requestId?: string;
  issues?: AuthenticatedRequestFailureValue["issues"];
  details?: AuthenticatedRequestFailureValue["details"];
  retryAfterSeconds?: number;
} {
  rethrowUnexpectedActionError(error);
  const errorCode =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : null;
  const message = errorCode ? userErrorMessage(errorCode) : null;
  if (!errorCode || !hasUserErrorMessage(errorCode) || !message) throw error;
  return {
    message: message ?? fallback,
    errorCode,
  };
}

function rethrowUnexpectedActionError(error: unknown): void {
  if (error instanceof AuthenticatedRequestUnexpectedError) throw error;
}

function diagnoseActionResult(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { ok?: unknown; error?: unknown };
  const isFailure =
    candidate.ok === false ||
    (candidate.ok !== true && typeof candidate.error === "string");
  if (!isFailure) return null;

  const result = value as { code?: unknown; error?: unknown; errorCode?: unknown };
  const failureCode = [result.code, result.errorCode, result.error].find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.length > 0,
  );
  return {
    disposition: "refused" as const,
    failureCode: failureCode ?? "action_refused",
    status: 422,
  };
}

function attachActionRequestId<O>(value: O, requestId: string): O {
  if (!value || typeof value !== "object") return value;
  const candidate = value as {
    ok?: unknown;
    error?: unknown;
    requestId?: unknown;
  };
  const isFailure =
    candidate.ok === false ||
    (candidate.ok !== true && typeof candidate.error === "string");
  if (!isFailure || typeof candidate.requestId === "string") return value;
  return { ...value, requestId };
}

type AuthenticatedActionOperation<TActor extends AuthenticatedActorScope, O> = (
  actor: TActor,
  context: AuthenticatedRequestOperationContext<undefined, TActor>,
) => Promise<O>;

interface AuthenticatedActionOptions<TActor extends AuthenticatedActorScope> {
  operationName?: string;
  rateLimit?: {
    key(actor: TActor): string;
    limit: number;
    windowSeconds: number;
  };
}

interface ActionPolicy<TActor extends AuthenticatedActorScope> {
  execute<I, O>(
    request: AuthenticatedRequest<I, O, TActor>,
  ): Promise<AuthenticatedRequestResult<O>>;
}

async function executeAction<TActor extends AuthenticatedActorScope, O>(
  policy: ActionPolicy<TActor>,
  admission: AuthenticatedRequestAdmission,
  operation: AuthenticatedActionOperation<TActor, O>,
  options?: AuthenticatedActionOptions<TActor>,
): Promise<O | AuthenticatedActionFailure> {
  const result = await policy.execute<undefined, O>({
    adapter: "server_action",
    operationName:
      options?.operationName ??
      (admission.kind === "project"
        ? "execute-project-action"
        : admission.kind === "signed_in"
          ? "execute-signed-in-action"
          : "execute-workspace-action"),
    admission,
    rateLimit: options?.rateLimit,
    diagnoseResult: async (value) => diagnoseActionResult(value),
    operation: async (context) =>
      attachActionRequestId(
        await operation(context.actor, context),
        context.requestId,
      ),
  });
  if (result.ok) return result.value;
  return serializedActionFailure(result.failure);
}

export function executeWorkspaceAction<O>(
  capability: WorkspaceCapability,
  operation: AuthenticatedActionOperation<BrowserActorScope, O>,
  options?: AuthenticatedActionOptions<BrowserActorScope>,
): Promise<O | AuthenticatedActionFailure> {
  return executeAction(
    authenticatedRequestPolicy,
    { kind: "workspace", capability },
    operation,
    options,
  );
}

export function executeSignedInAction<O>(
  operation: AuthenticatedActionOperation<BrowserSignedInActorScope, O>,
): Promise<O | AuthenticatedActionFailure> {
  return executeAction(
    signedInAuthenticatedRequestPolicy,
    { kind: "signed_in" },
    operation,
  );
}

export function executeProjectAction<O>(
  projectId: string,
  capability: WorkspaceCapability,
  operation: AuthenticatedActionOperation<BrowserActorScope, O>,
  options?: AuthenticatedActionOptions<BrowserActorScope>,
): Promise<O | AuthenticatedActionFailure> {
  return executeAction(
    authenticatedRequestPolicy,
    { kind: "project", capability, projectId },
    operation,
    options,
  );
}

type AuthenticatedInputActionOperation<
  TActor extends AuthenticatedActorScope,
  I,
  O,
> = (
  actor: TActor,
  input: I,
  context: AuthenticatedRequestOperationContext<I, TActor>,
) => Promise<O>;

async function executeInputAction<
  TActor extends AuthenticatedActorScope,
  I,
  O,
>(
  policy: ActionPolicy<TActor>,
  admission: AuthenticatedRequestAdmission,
  untrustedInput: unknown,
  schema: ZodType<I>,
  operation: AuthenticatedInputActionOperation<TActor, I, O>,
  options?: AuthenticatedActionOptions<TActor>,
): Promise<O | AuthenticatedActionFailure> {
  const result = await policy.execute<I, O>({
    adapter: "server_action",
    operationName:
      options?.operationName ??
      (admission.kind === "project"
        ? "execute-project-action"
        : admission.kind === "signed_in"
          ? "execute-signed-in-action"
          : "execute-workspace-action"),
    admission,
    rateLimit: options?.rateLimit,
    input: {
      load: async () => untrustedInput,
      schema,
    },
    diagnoseResult: async (value) => diagnoseActionResult(value),
    operation: async (
      context: AuthenticatedRequestOperationContext<I, TActor>,
    ) =>
      attachActionRequestId(
        await operation(context.actor, context.input, context),
        context.requestId,
      ),
  });
  return result.ok ? result.value : serializedActionFailure(result.failure);
}

export function executeWorkspaceActionWithInput<I, O>(
  capability: WorkspaceCapability,
  untrustedInput: unknown,
  schema: ZodType<I>,
  operation: AuthenticatedInputActionOperation<BrowserActorScope, I, O>,
  options?: AuthenticatedActionOptions<BrowserActorScope>,
): Promise<O | AuthenticatedActionFailure> {
  return executeInputAction(
    authenticatedRequestPolicy,
    { kind: "workspace", capability },
    untrustedInput,
    schema,
    operation,
    options,
  );
}

export function executeSignedInActionWithInput<I, O>(
  untrustedInput: unknown,
  schema: ZodType<I>,
  operation: AuthenticatedInputActionOperation<
    BrowserSignedInActorScope,
    I,
    O
  >,
): Promise<O | AuthenticatedActionFailure> {
  return executeInputAction(
    signedInAuthenticatedRequestPolicy,
    { kind: "signed_in" },
    untrustedInput,
    schema,
    operation,
  );
}

export function executeProjectActionWithInput<I, O>(
  projectId: string,
  capability: WorkspaceCapability,
  untrustedInput: unknown,
  schema: ZodType<I>,
  operation: AuthenticatedInputActionOperation<BrowserActorScope, I, O>,
  options?: AuthenticatedActionOptions<BrowserActorScope>,
): Promise<O | AuthenticatedActionFailure> {
  return executeInputAction(
    authenticatedRequestPolicy,
    { kind: "project", capability, projectId },
    untrustedInput,
    schema,
    operation,
    options,
  );
}
