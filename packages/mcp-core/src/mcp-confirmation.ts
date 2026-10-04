import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ExpectedDomainFailureError } from "@narriflow/services";
import { mcpPrepareSocialPostSchema, mcpUploadVideoSchema } from "@narriflow/validators";
import * as z from "zod/v4";
import type { NarriflowMcpPrincipal } from "./mcp-tool-admission";

export type McpPrepareSocialPostInput = z.infer<typeof mcpPrepareSocialPostSchema>;
export function mcpCallerId(principal: NarriflowMcpPrincipal) {
  return principal.kind === "api_key" ? `api_key:${principal.apiKeyId}:${principal.userId}` : `oauth:${principal.clientId}:${principal.userId}`;
}
type ClockAndSecret = { secret?: string; now?: number; allowExpired?: boolean };
const confirmationSchema = z.strictObject({ version: z.literal(1), stage: z.enum(["prepared", "approved"]), callerId: z.string().max(512), actorUserId: z.string().uuid(), workspaceId: z.string().uuid(), tool: z.literal("narriflow_schedule_social_post"), digest: z.string().regex(/^[a-f0-9]{64}$/), expiresAtMs: z.number().int(), intent: mcpPrepareSocialPostSchema });
type ConfirmationState = z.infer<typeof confirmationSchema>;
function fail(code: string, kind: "invalid" | "forbidden" | "conflict" | "unavailable", message: string): never {
  throw new ExpectedDomainFailureError({ code, kind, message });
}
function secret(options: ClockAndSecret) {
  const value = options.secret ?? process.env.MCP_CONTINUATION_SECRET;
  if (!value || Buffer.byteLength(value) < 32) fail("mcp_confirmation_unavailable", "unavailable", "Publication confirmation is not configured");
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).filter(([, item]) => item !== undefined).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(intent: McpPrepareSocialPostInput) { return createHash("sha256").update(canonical(intent)).digest("hex"); }
function seal(state: ConfirmationState, options: ClockAndSecret) {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const mac = createHmac("sha256", secret(options)).update(`narriflow.mcp.publication.v1:${payload}`).digest("base64url");
  return `${payload}.${mac}`;
}
function open(token: string, options: ClockAndSecret) {
  if (token.length > 32_768) fail("mcp_confirmation_invalid", "invalid", "Publication confirmation is invalid");
  const [payload, suppliedMac, extra] = token.split(".");
  if (!payload || !suppliedMac || extra) fail("mcp_confirmation_invalid", "invalid", "Publication confirmation is invalid");
  const expectedMac = createHmac("sha256", secret(options)).update(`narriflow.mcp.publication.v1:${payload}`).digest();
  const actualMac = Buffer.from(suppliedMac, "base64url");
  if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) fail("mcp_confirmation_invalid", "invalid", "Publication confirmation is invalid");
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { fail("mcp_confirmation_invalid", "invalid", "Publication confirmation is invalid"); }
  const parsed = confirmationSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.digest !== digest(parsed.data.intent) || parsed.data.workspaceId !== parsed.data.intent.workspaceId) fail("mcp_confirmation_invalid", "invalid", "Publication confirmation is invalid");
  if (!options.allowExpired && (options.now ?? Date.now()) >= parsed.data.expiresAtMs) fail("mcp_confirmation_expired", "conflict", "Publication confirmation expired. Prepare this post again with a new request key.");
  return parsed.data;
}
export function createMcpConfirmation(principal: NarriflowMcpPrincipal, input: z.input<typeof mcpPrepareSocialPostSchema>, options: ClockAndSecret = {}) {
  const intent = mcpPrepareSocialPostSchema.parse(input);
  const expiresAtMs = (options.now ?? Date.now()) + 600_000;
  const state: ConfirmationState = { version: 1, stage: "prepared", callerId: mcpCallerId(principal), actorUserId: principal.userId, workspaceId: intent.workspaceId, tool: "narriflow_schedule_social_post", digest: digest(intent), expiresAtMs, intent };
  return { token: seal(state, options), expiresAt: new Date(expiresAtMs).toISOString() };
}
export function verifyMcpPreparation(token: string, options: ClockAndSecret & { principal?: NarriflowMcpPrincipal; actorUserId?: string; workspaceId?: string; clientIdempotencyKey?: string } = {}) {
  const state = open(token, options);
  if (state.stage !== "prepared") fail("mcp_confirmation_invalid", "invalid", "A publication preparation is required");
  if (options.principal && state.callerId !== mcpCallerId(options.principal) || options.actorUserId && state.actorUserId !== options.actorUserId || options.workspaceId && state.workspaceId !== options.workspaceId || options.clientIdempotencyKey && state.intent.clientIdempotencyKey !== options.clientIdempotencyKey) fail("mcp_confirmation_binding_mismatch", "forbidden", "This publication confirmation belongs to another caller or request");
  return state;
}
/** Called only by authenticated confirmation adapters after an explicit user action. */
export function acceptMcpConfirmation(token: string, options: ClockAndSecret & { actorUserId: string; accepted: boolean }) {
  const state = verifyMcpPreparation(token, { ...options, allowExpired: false });
  if (options.accepted !== true) fail("mcp_confirmation_declined", "conflict", "The publication was not confirmed");
  return seal({ ...state, stage: "approved" }, options);
}
export function verifyMcpConfirmation(token: string, receipt: string, principal: NarriflowMcpPrincipal, workspaceId: string, clientIdempotencyKey: string, options: ClockAndSecret = {}) {
  const state = verifyMcpPreparation(token, { ...options, principal, workspaceId, clientIdempotencyKey });
  const approved = open(receipt, options);
  if (approved.stage !== "approved" || approved.digest !== state.digest || approved.callerId !== state.callerId || approved.expiresAtMs !== state.expiresAtMs || approved.workspaceId !== state.workspaceId) fail("mcp_confirmation_required", "forbidden", "Confirm this exact publication before scheduling it");
  return state;
}

