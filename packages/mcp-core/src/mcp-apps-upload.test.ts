import { describe, expect, test } from "bun:test";
import { waitForUploadAcceptance, notifyUploadAcceptance } from "./mcp-apps/v1/upload-progress";

describe("App Upload Session progress", () => {
  test("polls reconciliation until the existing session is accepted", async () => {
    const waits: number[] = [];
    let reads = 0;
    const queued = { _meta: { uploadTransfer: { outcome: "queued_for_ingest", sessionId: "same-session", projectId: "project" } } };
    const result = await waitForUploadAcceptance({ _meta: { uploadTransfer: { outcome: "reconciling", retryAfterSeconds: 1 } } }, {
      wait: async (delay) => { waits.push(delay); },
      readStatus: async () => ++reads === 1 ? { _meta: { uploadTransfer: { outcome: "reconciling", retryAfterSeconds: 10 } } } : queued,
    });
    expect(result).toBe(queued);
    expect(reads).toBe(2);
    expect(waits).toEqual([5_000, 10_000]);
  });
  test("bounds polling and preserves a retryable status if reconciliation continues", async () => {
    let reads = 0;
    const pending = { _meta: { uploadTransfer: { outcome: "reconciling", retryAfterSeconds: 300 } } };
    await expect(waitForUploadAcceptance(pending, { maximumPolls: 2, wait: async (delay) => { expect(delay).toBe(30_000); }, readStatus: async () => { reads++; return pending; } })).rejects.toThrow("still verifying");
    expect(reads).toBe(2);
  });
  test("shares accepted durable IDs with the host without private transfer fields", async () => {
    const messages: unknown[] = [];
    const accepted = { _meta: { uploadTransfer: { outcome: "queued_for_ingest", projectId: "project", queuedJobId: "job", sessionId: "private-session", grants: [{ url: "private-grant" }], storageKey: "private-storage" } } };
    expect(await notifyUploadAcceptance(accepted, { workspaceId: "workspace", clientIdempotencyKey: "private-key" }, "https://narriflow.test", {
      updateModelContext: async (message) => { messages.push(message); },
      sendMessage: async (message) => { messages.push(message); return {}; },
    })).toBe(true);
    expect(messages).toEqual([
      { content: [{ type: "text", text: JSON.stringify({ data: { status: "queued_for_ingest", workspaceId: "workspace", projectId: "project", ingestJobId: "job", statusTool: "narriflow_get_project", reviewUrl: "https://narriflow.test/projects/project" } }) }] },
      { role: "user", content: [{ type: "text", text: JSON.stringify({ data: { status: "queued_for_ingest", workspaceId: "workspace", projectId: "project", ingestJobId: "job", statusTool: "narriflow_get_project", reviewUrl: "https://narriflow.test/projects/project" } }) }] },
    ]);
    expect(JSON.stringify(messages)).not.toContain("private");
  });
  test("preserves accepted upload facts when the host cannot receive context", async () => {
    const result = { _meta: { uploadTransfer: { outcome: "queued_for_ingest", projectId: "project", queuedJobId: "job" } } };
    expect(await notifyUploadAcceptance(result, { workspaceId: "workspace" }, "https://narriflow.test", {})).toBe(false);
    expect(await notifyUploadAcceptance(result, { workspaceId: "workspace" }, "https://narriflow.test", { updateModelContext: async () => { throw new Error("Disconnected"); } })).toBe(false);
    expect(result._meta.uploadTransfer.projectId).toBe("project");
  });
});
