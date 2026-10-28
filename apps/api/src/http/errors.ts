import {
  boundedExpectedDomainFailureDetails,
  type ExpectedDomainFailure,
  type ExpectedDomainFailureKind,
  isExpectedDomainFailure,
} from "@narriflow/services";
import type { ApiErrorBody } from "@narriflow/validators/api/errors";
import type { Context, Next } from "hono";
import type { ApiEnv } from "./env";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import {
  AuthenticatedRequestFailure,
  type AuthenticatedRequestFailureCategory,
  type AuthenticatedRequestFailureValue,
  AuthenticatedRequestUnexpectedError,
} from "./request-policy";

const DOMAIN_FAILURE_HTTP: Record<
  ExpectedDomainFailureKind,
  {
    category: AuthenticatedRequestFailureCategory;
    status: AuthenticatedRequestFailureValue["status"];
  }
> = {
  invalid: { category: "semantic_refusal", status: 400 },
  unprocessable: { category: "validation", status: 422 },
  forbidden: { category: "authorization", status: 403 },
  payment_required: { category: "payment_refusal", status: 402 },
  missing: { category: "missing", status: 404 },
  conflict: { category: "conflict", status: 409 },
  rate_limited: { category: "rate_limit", status: 429 },
  unavailable: { category: "unavailable", status: 503 },
};

const MAX_RETRY_AFTER_SECONDS = 86_400;
const GENERIC_SERVER_MESSAGE =
  "Something went wrong. Try again or contact support.";

/** The HTTP status for an expected domain failure, shared by the first-party API and public REST. */
export function domainFailureHttpStatus(kind: ExpectedDomainFailureKind) {
  return DOMAIN_FAILURE_HTTP[kind].status;
}

export function requestFailureFromDomain(
  failure: ExpectedDomainFailure,
): AuthenticatedRequestFailure {
  const transport = DOMAIN_FAILURE_HTTP[failure.kind];
  const details = boundedExpectedDomainFailureDetails(failure.details);
  return new AuthenticatedRequestFailure({
    code: failure.code,
    category: transport.category,
    status: transport.status,
    message: failure.message,
    ...(details ? { details } : {}),
    ...(failure.retryAfterSeconds
      ? { retryAfterSeconds: failure.retryAfterSeconds }
      : {}),
  });
}

function boundedRetryAfter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(value))
    : undefined;
}

/** Serializes a failure into the one ordinary error envelope. */
export function errorEnvelope(failure: AuthenticatedRequestFailureValue): {
  body: ApiErrorBody;
  status: AuthenticatedRequestFailureValue["status"];
  retryAfterSeconds: number | undefined;
} {
  const retryAfterSeconds = boundedRetryAfter(failure.retryAfterSeconds);
  return {
    body: {
      error: failure.code,
      message: failure.message,
      requestId: failure.requestId,
      ...(failure.issues ? { issues: failure.issues } : {}),
      ...(failure.details ? { details: failure.details } : {}),
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    },
    status: failure.status,
    retryAfterSeconds,
  };
}

/** A complete JSON error response carrying the request ID and any retry guidance. */
export function failureResponse(
  failure: AuthenticatedRequestFailureValue,
): Response {
  const { body, status, retryAfterSeconds } = errorEnvelope(failure);
  const headers = new Headers({
    "Content-Type": "application/json; charset=UTF-8",
    "X-Request-ID": failure.requestId,
  });
  if (retryAfterSeconds) headers.set("Retry-After", String(retryAfterSeconds));
  return new Response(JSON.stringify(body), { status, headers });
}

/** Common refusals every route class can produce, with stable codes. */
export const COMMON_FAILURES = {
  notFound: {
    code: "not_found",
    category: "missing",
    status: 404,
    message: "This resource was not found.",
  },
  invalidJson: {
    code: "invalid_json",
    category: "validation",
    status: 400,
    message: "The request body is not valid JSON.",
  },
  unsupportedMediaType: {
    code: "unsupported_media_type",
    category: "validation",
    status: 415,
    message: "Send the request body as application/json.",
  },
} as const;

/** 413 is outside the typed failure statuses, so oversized bodies use this dedicated response. */
export function payloadTooLargeResponse(requestId: string): Response {
  return jsonError(
    413,
    "payload_too_large",
    "The request is too large.",
    requestId,
  );
}

export function jsonError(
  status: number,
  error: string,
  message: string,
  requestId: string,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error, message, requestId } satisfies ApiErrorBody), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Request-ID": requestId,
      ...extraHeaders,
    },
  });
}

export function requestIdOf(c: Context<ApiEnv>): string {
  return c.get("requestId") ?? crypto.randomUUID();
}

/** Marks the response as an envelope this module already built, so normalization leaves it alone. */
export function markEnvelope(c: Context<ApiEnv>, response: Response): Response {
  c.set("errorEnvelope", true);
  return response;
}

function logUnexpected(c: Context<ApiEnv>, requestId: string, cause: unknown): void {
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? (cause as { code: unknown }).code
      : undefined;
  console.warn(
    JSON.stringify({
      level: "error",
      message: "unexpected_request_failure",
      requestId,
      method: c.req.method,
      route: routePath(c, -1),
      errorName: cause instanceof Error ? cause.name : typeof cause,
      ...(typeof code === "string" || typeof code === "number"
        ? { errorCode: code }
        : {}),
    }),
  );
}

