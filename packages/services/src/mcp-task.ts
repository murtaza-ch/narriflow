import { randomUUID } from "node:crypto";
import { ExpectedDomainFailureError } from "./expected-domain-failure";

export const MCP_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MCP_TASK_POLL_INTERVAL_MS = 5000;
export type McpTaskStatus = "working" | "completed" | "failed" | "cancelled";
export type McpTaskDomain = "ingest" | "generation" | "export";
export interface McpTaskRecord {
  id: string; ownerUserId: string; callerId: string; workspaceId: string; toolName: string;
  domainKind: McpTaskDomain; domainId: string; projectId: string; clipId: string | null;
  originatingOperationId: string; resultContract: unknown; initialResult: unknown;
  status: McpTaskStatus; terminalOutcome: unknown | null;
  createdAt: Date; updatedAt: Date; expiresAt: Date; cancellationRequestedAt: Date | null;
}
export type McpTaskOwner = Pick<McpTaskRecord, "ownerUserId" | "callerId">;
export type McpTaskResolution = { status: "working" } | { status: "completed"; result: unknown } |
  { status: "cancelled" } | { status: "failed"; error: { code: number; message: string } };
export interface McpTaskPersistence {
  createOrRead(record: McpTaskRecord): Promise<McpTaskRecord>;
  read(id: string): Promise<McpTaskRecord | null>;
  settle(id: string, outcome: McpTaskResolution, at: Date): Promise<McpTaskRecord>;
  requestCancellation(id: string, at: Date): Promise<void>;
}

function missing(): never {
  throw new ExpectedDomainFailureError({ code: "mcp_task_not_found", kind: "missing", message: "This task is unavailable or has expired" });
}

/** Registry only. Existing domain workers execute and determine the real outcome. */
export function createMcpTaskRegistry(deps: {
  persistence: McpTaskPersistence;
  authorize(record: McpTaskRecord): Promise<void>;
  resolve(record: McpTaskRecord): Promise<McpTaskResolution>;
  cancel(record: McpTaskRecord): Promise<void>;
  beforeCancel?(record: McpTaskRecord): Promise<void>;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  async function owned(id: string, owner: McpTaskOwner) {
    const record = await deps.persistence.read(id);
    if (!record || record.expiresAt <= now() || record.ownerUserId !== owner.ownerUserId || record.callerId !== owner.callerId) missing();
    await deps.authorize(record);
    return record;
  }
  return {
    async register(input: Omit<McpTaskRecord, "id" | "status" | "terminalOutcome" | "createdAt" | "updatedAt" | "expiresAt" | "cancellationRequestedAt">) {
      const at = now();
      const record = await deps.persistence.createOrRead({ ...input, id: randomUUID(), status: "working", terminalOutcome: null,
        createdAt: at, updatedAt: at, expiresAt: new Date(at.getTime() + MCP_TASK_TTL_MS), cancellationRequestedAt: null });
      if (record.expiresAt <= at) throw new ExpectedDomainFailureError({ code: "mcp_task_expired", kind: "missing",
        message: "This task has expired; use the durable operation status" });
      return owned(record.id, input);
    },
    async get(id: string, owner: McpTaskOwner) {
      const record = await owned(id, owner);
      if (record.status !== "working") return record;
      const outcome = await deps.resolve(record);
      return outcome.status === "working" ? record : deps.persistence.settle(id, outcome, now());
    },
    async update(id: string, owner: McpTaskOwner) {
      // Current jobs have no outstanding input requests. Valid but obsolete
      // response keys are acknowledged without restarting or changing work.
      await owned(id, owner);
    },
    async cancel(id: string, owner: McpTaskOwner) {
      const record = await owned(id, owner);
      if (record.status !== "working") return;
      await deps.beforeCancel?.(record);
      await deps.persistence.requestCancellation(id, now());
      await deps.cancel(record);
      // An acknowledgement is not a cancelled outcome. Resolve the real domain
      // state on the next poll; cancellation can race completion or a claim.
    },
  };
}