const uploadHandoffSchema = z.strictObject({ version: z.literal(1), actorUserId: z.string().uuid(), callerId: z.string().max(512), workspaceId: z.string().uuid(), tool: z.literal("narriflow_upload_video"), expiresAtMs: z.number().int(), intent: mcpUploadVideoSchema });
export function createMcpUploadHandoff(principal: NarriflowMcpPrincipal, input: z.input<typeof mcpUploadVideoSchema>, options: ClockAndSecret = {}) {
  const intent = mcpUploadVideoSchema.parse(input);
  const expiresAtMs = (options.now ?? Date.now()) + 600_000;
  const state = { version: 1, actorUserId: principal.userId, callerId: mcpCallerId(principal), workspaceId: intent.workspaceId, tool: "narriflow_upload_video", expiresAtMs, intent };
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const mac = createHmac("sha256", secret(options)).update(`narriflow.mcp.upload.v1:${payload}`).digest("base64url");
  return { token: `${payload}.${mac}`, expiresAt: new Date(expiresAtMs).toISOString() };
}
export function verifyMcpUploadHandoff(token: string, options: ClockAndSecret & { actorUserId?: string; workspaceId?: string; principal?: NarriflowMcpPrincipal; allowAcceptedTransfer?: boolean } = {}) {
  if (token.length > 32_768) fail("mcp_upload_handoff_invalid", "invalid", "The upload handoff is invalid");
  const [payload, suppliedMac, extra] = token.split(".");
  if (!payload || !suppliedMac || extra) fail("mcp_upload_handoff_invalid", "invalid", "The upload handoff is invalid");
  const expected = createHmac("sha256", secret(options)).update(`narriflow.mcp.upload.v1:${payload}`).digest();
  const actual = Buffer.from(suppliedMac, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail("mcp_upload_handoff_invalid", "invalid", "The upload handoff is invalid");
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { fail("mcp_upload_handoff_invalid", "invalid", "The upload handoff is invalid"); }
  const parsed = uploadHandoffSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.workspaceId !== parsed.data.intent.workspaceId) fail("mcp_upload_handoff_invalid", "invalid", "The upload handoff is invalid");
  if (!options.allowAcceptedTransfer && (options.now ?? Date.now()) >= parsed.data.expiresAtMs) fail("mcp_upload_handoff_expired", "conflict", "The upload handoff expired. Open the upload tool again to continue.");
  if (options.actorUserId && options.actorUserId !== parsed.data.actorUserId || options.workspaceId && options.workspaceId !== parsed.data.workspaceId || options.principal && mcpCallerId(options.principal) !== parsed.data.callerId) fail("mcp_upload_handoff_binding_mismatch", "forbidden", "This upload handoff belongs to another caller or workspace");
  return parsed.data;
}
