import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import type { LocalFetchDeviceClaims } from "@narriflow/validators/api/local-fetch";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import { createLocalFetchDeviceExecution } from "./local-fetch-device-execution";

const workspaceId = crypto.randomUUID(), actorUserId = crypto.randomUUID();
const claims = { workspaceId, actorUserId, deploymentEpoch: 2 } as LocalFetchDeviceClaims;
const reference: ExecutionDispatchReference = { dispatchId: crypto.randomUUID(), kind: "local_fetch", subject: { kind: "ingest_job", id: crypto.randomUUID() }, deploymentEpoch: 2, generation: 4, inputHash: "a".repeat(64) };
function fixture() {
  const events: string[] = [];
  let databaseAccesses = 0;
  let selectedRows: { id: string }[] = [];
  let job: unknown = { project: { workspaceId }, generation: 4, jobType: "link_import", payload: { provider: "youtube" } };
  let actorAllowed = true;
  let replayFailure: Error | undefined;
  const records = new Map<string, { reference: ExecutionDispatchReference; acknowledgedAt: Date | null }>();
  const queries: { sql: string; values: unknown[] }[] = [];
  const database = {
    ingestJob: { findUnique: async () => { events.push("read-job"); return job; } },
    $queryRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ sql: sql.join("?"), values });
      events.push("query-finished");
      return selectedRows;
    },
    $transaction() { throw new Error("No transaction may cross mailbox delivery"); },
  } as unknown as PrismaClient;
  const service = createLocalFetchDeviceExecution({
    database: () => { databaseAccesses++; return database; },
    requireActor: async (scope) => {
      expect(scope).toEqual({ workspaceId, actorUserId });
      events.push("authorize-actor");
      if (!actorAllowed) throw new Error("actor_revoked");
    },
    delivery: {
      read: async (id) => { events.push(`read:${id}`); return records.get(id) ?? null; },
      replay: async (value) => { events.push(`replay:${value.dispatchId}`); const error = replayFailure; replayFailure = undefined; if (error) throw error; },
      deliver: async (id) => { events.push(`deliver:${id}`); },
    },
  });
  return { service, events, queries, records, databaseAccesses: () => databaseAccesses,
    job: (value: unknown) => { job = value; }, rows: (value: { id: string }[]) => { selectedRows = value; }, revoke: () => { actorAllowed = false; }, loseReplayAck: () => { replayFailure = new Error("ack_lost"); } };
}

describe("Local fetch device execution policy", () => {
  test("rejects wrong dispatch scope before resolving a database", async () => {
    const f = fixture();
    for (const value of [{ ...reference, kind: "modal_execution" as const }, { ...reference, deploymentEpoch: 1 }, { ...reference, subject: { kind: "workflow_run" as const, id: reference.subject.id } }]) {
      await expect(f.service.authorizeReference(claims, value)).rejects.toThrow("invalid_reference");
    }
    expect(f.databaseAccesses()).toBe(0);
  });
  test("only the current Workspace generation and YouTube intake reach current actor authorization", async () => {
    const f = fixture();
    for (const job of [null,
      { project: { workspaceId: crypto.randomUUID() }, generation: 4, jobType: "link_import", payload: { provider: "youtube" } },
      { project: { workspaceId }, generation: 3, jobType: "link_import", payload: { provider: "youtube" } },
      { project: { workspaceId }, generation: 4, jobType: "upload_finalize", payload: { provider: "youtube" } },
      { project: { workspaceId }, generation: 4, jobType: "link_import", payload: { provider: "rss" } },
    ]) {
      f.job(job);
      await expect(f.service.authorizeReference(claims, reference)).rejects.toThrow("invalid_reference");
    }
    expect(f.events).not.toContain("authorize-actor");
    f.job({ project: { workspaceId }, generation: 4, jobType: "link_import", payload: { provider: "youtube" } });
    await f.service.authorizeReference(claims, reference);
    f.revoke();
    await expect(f.service.authorizeReference(claims, reference)).rejects.toThrow("actor_revoked");
  });
  test("reconciliation preserves the bounded Workspace/epoch/cursor query and distinct replay paths", async () => {
    const f = fixture(), first = crypto.randomUUID(), second = crypto.randomUUID(), missing = crypto.randomUUID(), after = crypto.randomUUID();
    f.rows([{ id: first }, { id: second }, { id: missing }]);
    f.records.set(first, { reference: { ...reference, dispatchId: first }, acknowledgedAt: new Date() });
    f.records.set(second, { reference: { ...reference, dispatchId: second }, acknowledgedAt: null });
    expect(await f.service.reconcile(claims, after)).toEqual({ nextCursor: null });
    expect(f.events).toEqual(["authorize-actor", "query-finished", `read:${first}`, `replay:${first}`, `read:${second}`, `deliver:${second}`, `read:${missing}`]);
    expect(f.queries[0]!.values).toEqual([workspaceId, 2, after, after]);
    expect(f.queries[0]!.sql).toContain('dispatch.generation=job.generation');
    expect(f.queries[0]!.sql).toContain('job."deploymentEpoch"=dispatch."deploymentEpoch"');
    expect(f.queries[0]!.sql).toContain('ORDER BY dispatch.id LIMIT 25');
    f.rows(Array.from({ length: 25 }, (_, i) => ({ id: `row-${i}` })));
    expect(await f.service.reconcile(claims)).toEqual({ nextCursor: "row-24" });
  });
  test("revoked actors cannot enumerate or deliver and a lost delivery ACK replays the same reference", async () => {
    const f = fixture(); f.revoke();
    await expect(f.service.reconcile(claims)).rejects.toThrow("actor_revoked");
    expect(f.databaseAccesses()).toBe(0);
    expect(f.queries).toHaveLength(0);
    const again = fixture(); again.rows([{ id: reference.dispatchId }]);
    again.records.set(reference.dispatchId, { reference, acknowledgedAt: new Date() });
    again.loseReplayAck();
    await expect(again.service.reconcile(claims)).rejects.toThrow("ack_lost");
    await again.service.reconcile(claims);
    expect(again.events.filter(value => value.startsWith("replay:"))).toEqual([`replay:${reference.dispatchId}`, `replay:${reference.dispatchId}`]);
  });
});
