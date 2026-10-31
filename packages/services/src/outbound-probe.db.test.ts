import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { OutboundProbeService } from "./outbound-probe";
import { createExecutorControl } from "./executor-control";
import { readExecutionDispatch } from "./execution-dispatch";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const dbDescribe = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
dbDescribe("Frozen outbound RSS execution", () => {
  let db: PrismaClient;
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
    assertExecutionDatabaseTestTarget(url, schema);
    if (!schema.startsWith("serverless_execution_test_")) throw new Error("Outbound gates require a disposable schema");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }) });
  });
  afterAll(async () => { await db?.$disconnect(); });
  async function fixture() {
    const user = await db.user.create({ data: { clerkId: `outbound-gate:${crypto.randomUUID()}` } });
    const workspace = await db.workspace.create({ data: { name: "Outbound gate", ownerUserId: user.id, personalOwnerUserId: user.id } });
    const scope = { actorUserId: user.id, workspaceId: workspace.id };
    const dispatches: string[] = []; let reads = 0;
    const snapshot = { title: "Checked podcast", episodes: [{ id: "e", title: "Episode", enclosureUrl: "https://cdn.example/episode.mp3" }], finalUrl: "https://feed.example/podcast.xml", etag: '"feed1"', lastModified: null, notModified: false };
    const service = new OutboundProbeService(db, { register: async ids => { dispatches.push(...ids); }, readResult: async artifact => { reads++; expect(artifact.storageKey).toStartWith("execution/"); return snapshot; } });
    const input = { kind: "rss_feed" as const, url: "https://feed.example/podcast.xml?private=hidden", etag: null, lastModified: null };
    return { service, scope, dispatches, snapshot, reads: () => reads, input };
  }
  test("admission is pending and idempotent; only the started live owner may seal the private result", async () => {
    const f = await fixture();
    const first = await f.service.admit(f.scope, f.input, "intent1");
    expect(first.status).toBe("pending");
    expect((await f.service.admit(f.scope, f.input, "intent1")).jobId).toBe(first.jobId);
    expect((await f.service.get(f.scope, first.jobId)).result).toBeNull(); expect(f.reads()).toBe(0);
    const other = await fixture();
    await expect(f.service.get(other.scope, first.jobId)).rejects.toMatchObject({ code: "outbound_probe_missing" });
    await expect(f.service.admit(f.scope, { ...f.input, url: "http://127.0.0.1/secret" }, "bad")).rejects.toMatchObject({ code: "remote_url_unsafe" });
    const row = await db.outboundProbe.findUniqueOrThrow({ where: { id: first.jobId } });
    await expect((async () => await db.outboundProbe.update({ where: { id: row.id }, data: { input: { ...f.input, url: "http://10.0.0.1/" } } }))()).rejects.toThrow();
    const parent = (await readExecutionDispatch(db, f.dispatches[0]!))!.reference;
    const ready = await f.service.prepareExecution(parent);
    if (ready.kind !== "waiting") throw new Error("Expected waiting");
    const reference = ready.deadline.reference, attemptToken = ready.deadline.attemptToken, owner = crypto.randomUUID(), fence = { reference, attemptToken, owner };
    const control = createExecutorControl({ database: db, subjectKind: "outbound_probe", domain: f.service, deliverWakes: async () => {}, artifacts: {
      prepare: async (_assignment, artifact) => artifact,
      head: async () => ({ etag: '"sealed"', contentType: "application/json", byteLength: 512n, sha256: "a".repeat(64) }),
    } });
    const verified = () => ({ requestHash: crypto.randomUUID().replaceAll("-", "").repeat(2), metadata: { version: 1 as const, keyId: "outbound-gate", audience: "executor-control" as const, method: "POST" as const,
      canonicalTarget: "/api/execution/command", bodySha256: "0".repeat(64), timestamp: Math.floor(Date.now()/1000), deliveryId: crypto.randomUUID(), signature: "0".repeat(64) } });
    const execute = (command: unknown) => control.execute({ command, verifiedRequest: verified() });
    expect((await execute({ action: "acquire", reference, attemptToken, owner, leaseSeconds: 120 })).disposition).toBe("acquired");
    expect((await execute({ action: "acquire", reference, attemptToken, owner: crypto.randomUUID(), leaseSeconds: 120 })).disposition).toBe("busy");
    await execute({ action: "process-start", fence }); await execute({ action: "process-start", fence });
    expect((await db.outboundProbe.findUniqueOrThrow({ where: { id: row.id } })).chargedAttempts).toBe(1);
    const artifact = await db.executionArtifact.create({ data: { attemptToken, owner, role: "outbound_receipt", bindingHash: reference.inputHash,
      storageKey: `execution/${reference.deploymentEpoch}/${attemptToken}/${owner}/feed.json`, contentType: "application/json", maxBytes: 4194304n, grantExpiresAt: new Date(Date.now()+60000) } });
    const command = { action: "commit-artifact", fence, artifact: { artifactId: artifact.id, role: "outbound_receipt", bindingHash: reference.inputHash, contentType: "application/json", byteLength: 512, sha256: "a".repeat(64), etag: '"sealed"' } };
    const request = verified();
    await control.execute({ command, verifiedRequest: request });
    await control.execute({ command, verifiedRequest: request });
    const job = await f.service.get(f.scope, first.jobId);
    expect(job.status).toBe("ready"); expect(job.result).toEqual(f.snapshot); expect(f.reads()).toBe(1);
    const persisted = await db.outboundProbe.findUniqueOrThrow({ where: { id: row.id } });
    expect(persisted.resultStorageKey).toBe(artifact.storageKey); expect(persisted.executorOwner).toBeNull();
    expect((await f.service.workInput(row.id)).command).toEqual(f.input);
    expect((await f.service.prepareExecution(parent)).kind).toBe("terminal");
  });
  test("membership revocation cancels queued work before any external process starts", async () => {
    const f = await fixture();
    const member = await db.user.create({ data: { clerkId: `outbound-member:${crypto.randomUUID()}` } });
    await db.workspaceMember.create({ data: { workspaceId: f.scope.workspaceId, userId: member.id, role: "admin" } });
    const scope = { ...f.scope, actorUserId: member.id };
    const opened = await f.service.admit(scope, f.input, "member-intent");
    const reference = (await readExecutionDispatch(db, f.dispatches[0]!))!.reference;
    const planned = await f.service.prepareExecution(reference);
    if (planned.kind !== "waiting") throw new Error("Expected waiting");
    await db.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: scope.workspaceId, userId: member.id } } });
    const result = await db.$transaction(tx => f.service.lockExecution(tx, planned.deadline.reference, planned.deadline.attemptToken));
    expect(result.kind).toBe("terminal");
    expect((await db.outboundProbe.findUniqueOrThrow({ where: { id: opened.jobId } })).status).toBe("cancelled");
    expect((await db.outboundProbe.findUniqueOrThrow({ where: { id: opened.jobId } })).chargedAttempts).toBe(0);
  });
});
