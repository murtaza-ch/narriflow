import type { AuthenticatedRequestFailureValue } from "./authenticated-request-policy";

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
  if (!response.headers.get("content-type")?.includes("application/json")) {
    return response;
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await response.clone().json()) as Record<string, unknown>;
  } catch {
    return response;
  }

  const error =
    typeof payload.error === "string" ? payload.error : "request_failed";
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
  const body =
    response.status >= 500
      ? {
          error: "internal_error",
          message: "Something went wrong. Try again or contact support.",
          requestId,
        }
      : {
          ...payload,
          error,
          ...(issues ? { issues } : {}),
          requestId,
        };
  const headers = new Headers(response.headers);
  headers.set("X-Request-ID", requestId);
  headers.set("Content-Type", "application/json; charset=UTF-8");
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
