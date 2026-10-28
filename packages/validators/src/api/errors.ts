import { z } from "zod";

/** Bounded validation issue exposed to API clients. */
export const apiErrorIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])).max(5),
  code: z.string().max(80),
  message: z.string().max(240),
});
export type ApiErrorIssue = z.infer<typeof apiErrorIssueSchema>;

/**
 * The one ordinary JSON error body. `error` is the stable code clients branch
 * on; `message` is safe display text. MCP JSON-RPC and OAuth endpoints keep
 * their protocol-mandated envelopes instead.
 */
export const apiErrorBodySchema = z.object({
  error: z.string().min(1),
  message: z.string(),
  requestId: z.string().min(1),
  issues: z.array(apiErrorIssueSchema).max(8).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  retryAfterSeconds: z.number().int().positive().max(86_400).optional(),
});
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

/** Platform-level codes every route can return. Domain codes stay with their domain. */
export const API_PLATFORM_ERROR_CODES = {
  authenticationRequired: "authentication_required",
  authenticationUnavailable: "authentication_unavailable",
  workspaceSelectionChanged: "workspace_selection_changed",
  activeWorkspaceMismatch: "active_workspace_mismatch",
  capabilityDenied: "capability_denied",
  workspaceRestricted: "workspace_restricted",
  staffRequired: "staff_required",
  projectNotFound: "project_not_found",
  notFound: "not_found",
  invalidInput: "invalid_input",
  invalidJson: "invalid_json",
  unsupportedMediaType: "unsupported_media_type",
  payloadTooLarge: "payload_too_large",
  uriTooLong: "uri_too_long",
  headersTooLarge: "request_headers_too_large",
  originNotAllowed: "origin_not_allowed",
  idempotencyKeyRequired: "idempotency_key_required",
  idempotencyKeyMismatch: "idempotency_key_mismatch",
  rateLimited: "rate_limited",
  mutationsUnavailable: "mutations_unavailable",
  credentialAlreadyIssued: "credential_already_issued",
  requestPolicyMissing: "request_policy_missing",
  serverDraining: "server_draining",
  internalError: "internal_error",
} as const;
export type ApiPlatformErrorCode =
  (typeof API_PLATFORM_ERROR_CODES)[keyof typeof API_PLATFORM_ERROR_CODES];
