import {
  PROGRESS_STREAM_EVENTS,
  type ProgressRevokedControl,
  type WorkflowStageUpdatedEvent,
  progressRevokedControlSchema,
  workflowStageUpdatedEventSchema,
} from "@narriflow/validators/api/progress";
import type { StreamMessage } from "../core";

/** What the hub does with a frame; heartbeats, `connected` and unknown events decode to `null`. */
export type ProgressMessage =
  | { kind: "event"; event: WorkflowStageUpdatedEvent }
  | { kind: "revoked"; control: ProgressRevokedControl };

/** Used when a revoke control is present but unreadable: access is gone either way. */
const UNREADABLE_REVOKE: ProgressRevokedControl = { error: "authorization_revoked" };

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/**
 * Validates a frame against the wire schema. An event that fails validation is
 * skipped (a later valid event moves the cursor past it) rather than forcing a
 * reconnect loop on a frame that would fail identically every time.
 */
export function decodeProgressMessage(message: StreamMessage): ProgressMessage | null {
  if (message.event === PROGRESS_STREAM_EVENTS.workflow) {
    const parsed = workflowStageUpdatedEventSchema.safeParse(parseJson(message.data));
    if (parsed.success) return { kind: "event", event: parsed.data };
    console.warn(JSON.stringify({ level: "error", message: "workflow_event_invalid" }));
    return null;
  }
  if (message.event === PROGRESS_STREAM_EVENTS.revoked) {
    const parsed = progressRevokedControlSchema.safeParse(parseJson(message.data));
    return { kind: "revoked", control: parsed.success ? parsed.data : UNREADABLE_REVOKE };
  }
  return null;
}

/** Terminal statuses end a stage's run: they refresh everything the run produced. */
export function isTerminalProgress(event: Pick<WorkflowStageUpdatedEvent, "status">): boolean {
  return event.status === "completed" || event.status === "partial" || event.status === "failed";
}

/** One terminal outcome of one run or ingest job; the key to refresh it once. */
export function terminalProgressIdentity(
  event: Pick<WorkflowStageUpdatedEvent, "workflowRunId" | "ingestJobId" | "seq">,
): string {
  return `${event.ingestJobId ?? event.workflowRunId}:${event.seq}`;
}
