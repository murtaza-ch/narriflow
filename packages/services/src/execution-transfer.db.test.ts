import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { createExecutorControl } from "./executor-control";
import type { ExecutorDomainControl } from "./executor-domain-control";
import { appendExecutionDispatch } from "./execution-dispatch";
import { createExecutionTransfer } from "./execution-transfer";
import { ExecutionStorageError, type ExecutionStorageObject } from "./execution-storage";
import { signExecutionRequest, verifyExecutionRequest } from "./execution-signature";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_EXECUTION_TRANSFER_DB_TESTS === "1" && url ? describe : describe.skip;
const md5 = Buffer.alloc(16, 1).toString("base64"), sha = Buffer.alloc(32, 2).toString("base64");
suite("Scoped executor transfer authority", () => {
  let db: PrismaClient;
  const users: string[] = [], dispatches: string[] = [], receipts: string[] = [];
  beforeAll(async () => {
    assertExecutionDatabaseTestTarget(url, process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public");
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
    if (schema !== "public" && !/^serverless_execution_test_[a-z0-9]+$/.test(schema)) throw new Error("Only disposable execution schemas are allowed");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 6 }, { schema }), transactionOptions: { timeout: 30_000, maxWait: 10_000 } });
    const [actual] = await db.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS "schema"`;
    if (actual?.schema !== schema) throw new Error("Wrong transfer schema");
  });
  afterAll(async () => {
    await db.executionInboxReceipt.deleteMany({ where: { deliveryId: { in: receipts } } });
    await db.executionArtifact.deleteMany({ where: { attempt: { dispatchId: { in: dispatches } } } });
    await db.executionAttempt.deleteMany({ where: { dispatchId: { in: dispatches } } });
    await db.executionDispatch.deleteMany({ where: { id: { in: dispatches } } });
    await db.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } }); await db.$disconnect();
  });
  const domain: ExecutorDomainControl<{ id: string }> = {
    async lockExecution(tx, reference) {
      await tx.$queryRaw`SELECT "id" FROM "IngestJob" WHERE "id"=${reference.subject.id}::uuid FOR UPDATE`;
      return { kind: "current", ref: { id: reference.subject.id } };
    },
    async acquireExecution() {}, async renewExecution() {},
    async startExecution(tx, ref) { await tx.ingestJob.update({ where: { id: ref.id }, data: { attemptCount: { increment: 1 } } }); },
    async commitArtifactExecution() { throw new Error("This seam tests storage facts before publication"); },
    async failExecution() {}, async releaseExecution() {}, async progressExecution() {},
  };
  async function verified(command: unknown, target = "/api/execution/transfer", deliveryId = crypto.randomUUID()) {
    receipts.push(deliveryId);
    const body = new TextEncoder().encode(JSON.stringify(command)), key = new Uint8Array(32).fill(7), timestamp = Math.floor(Date.now() / 1000);
    const signature = await signExecutionRequest({ keyId: "public", key, audience: "executor-control", method: "POST", target, body, timestamp, deliveryId });
    return verifyExecutionRequest({ signature, keyRing: new Map([["public", key]]), audience: "executor-control", method: "POST", target, body, nowSeconds: timestamp });
  }
  async function fixture(outputs: import("@narriflow/validators/execution-transfer").ExecutionOutputDescriptor[] = [{ role: "source_audio", contentType: "audio/webm", maxBytes: 10 * 1024 ** 3, bindingHash: "b".repeat(64) }]) {
    const user = await db.user.create({ data: { clerkId: `transfer-gate:${crypto.randomUUID()}` } }); users.push(user.id);
    const workspace = await db.workspace.create({ data: { ownerUserId: user.id, name: "Transfer gate" } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, title: "Transfer gate", sourceMediaUrl: "r2://gate/source" } });
    const job = await db.ingestJob.create({ data: { projectId: project.id, jobType: "upload_finalize", payload: {} } });
    const epoch = await db.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
    const dispatch = await db.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch.epoch, generation: 1, kind: "modal_execution", subject: { kind: "ingest_job", id: job.id }, inputHash: "a".repeat(64), dueAt: new Date() }));
    dispatches.push(dispatch.reference.dispatchId);
    const attemptToken = crypto.randomUUID(), owner = crypto.randomUUID();
    await db.executionAttempt.create({ data: { attemptToken, dispatchId: dispatch.reference.dispatchId, deploymentEpoch: epoch.epoch, generation: 1, inputHash: dispatch.reference.inputHash,
      functionName: "fetch_source", operationDeadlineAt: new Date(Date.now() + 30 * 60_000) } });
    const control = createExecutorControl({ database: db, domain, subjectKind: "ingest_job" });
    const acquire = { action: "acquire", reference: dispatch.reference, attemptToken, owner, leaseSeconds: 120 };
    await control.execute({ command: acquire, verifiedRequest: await verified(acquire, "/api/execution/command") });
    const fence = { reference: dispatch.reference, attemptToken, owner };
    const start = { action: "process-start", fence };
    await control.execute({ command: start, verifiedRequest: await verified(start, "/api/execution/command") });
    const provider = { creates: 0, grants: 0, completes: 0, aborts: 0, loseCompleteAck: false };
    let created: ExecutionStorageObject | null = null, sealed = false;
    const storage = {
      async findUnfinished() { return []; },
      async create(value: ExecutionStorageObject) { provider.creates++; created = value; return { ...value, uploadId: "public-upload", partSizeBytes: 16 * 1024 * 1024 }; },
      async signPart() { provider.grants++; return { url: "https://private-storage.test/part?public-test-token=1", headers: {}, expiresAt: new Date(Date.now() + 60_000) }; },
      async listParts() { return [{ partNumber: 1, etag: '"01010101010101010101010101010101"', byteLength: 128, checksumMd5: md5 }]; },
      async complete() { provider.completes++; sealed = true; if (provider.loseCompleteAck) throw new ExecutionStorageError("storage_completion_unconfirmed"); return (await storage.head())!; },
      async head() { return sealed && created ? { key: created.storageKey, contentType: created.contentType, byteLength: created.byteLength, etag: '"sealed"' } : null; },
      async abort() { provider.aborts++; },
      async signInput(): Promise<never> { throw new Error("No object input in this fixture"); },
      async signSource(): Promise<never> { throw new Error("No source download in this fixture"); },
      async signSourceRange(): Promise<never> { throw new Error("No source pin in this fixture"); },
    };
    const transfer = createExecutionTransfer({ database: db, authority: control, storage, resolvePackage: async () => ({ input: { kind: "inline", command: { kind: "source", mediaId: "public" } }, sources: [],
      outputs }) });
    const call = async (command: unknown, deliveryId?: string) => transfer.execute({ command, verifiedRequest: await verified(command, "/api/execution/transfer", deliveryId) });
    const work = await call({ action: "work-package", fence });
    if (work.disposition !== "work_package" || !work.outputs[0]) throw new Error("Expected assigned work package");
    return { fence, call, provider, artifactId: work.outputs[0].artifactId, job, work };
  }
  test("server-assigned previews and peaks preserve the one sibling-key storage contract", async () => {
    const f = await fixture([{ role: "clip_preview", contentType: "video/mp4", maxBytes: 512*1024**2, bindingHash: "b".repeat(64) },
      { role: "preview_peaks", contentType: "application/json", maxBytes: 256*1024, bindingHash: "b".repeat(64) }]);
    const preview = await db.executionArtifact.findUniqueOrThrow({ where: { id: f.work.outputs[0]!.artifactId } });
    const peaks = await db.executionArtifact.findUniqueOrThrow({ where: { id: f.work.outputs[1]!.artifactId } });
    expect(preview.storageKey).toEndWith(".mp4");
    expect(peaks.storageKey).toBe(preview.storageKey.slice(0,-4)+".peaks.json");
    expect(preview.storageKey).toStartWith(`execution/${f.fence.reference.deploymentEpoch}/${f.fence.attemptToken}/${f.fence.owner}/`);
    expect(f.work.outputs[0]).not.toHaveProperty("storageKey");
    const replay = await f.call({ action: "work-package", fence: f.fence });
    expect(replay).toMatchObject({ outputs: f.work.outputs });
    expect(await db.executionArtifact.count({ where: { attemptToken: f.fence.attemptToken } })).toBe(2);
  });
  test("reissues grants only with fresh authority and stores no scoped URL in the inbox", async () => {
    const f = await fixture(), base = { fence: f.fence, artifactId: f.artifactId };
    await f.call({ action: "upload-initialize", ...base, byteLength: 128, contentType: "audio/webm" });
    const command = { action: "upload-parts", ...base, parts: [{ partNumber: 1, byteLength: 128, checksumMd5: md5, checksumSha256: sha }] };
    const deliveryId = crypto.randomUUID();
    await f.call(command, deliveryId);
    await f.call(command, deliveryId);
    const receipt = await db.executionInboxReceipt.findUniqueOrThrow({where:{audience_deliveryId:{audience:"executor-control",deliveryId}}});
    expect(JSON.stringify(receipt.disposition)).not.toContain("private-storage.test");
    expect(JSON.stringify(receipt.disposition)).not.toContain("public-test-token");
    await expect(f.call({ ...command, parts: [{ ...command.parts[0], checksumSha256: Buffer.alloc(32, 3).toString("base64") }] })).rejects.toMatchObject({ code: "artifact_invalid" });
    await db.executionAttempt.update({ where: { attemptToken: f.fence.attemptToken }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    await expect(f.call(command, deliveryId)).rejects.toMatchObject({code:"authority_lost"});
    await expect(f.call(command)).rejects.toMatchObject({ code: "authority_lost" });
    expect(f.provider).toMatchObject({ creates: 1, grants: 2 });
    expect((await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).attemptCount).toBe(1);
  }, 120_000);
  test("a lost grant acknowledgment cannot regrant after owner revocation",async()=>{
    const f=await fixture(),base={fence:f.fence,artifactId:f.artifactId};
    await f.call({action:"upload-initialize",...base,byteLength:128,contentType:"audio/webm"});
    const command={action:"upload-parts",...base,parts:[{partNumber:1,byteLength:128,checksumMd5:md5,checksumSha256:sha}]},deliveryId=crypto.randomUUID();
    // The response is deliberately discarded, as after a receiver-side ACK loss.
    await f.call(command,deliveryId);
    await db.executionAttempt.update({where:{attemptToken:f.fence.attemptToken},data:{revokedAt:new Date()}});
    await expect(f.call(command,deliveryId)).rejects.toMatchObject({code:"authority_lost"});
    await expect(f.call(command)).rejects.toMatchObject({code:"authority_lost"});
    expect(f.provider).toMatchObject({creates:1,grants:1});
    const receipt=await db.executionInboxReceipt.findUniqueOrThrow({where:{audience_deliveryId:{audience:"executor-control",deliveryId}}});
    expect(receipt.disposition).toEqual({disposition:"transfer_granted"});
  },120000);
  test("uncertain completion recovers sealed facts, and abort cannot replace completion intent", async () => {
    const f = await fixture(), base = { fence: f.fence, artifactId: f.artifactId };
    await f.call({ action: "upload-initialize", ...base, byteLength: 128, contentType: "audio/webm" });
    await f.call({ action: "upload-parts", ...base, parts: [{ partNumber: 1, byteLength: 128, checksumMd5: md5, checksumSha256: sha }] });
    f.provider.loseCompleteAck = true;
    const command = { action: "upload-complete", ...base, byteLength: 128, sha256: "c".repeat(64) }, deliveryId = crypto.randomUUID();
    const result = await f.call(command, deliveryId);
    expect(result.disposition).toBe("upload_completed");
    expect(await f.call(command, deliveryId)).toEqual(result);
    expect(f.provider.completes).toBe(1);
    await expect(f.call({ action: "upload-abort", ...base })).rejects.toMatchObject({ code: "storage_completion_unconfirmed" });
    expect(f.provider.aborts).toBe(0);
    expect(await db.executionArtifact.findUniqueOrThrow({ where: { id: f.artifactId } })).toMatchObject({ checksumSha256: "c".repeat(64), etag: '"sealed"', byteLength: 128n, committedAt: null });
  }, 120_000);
  test("a recorded abort permanently closes this output and exact replay never repeats provider abort", async () => {
    const f = await fixture(), base = { fence: f.fence, artifactId: f.artifactId };
    await f.call({ action: "upload-initialize", ...base, byteLength: 128, contentType: "audio/webm" });
    const command = { action: "upload-abort", ...base }, deliveryId = crypto.randomUUID();
    const result = await f.call(command, deliveryId);
    expect(result.disposition).toBe("upload_aborted");
    expect(await f.call(command, deliveryId)).toEqual(result);
    expect(f.provider.aborts).toBe(1);
    await expect(f.call({ action: "upload-initialize", ...base, byteLength: 128, contentType: "audio/webm" })).rejects.toMatchObject({ code: "artifact_invalid" });
    await expect(f.call({ action: "upload-complete", ...base, byteLength: 128, sha256: "c".repeat(64) })).rejects.toMatchObject({ code: "artifact_invalid" });
    expect(f.provider.completes).toBe(0);
  }, 120_000);
});
