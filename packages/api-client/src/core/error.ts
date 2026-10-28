import {
  API_PLATFORM_ERROR_CODES,
  type ApiErrorBody,
  type ApiErrorIssue,
} from "@narriflow/validators/api/errors";

/** Codes produced by the client itself, never by the API. */
export const CLIENT_ERROR_CODES = {
  /** fetch failed before any HTTP response (offline, DNS, CORS, reset). */
  network: "network_error",
  /** The captured identity/Workspace stopped being current; the result was discarded. */
  scopeChanged: "scope_changed",
  /** A Workspace-scoped call was attempted with no selected Workspace. */
  workspaceSelectionRequired: "workspace_selection_required",
  /** A response claimed to be admitted for a different Workspace than requested. */
  workspaceResponseMismatch: "workspace_response_mismatch",
  /** A non-JSON or non-envelope failure body (proxy page, truncated reply). */
  unexpectedResponse: "unexpected_response",
  /** An event stream delivered no bytes, not even a heartbeat, for too long. */
  streamIdle: "stream_idle",
} as const;

export type ApiErrorCode = string;

export interface ApiErrorInit {
  code: ApiErrorCode;
  message: string;
  /** HTTP status, or 0 when no response was received. */
  status: number;
  requestId?: string | null;
  issues?: readonly ApiErrorIssue[];
  details?: Readonly<Record<string, unknown>>;
  retryAfterSeconds?: number;
  cause?: unknown;
}

/**
 * The one error type the client throws for a failed API call. Branch on `code`
 * (the envelope's `error` field), never on `message` text. `details` carries the
 * domain's safe recovery facts and is only as trustworthy as the server's DTO.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly requestId: string | null;
  readonly issues: readonly ApiErrorIssue[];
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(init: ApiErrorInit) {
    super(
      init.message,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = "ApiError";
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId ?? null;
    this.issues = init.issues ?? [];
    this.details = init.details;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function isApiErrorCode(error: unknown, code: ApiErrorCode): error is ApiError {
  return error instanceof ApiError && error.code === code;
}

export function scopeChangedError(): ApiError {
  return new ApiError({
    code: CLIENT_ERROR_CODES.scopeChanged,
    message: "The selected account or Workspace changed before this finished.",
    status: 0,
  });
}

const MAX_ERROR_BODY_CHARS = 64 * 1024;
const MAX_RETRY_AFTER_SECONDS = 86_400;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeIssues(value: unknown): ApiErrorIssue[] {
  if (!Array.isArray(value)) return [];
  const issues: ApiErrorIssue[] = [];
  for (const entry of value.slice(0, 8)) {
    if (!isPlainRecord(entry) || typeof entry.message !== "string") continue;
    const path = Array.isArray(entry.path)
      ? entry.path.filter(
          (part): part is string | number =>
            typeof part === "string" || typeof part === "number",
        )
      : [];
    issues.push({
      path,
      code: typeof entry.code === "string" ? entry.code : "invalid",
      message: entry.message,
    });
  }
  return issues;
}

/** `Retry-After` is delta-seconds or an HTTP date; anything else is ignored. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds > 0 ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS) : undefined;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  const seconds = Math.ceil((at - now) / 1000);
  return seconds > 0 ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS) : undefined;
}

/** Builds an ApiError from a failed response, mapping the error envelope's `error` to `code`. */
export async function apiErrorFromResponse(response: Response): Promise<ApiError> {
  const headerRequestId = response.headers.get("X-Request-ID");
  const headerRetryAfter = parseRetryAfter(response.headers.get("Retry-After"));
  let text = "";
  try {
    text = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
  } catch (cause) {
    return new ApiError({
      code: CLIENT_ERROR_CODES.unexpectedResponse,
      message: "The server response could not be read.",
      status: response.status,
      requestId: headerRequestId,
      retryAfterSeconds: headerRetryAfter,
      cause,
    });
  }
  let body: Partial<ApiErrorBody> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isPlainRecord(parsed) && typeof parsed.error === "string" && parsed.error) {
      body = parsed as Partial<ApiErrorBody>;
    }
  } catch {
    body = null;
  }
  if (!body || typeof body.error !== "string") {
    return new ApiError({
      code: CLIENT_ERROR_CODES.unexpectedResponse,
      message: `Unexpected response (${response.status}).`,
      status: response.status,
      requestId: headerRequestId,
      retryAfterSeconds: headerRetryAfter,
    });
  }
  const retryAfterSeconds =
    typeof body.retryAfterSeconds === "number" && body.retryAfterSeconds > 0
      ? Math.min(Math.ceil(body.retryAfterSeconds), MAX_RETRY_AFTER_SECONDS)
      : headerRetryAfter;
  return new ApiError({
    code: body.error,
    message: typeof body.message === "string" ? body.message : body.error,
    status: response.status,
    requestId: typeof body.requestId === "string" ? body.requestId : headerRequestId,
    issues: sanitizeIssues(body.issues),
    details: isPlainRecord(body.details) ? body.details : undefined,
    retryAfterSeconds,
  });
}

