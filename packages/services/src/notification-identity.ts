import { createHash } from "node:crypto";
import type { CompletionCallback, WebhookSubscription, WorkspaceEvent } from "@prisma/client";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const notificationInputHash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

export function completionCallbackExecutionInputHash(row: Pick<CompletionCallback, "id" | "workspaceId" | "operationKind" | "operationId" | "urlFingerprint" | "eventId" | "createdAt">) {
  return notificationInputHash(["completion-callback-v1", row.id, row.workspaceId, row.operationKind, row.operationId, row.urlFingerprint, row.eventId, row.createdAt.toISOString()]);
}

/** Cursor and retry changes do not alter this lifetime identity. */
export function webhookSubscriptionExecutionInputHash(row: Pick<WebhookSubscription, "id" | "workspaceId" | "urlFingerprint" | "types" | "createdAt">) {
  return notificationInputHash(["webhook-subscription-v1", row.id, row.workspaceId, row.urlFingerprint, row.types, row.createdAt.toISOString()]);
}

export function workspaceEventExecutionInputHash(row: Pick<WorkspaceEvent, "id" | "workspaceId" | "seq" | "type" | "version" | "subject" | "occurredAt">) {
  return notificationInputHash(["workspace-event-v1", row.id, row.workspaceId, row.seq.toString(), row.type, row.version, row.subject, row.occurredAt.toISOString()]);
}
