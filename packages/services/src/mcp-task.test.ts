import { expect, test } from "bun:test";
import { createMcpTaskRegistry, MCP_TASK_TTL_MS, type McpTaskRecord, type McpTaskPersistence, type McpTaskResolution } from "./mcp-task";

function harness() {
  const rows = new Map<string, McpTaskRecord>();
  let time = new Date("2026-10-05T00:00:00Z");
  let outcome: McpTaskResolution = { status: "working" };
  let cancellations = 0;
  let admitted = true;
  const persistence: McpTaskPersistence = {
    createOrRead: async (record) => { const existing = [...rows.values()].find((row) => row.domainId === record.domainId); if (existing) return existing; rows.set(record.id, record); return record; },
    read: async (id) => rows.get(id) ?? null,
    settle: async (id, settled, at) => { const row = rows.get(id)!; if (row.status === "working") { row.status = settled.status; row.terminalOutcome = settled; row.updatedAt = at; } return row; },
    requestCancellation: async (id, at) => { rows.get(id)!.cancellationRequestedAt = at; },
  };
  const registry = createMcpTaskRegistry({ persistence, now: () => time,
    authorize: async () => { if (!admitted) throw new Error("Membership removed"); },
    resolve: async () => outcome, cancel: async () => { cancellations++; },
  });
  const owner = { ownerUserId: "user", callerId: "oauth:client:user" };
  const input = { ...owner, workspaceId: "workspace", toolName: "submit", domainKind: "ingest" as const, domainId: "job", projectId: "project", clipId: null,
    originatingOperationId: "request", initialResult: { operationId: "job", status: "accepted" }, resultContract: { version: 1 } };
  return { registry, input, owner, setOutcome: (value: McpTaskResolution) => { outcome = value; }, advance: (ms: number) => { time = new Date(time.getTime() + ms); },
    revoke: () => { admitted = false; }, cancellations: () => cancellations };
}

test("reconnects retain task identity and terminal outcomes are immutable", async () => {
  const h = harness(); const created = await h.registry.register(h.input);
  expect((await h.registry.register(h.input)).id).toBe(created.id);
  h.setOutcome({ status: "completed", result: { clips: ["clip-1"] } });
  expect((await h.registry.get(created.id, h.owner)).terminalOutcome).toEqual({ status: "completed", result: { clips: ["clip-1"] } });
  h.setOutcome({ status: "failed", error: { code: -1, message: "Late worker error" } });
  expect((await h.registry.get(created.id, h.owner)).status).toBe("completed");
  await h.registry.cancel(created.id, h.owner); expect(h.cancellations()).toBe(0);
  h.revoke(); await expect(h.registry.get(created.id, h.owner)).rejects.toThrow("Membership removed");
});
test("task ownership and seven-day expiry cannot cancel domain work", async () => {
  const h = harness(); const created = await h.registry.register(h.input);
  await expect(h.registry.get(created.id, { ...h.owner, callerId: "oauth:other:user" })).rejects.toMatchObject({ code: "mcp_task_not_found" });
  h.advance(MCP_TASK_TTL_MS);
  await expect(h.registry.get(created.id, h.owner)).rejects.toMatchObject({ code: "mcp_task_not_found" });
  await expect(h.registry.register(h.input)).rejects.toMatchObject({ code: "mcp_task_expired" });
  expect(h.cancellations()).toBe(0);
});
test("cancel acknowledgement does not claim cancellation when completion wins", async () => {
  const h = harness(); const created = await h.registry.register(h.input);
  await h.registry.cancel(created.id, h.owner);
  expect((await h.registry.get(created.id, h.owner)).status).toBe("working");
  h.setOutcome({ status: "completed", result: { done: true } });
  expect((await h.registry.get(created.id, h.owner)).status).toBe("completed");
});
