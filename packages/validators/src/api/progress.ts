import { z } from "zod";
import { workflowStageUpdatedEventSchema } from "../workflow";

export { type WorkflowStageUpdatedEvent, workflowStageUpdatedEventSchema } from "../workflow";

/**
 * The control event sent at most once, immediately before the server closes a
 * stream whose access ended (session expiry, removed membership, restriction,
 * Project gone). `error` is the stable failure code; nothing else is exposed.
 */
export const progressRevokedControlSchema = z.object({
  error: z.string().min(1).max(120),
  requestId: z.string().min(1).max(120).optional(),
});
export type ProgressRevokedControl = z.infer<typeof progressRevokedControlSchema>;

/** A workflow sequence is a non-negative safe integer; anything else is not a cursor. */
export function normalizeWorkflowSeq(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** `?sinceSeq=`: a malformed, negative or unsafe value replays from the start rather than failing the stream. */
export function parseSinceSeq(value: string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  return normalizeWorkflowSeq(Number(value)) ?? 0;
}

/** True when `value` is a valid sequence strictly after `cursor`. */
export function isAfterWorkflowCursor(cursor: number, value: unknown): boolean {
  const sequence = normalizeWorkflowSeq(value);
  return sequence !== null && sequence > cursor;
}

/** The larger of `cursor` and a valid `value`. */
export function advanceWorkflowCursor(cursor: number, value: unknown): number {
  const sequence = normalizeWorkflowSeq(value);
  return sequence !== null && sequence > cursor ? sequence : cursor;
}

export const PROGRESS_CONNECT_TICKET_MS = 30_000;
export const PROGRESS_SUBSCRIPTION_MAX_MS = 60_000;
export const PROGRESS_REPLAY_LIMIT = 500;
export const PROGRESS_FRAME_MAX_BYTES = 64 * 1024;

export const progressTicketPayloadSchema = z.strictObject({
  version: z.literal(1),
  actorUserId: z.string().min(1).max(120),
  workspaceId: z.string().min(1).max(120),
  projectId: z.string().uuid(),
  origin: z.string().url().max(300),
  audience: z.string().url().max(300),
  nonce: z.string().regex(/^[a-f0-9]{32}$/),
  authorizedAt: z.number().int().safe().nonnegative(),
  ticketExpiresAt: z.number().int().safe().nonnegative(),
  subscriptionExpiresAt: z.number().int().safe().nonnegative(),
}).refine((value) => value.ticketExpiresAt > value.authorizedAt && value.ticketExpiresAt <= value.authorizedAt + PROGRESS_CONNECT_TICKET_MS &&
  value.subscriptionExpiresAt >= value.ticketExpiresAt && value.subscriptionExpiresAt <= value.authorizedAt + PROGRESS_SUBSCRIPTION_MAX_MS);
export type ProgressTicketPayload = z.infer<typeof progressTicketPayloadSchema>;
export const progressTicketResponseSchema = z.strictObject({
  ticket: z.string().min(1).max(4_096),
  ticketExpiresAt: z.number().int().safe(),
  subscriptionExpiresAt: z.number().int().safe(),
});
export type ProgressTicketResponse = z.infer<typeof progressTicketResponseSchema>;

export const progressSocketFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("connected"), projectId: z.string().uuid(), cursor: z.number().int().nonnegative().safe() }),
  z.strictObject({ type: z.literal("event"), event: workflowStageUpdatedEventSchema }),
  z.strictObject({ type: z.literal("revoked"), control: progressRevokedControlSchema }),
  z.strictObject({ type: z.literal("reset"), cursor: z.number().int().nonnegative().safe() }),
  z.strictObject({ type: z.literal("resync") }),
]);
export type ProgressSocketFrame = z.infer<typeof progressSocketFrameSchema>;
