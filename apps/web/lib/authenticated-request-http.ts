import type {
  ExpectedDomainFailure,
  ExpectedDomainFailureKind,
} from "@narriflow/services";
import {
  AuthenticatedRequestFailure,
  type AuthenticatedRequestFailureCategory,
  type AuthenticatedRequestFailureValue,
} from "./authenticated-request-policy";

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

export function authenticatedRequestDomainFailure(
  failure: ExpectedDomainFailure,
): AuthenticatedRequestFailure {
  const transport = DOMAIN_FAILURE_HTTP[failure.kind];
  return new AuthenticatedRequestFailure({
    code: failure.code,
    category: transport.category,
    status: transport.status,
    message: failure.message,
    ...(failure.details ? { details: failure.details } : {}),
    ...(failure.retryAfterSeconds
      ? { retryAfterSeconds: failure.retryAfterSeconds }
      : {}),
  });
}

export function authenticatedRequestHttpFailure(
  failure: AuthenticatedRequestFailureValue,
) {
  return {
    body: {
      error: failure.code,
      message: failure.message,
      requestId: failure.requestId,
      ...(failure.issues ? { issues: failure.issues } : {}),
      ...(failure.details ? { details: failure.details } : {}),
      ...(failure.retryAfterSeconds
        ? { retryAfterSeconds: failure.retryAfterSeconds }
        : {}),
    },
    status: failure.status,
    retryAfterSeconds: failure.retryAfterSeconds,
  };
}

export async function normalizeAuthenticatedErrorResponse(
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
    typeof payload.error === "string" ? payload.error : "request_failed";
  const message =
    typeof payload.message === "string"
      ? payload.message.slice(0, 240)
      : "The request could not be completed.";
  const issues = Array.isArray(payload.issues)
    ? payload.issues
        .slice(0, 8)
        .flatMap((issue) => {
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
  const details = boundedHttpDetails(payload.details);
  const retryAfterSeconds =
    typeof payload.retryAfterSeconds === "number" &&
    Number.isFinite(payload.retryAfterSeconds) &&
    payload.retryAfterSeconds > 0
      ? Math.min(86_400, Math.ceil(payload.retryAfterSeconds))
      : undefined;
  const body =
    response.status >= 500
      ? {
          error: "internal_error",
          message: "Something went wrong. Try again or contact support.",
          requestId,
        }
      : {
          error,
          message,
          requestId,
          ...(issues ? { issues } : {}),
          ...(details ? { details } : {}),
          ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
        };
  const headers = new Headers(response.headers);
  headers.set("X-Request-ID", requestId);
  headers.set("Content-Type", "application/json; charset=UTF-8");
  if (retryAfterSeconds) headers.set("Retry-After", String(retryAfterSeconds));
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function applyAuthenticatedErrorResponse(
  context: { res: Response },
  requestId: string,
): Promise<Response> {
  const response = await normalizeAuthenticatedErrorResponse(
    context.res,
    requestId,
  );
  if (response !== context.res) context.res = response.clone();
  return response;
}

function boundedHttpDetail(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 240);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 4) return undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, 16)
      .flatMap((item) => {
        const bounded = boundedHttpDetail(item, depth + 1);
        return bounded === undefined ? [] : [bounded];
      });
  }
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 16)
      .flatMap(([key, item]) => {
        const bounded = boundedHttpDetail(item, depth + 1);
        return bounded === undefined ? [] : [[key, bounded]];
      }),
  );
}

function boundedHttpDetails(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return boundedHttpDetail(value, 0) as Record<string, unknown>;
}
