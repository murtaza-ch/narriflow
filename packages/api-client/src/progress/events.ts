import { type ProgressRevokedControl, type WorkflowStageUpdatedEvent, progressSocketFrameSchema } from "@narriflow/validators/api/progress";

export type ProgressMessage =
  | { kind: "event"; event: WorkflowStageUpdatedEvent }
  | { kind: "revoked"; control: ProgressRevokedControl }
  | { kind: "reset"; cursor: number };

/** The transport rejects malformed frames before they can advance its cursor. */
export function decodeProgressMessage(input: unknown): ProgressMessage | null {
  const frame = progressSocketFrameSchema.parse(input);
  return frame.type === "event" ? { kind: "event", event: frame.event }
    : frame.type === "revoked" ? { kind: "revoked", control: frame.control }
    : frame.type === "reset" ? { kind: "reset", cursor: frame.cursor } : null;
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