/**
 * What the UI should do about a failure. Gates and forms switch on `kind`
 * instead of re-deriving it from status codes; `workspace_restricted` is left
 * to the caller because owners go to billing and other members to the
 * Workspace-unavailable page.
 */
export type ApiFailureKind =
  | "authenticate"
  | "reselect_workspace"
  | "workspace_mismatch"
  | "workspace_restricted"
  | "forbidden"
  | "upgrade"
  | "missing"
  | "conflict"
  | "rate_limited"
  | "retry_later"
  | "validation"
  | "offline"
  | "superseded"
  | "failed";

export interface ApiFailure {
  kind: ApiFailureKind;
  error: ApiError;
  /** Seconds the server asked the user to wait, when it said so. */
  retryAfterSeconds?: number;
}

const CODES = API_PLATFORM_ERROR_CODES;

function failureKind(error: ApiError): ApiFailureKind {
  switch (error.code) {
    case CODES.authenticationRequired:
      return "authenticate";
    case CODES.workspaceSelectionChanged:
    case CLIENT_ERROR_CODES.workspaceSelectionRequired:
      return "reselect_workspace";
    case CODES.activeWorkspaceMismatch:
      return "workspace_mismatch";
    case CODES.workspaceRestricted:
      return "workspace_restricted";
    case CODES.capabilityDenied:
    case CODES.staffRequired:
      return "forbidden";
    case CODES.projectNotFound:
    case CODES.notFound:
      return "missing";
    case CODES.rateLimited:
      return "rate_limited";
    case CODES.mutationsUnavailable:
    case CODES.authenticationUnavailable:
      return "retry_later";
    case CLIENT_ERROR_CODES.network:
      return "offline";
    case CLIENT_ERROR_CODES.scopeChanged:
    case CLIENT_ERROR_CODES.workspaceResponseMismatch:
      return "superseded";
    default:
      break;
  }
  if (error.status === 401) return "authenticate";
  if (error.status === 402) return "upgrade";
  if (error.status === 404) return "missing";
  if (error.status === 403) return "forbidden";
  if (error.status === 409) return "conflict";
  if (error.status === 429) return "rate_limited";
  if (error.status === 503) return "retry_later";
  if (error.status === 400 || error.status === 422) return "validation";
  return "failed";
}

/** Classifies any thrown value; non-ApiError values are `failed` (wrapped, never swallowed). */
export function describeApiFailure(error: unknown): ApiFailure {
  const apiError = isApiError(error)
    ? error
    : new ApiError({
        code: CLIENT_ERROR_CODES.unexpectedResponse,
        message: error instanceof Error ? error.message : "Something went wrong.",
        status: 0,
        cause: error,
      });
  return {
    kind: failureKind(apiError),
    error: apiError,
    ...(apiError.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: apiError.retryAfterSeconds }),
  };
}

/** First validation message per field path (`a.b.0`), for inline form errors. */
export function fieldErrors(error: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!isApiError(error)) return result;
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (!(key in result)) result[key] = issue.message;
  }
  return result;
}