function internalFailureResponse(requestId: string): Response {
  return jsonError(500, "internal_error", GENERIC_SERVER_MESSAGE, requestId);
}

function httpExceptionResponse(error: HTTPException, requestId: string): Response {
  if (error.status === 413) return payloadTooLargeResponse(requestId);
  if (error.status === 400) {
    return jsonError(
      400,
      error.message.toLowerCase().includes("malformed json")
        ? "invalid_json"
        : "invalid_request",
      error.message.toLowerCase().includes("malformed json")
        ? COMMON_FAILURES.invalidJson.message
        : "The request could not be understood.",
      requestId,
    );
  }
  if (error.status >= 500) return internalFailureResponse(requestId);
  return jsonError(
    error.status,
    "request_failed",
    "The request could not be completed.",
    requestId,
  );
}

/** `app.onError`: every thrown value becomes the safe envelope with the outer request ID. */
export function apiErrorHandler(error: Error, c: Context<ApiEnv>): Response {
  return markEnvelope(c, envelopeFor(error, c));
}

function envelopeFor(error: Error, c: Context<ApiEnv>): Response {
  const requestId = requestIdOf(c);
  if (error instanceof AuthenticatedRequestUnexpectedError) {
    logUnexpected(c, requestId, error.cause);
    return internalFailureResponse(requestId);
  }
  if (error instanceof AuthenticatedRequestFailure) {
    return failureResponse({ ...error.failure, requestId });
  }
  if (isExpectedDomainFailure(error)) {
    return failureResponse({
      ...requestFailureFromDomain(error).failure,
      requestId,
    });
  }
  if (error instanceof HTTPException) {
    return httpExceptionResponse(error, requestId);
  }
  logUnexpected(c, requestId, error);
  return internalFailureResponse(requestId);
}

/** `app.notFound`: unknown paths are a JSON 404, never a missing-policy 500. */
export function apiNotFoundHandler(c: Context<ApiEnv>): Response {
  return markEnvelope(
    c,
    failureResponse({ ...COMMON_FAILURES.notFound, requestId: requestIdOf(c) }),
  );
}

/**
 * Rewrites any error response into the envelope: allowlisted fields only,
 * bounded issues/details, no provider text. 5xx bodies are always generic.
 */
export async function normalizeErrorResponse(
  response: Response,
  requestId: string,
): Promise<Response> {
  if (response.status < 400) return response;

  let payload: Record<string, unknown> = {};
  if (response.headers.get("content-type")?.includes("application/json")) {
    try {
      const parsed = await response.clone().json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed handler output is replaced by the bounded fallback below.
    }
  }

  const error =
    typeof payload.error === "string" ? payload.error.slice(0, 80) : "request_failed";
  const message =
    typeof payload.message === "string"
      ? payload.message.slice(0, 240)
      : "The request could not be completed.";
  const issues = Array.isArray(payload.issues)
    ? payload.issues.slice(0, 8).flatMap((issue) => {
        if (!issue || typeof issue !== "object") return [];
        const candidate = issue as Record<string, unknown>;
        if (
          typeof candidate.code !== "string" ||
          typeof candidate.message !== "string"
        ) {
          return [];
        }
        return [
          {
            path: Array.isArray(candidate.path)
              ? candidate.path
                  .filter(
                    (part): part is string | number =>
                      typeof part === "string" || typeof part === "number",
                  )
                  .slice(0, 5)
              : [],
            code: candidate.code.slice(0, 80),
            message: candidate.message.slice(0, 240),
          },
        ];
      })
    : undefined;
  const details = boundedExpectedDomainFailureDetails(payload.details);
  const retryAfterSeconds = boundedRetryAfter(payload.retryAfterSeconds);
  const body: ApiErrorBody =
    response.status >= 500
      ? { error: "internal_error", message: GENERIC_SERVER_MESSAGE, requestId }
      : {
          error,
          message,
          requestId,
          ...(issues ? { issues } : {}),
          ...(details ? { details } : {}),
          ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
        };
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("X-Request-ID", requestId);
  headers.set("Content-Type", "application/json; charset=UTF-8");
  if (retryAfterSeconds && response.status < 500) {
    headers.set("Retry-After", String(retryAfterSeconds));
  }
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Replaces the Hono response in place so literal route failures keep the request ID. */
export async function applyErrorResponse(
  context: { res: Response },
  requestId: string,
): Promise<Response> {
  const response = await normalizeErrorResponse(context.res, requestId);
  if (response !== context.res) context.res = response.clone();
  return response;
}

/** Mount on the first-party app only; MCP, REST and webhook adapters keep their own envelopes. */
export function errorEnvelopeMiddleware() {
  return async (c: Context<ApiEnv>, next: Next) => {
    await next();
    if (c.res.status >= 400 && !c.get("errorEnvelope")) {
      await applyErrorResponse(c, requestIdOf(c));
    }
  };
}
