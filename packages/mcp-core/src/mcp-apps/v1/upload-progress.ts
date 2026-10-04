export interface UploadBridgeResult {
  isError?: boolean;
  _meta?: Record<string, unknown>;
}
function transfer(result: UploadBridgeResult) {
  const value = result._meta?.uploadTransfer;
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

type ContextMessage = { content: Array<{ type: "text"; text: string }> };

/** Publish only the durable public handoff facts to the conversation. The
 * private transfer object can also contain upload grants and storage details. */
export async function notifyUploadAcceptance(result: UploadBridgeResult, context: Record<string, unknown>, appOrigin: string, bridge: {
  updateModelContext?(message: ContextMessage): Promise<unknown>;
  sendMessage?(message: ContextMessage & { role: "user" }): Promise<{ isError?: boolean }>;
}) {
  const accepted = transfer(result);
  if (accepted.outcome !== "queued_for_ingest" || typeof accepted.projectId !== "string" || typeof accepted.queuedJobId !== "string" || typeof context.workspaceId !== "string") throw new Error("Upload completion did not include durable project identifiers");
  const facts = {
    status: "queued_for_ingest", workspaceId: context.workspaceId, projectId: accepted.projectId,
    ingestJobId: accepted.queuedJobId, statusTool: "narriflow_get_project",
    reviewUrl: `${appOrigin}/projects/${encodeURIComponent(accepted.projectId)}`,
  };
  const message: ContextMessage = { content: [{ type: "text", text: JSON.stringify({ data: facts }) }] };
  try {
    if (bridge.updateModelContext) await bridge.updateModelContext(message);
    if (bridge.sendMessage) return !(await bridge.sendMessage({ ...message, role: "user" })).isError;
    return Boolean(bridge.updateModelContext);
  } catch { return false; }
}

/** Poll the existing Upload Session; accepting the file is owned by its domain
 * service, including reconciliation after a lost storage response. */
export async function waitForUploadAcceptance<T extends UploadBridgeResult>(initial: T, options: {
  readStatus(): Promise<T>;
  wait?(milliseconds: number): Promise<void>;
  maximumPolls?: number;
}) {
  let result = initial;
  const wait = options.wait ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let polls = 0; transfer(result).outcome === "reconciling" && polls < (options.maximumPolls ?? 12); polls++) {
    const retryAfter = Number(transfer(result).retryAfterSeconds);
    await wait(Number.isFinite(retryAfter) ? Math.min(30_000, Math.max(5_000, retryAfter * 1_000)) : 5_000);
    result = await options.readStatus();
    if (result.isError) throw new Error("Upload status could not be read. Retry with the same file to resume.");
  }
  if (transfer(result).outcome !== "queued_for_ingest") throw new Error("Narriflow is still verifying this upload. Retry with the same file to resume, or open Narriflow for its status.");
  return result;
}
