import { z } from "zod";

export { type WorkflowStageUpdatedEvent, workflowStageUpdatedEventSchema } from "../workflow";

// Wire protocol of `GET /api/stream/:projectId` (Server-Sent Events).

/** SSE event names. Anything else on the wire (heartbeat comments aside) is ignored by clients. */
export const PROGRESS_STREAM_EVENTS = {
  connected: "connected",
  workflow: "workflow.stage.updated",
  ping: "ping",
  revoked: "authorization.revoked",
} as const;

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

/** The first frame of every connection. */
export const progressConnectedSchema = z.object({
  projectId: z.string(),
  sinceSeq: z.number().int().nonnegative(),
  ts: z.string(),
});
export type ProgressConnected = z.infer<typeof progressConnectedSchema>;

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
