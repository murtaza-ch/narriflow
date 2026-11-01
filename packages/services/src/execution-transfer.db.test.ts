import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { createExecutorControl } from "./executor-control";
import type { ExecutorDomainControl } from "./executor-domain-control";
import { appendExecutionDispatch } from "./execution-dispatch";
import { createExecutionTransfer } from "./execution-transfer";
import { createExecutionStorage, ExecutionStorageError, type ExecutionStorageObject } from "./execution-storage";
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
  async function fixture(outputs: import("@narriflow/validators/execution-transfer").ExecutionOutputDescriptor[] = [{ role: "source_audio", contentType: "audio/webm", maxBytes: 10 * 1024 ** 3, bindingHash: "b".repeat(64) }], sourcePlan?: Pick<import("./execution-transfer").ExecutionPreparedPackage, "sources" | "initialSourceNames">, pinSource?: import("./execution-storage").ExecutionPinSource, startProcess = true) {
    const user = await db.user.create({ data: { clerkId: `transfer-gate:${crypto.randomUUID()}` } }); users.push(user.id);
    const workspace = await db.workspace.create({ data: { ownerUserId: user.id, name: "Transfer gate" } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, title: "Transfer gate", sourceMediaUrl: "r2://gate/source" } });
    const job = await db.ingestJob.create({ data: { projectId: project.id, jobType: "upload_finalize", payload: {} } });
    const epoch = await db.executionEpoch.findUniqueOrThrow({ where: { id: 1 } });
    const dispatch = await db.$transaction(tx => appendExecutionDispatch(tx, { deploymentEpoch: epoch.epoch, generation: 1, kind: "modal_execution", subject: { kind: "ingest_job", id: job.id }, inputHash: "a".repeat(64), dueAt: new Date() }));
    dispatches.push(dispatch.reference.dispatchId);
    const attemptToken = crypto.randomUUID(), owner = crypto.randomUUID();
    await db.executionAttempt.create({ data: { attemptToken, dispatchId: dispatch.reference.dispatchId, deploymentEpoch: epoch.epoch, generation: 1, inputHash: dispatch.reference.inputHash,
      functionName: pinSource ? "pin_source" : "fetch_source", operationDeadlineAt: new Date(Date.now() + 30 * 60_000) } });
    const control = createExecutorControl({ database: db, domain, subjectKind: "ingest_job" });
    const acquire = { action: "acquire", reference: dispatch.reference, attemptToken, owner, leaseSeconds: 120 };
    await control.execute({ command: acquire, verifiedRequest: await verified(acquire, "/api/execution/command") });
    const fence = { reference: dispatch.reference, attemptToken, owner };
    const start = { action: "process-start", fence };
    if (startProcess) await control.execute({ command: start, verifiedRequest: await verified(start, "/api/execution/command") });
    const provider = { creates: 0, grants: 0, completes: 0, aborts: 0, loseCompleteAck: false, sourceKeys: [] as string[], beforeGrant: undefined as (() => Promise<void>) | undefined, rangeGrants: 0, grantUrlLength: 0, grantExpiryForPart: undefined as ((number: number) => Date) | undefined, rangeExpiry: undefined as Date | undefined };
    let created: ExecutionStorageObject | null = null, sealed = false;
    const storage = {
      async findUnfinished() { return []; },
      async create(value: ExecutionStorageObject) { provider.creates++; created = value; return { ...value, uploadId: "public-upload", partSizeBytes: 16 * 1024 * 1024 }; },
      async signPart(_assignment: unknown, window: { partNumber: number; leaseExpiresAt: Date; operationDeadlineAt: Date }) {
        provider.grants++;
        await provider.beforeGrant?.();
        return { url: "https://private-storage.test/part?public-test-token=1".padEnd(provider.grantUrlLength, "x"), headers: {},
          expiresAt: provider.grantExpiryForPart?.(window.partNumber) ?? new Date(Math.min(Date.now() + 60_000, window.leaseExpiresAt.getTime(), window.operationDeadlineAt.getTime())) };
      },
      async listParts() { return [{ partNumber: 1, etag: '"01010101010101010101010101010101"', byteLength: 128, checksumMd5: md5 }]; },
      async complete() { provider.completes++; sealed = true; if (provider.loseCompleteAck) throw new ExecutionStorageError("storage_completion_unconfirmed"); return (await storage.head())!; },
      async head() { return sealed && created ? { key: created.storageKey, contentType: created.contentType, byteLength: created.byteLength, etag: '"sealed"' } : null; },
      async abort() { provider.aborts++; },
      async signInput(): Promise<never> { throw new Error("No object input in this fixture"); },
      async signSource(source: { storageKey: string }) {
        if (!sourcePlan) throw new Error("No source download in this fixture");
        provider.sourceKeys.push(source.storageKey);
        return { url: "https://private-storage.test/".padEnd(8192, "x"), headers: { "If-Match": '"source"' }, expiresAt: new Date(Date.now()+60_000) };
      },
      async signSourceRange(_assignment: unknown, frozen: import("./execution-storage").ExecutionPinSource, window: { start: number; end: number; leaseExpiresAt: Date; operationDeadlineAt: Date }) {
        if (!pinSource) throw new Error("No source pin in this fixture");
        provider.rangeGrants++;
        await provider.beforeGrant?.();
        return { url: "https://private-storage.test/range", headers: { "If-Match": frozen.etag, Range: `bytes=${window.start}-${window.end - 1}` },
          expiresAt: provider.rangeExpiry ?? new Date(Math.min(Date.now() + 60_000, window.leaseExpiresAt.getTime(), window.operationDeadlineAt.getTime())) };
      },
    };
    const transfer = createExecutionTransfer({ database: db, authority: control, storage, resolvePackage: async () => ({ input: { kind: "inline", command: { kind: "source", mediaId: "public" } }, sources: [], ...sourcePlan,
      outputs }), resolvePinSource: pinSource ? async (_row, authority, tx) => {
      // Reenter the already-held domain lock through the provided transaction.
      // A separate connection here would block behind this request's own lock.
      await tx.$queryRaw`SELECT "id" FROM "IngestJob" WHERE "id"=${authority.fence.reference.subject.id}::uuid FOR UPDATE`;
      return pinSource;
    } : undefined });
    const call = async (command: unknown, deliveryId?: string) => transfer.execute({ command, verifiedRequest: await verified(command, "/api/execution/transfer", deliveryId) });
    const work = await call({ action: "work-package", fence });
    if (work.disposition !== "work_package" || !work.outputs[0]) throw new Error("Expected assigned work package");
    return { fence, call, provider, control, artifactId: work.outputs[0].artifactId, job, work };
  }
  test("local work packages resolve and replay before charged start on one connection", async () => {
    const f = await fixture(undefined, undefined, undefined, false);
    const single = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 1 }, { schema: process.env.SERVERLESS_TEST_DATABASE_SCHEMA! }), transactionOptions: { maxWait: 1000, timeout: 3000 } });
    const storage = createExecutionStorage({ accountId: "a".repeat(32), bucket: "test", accessKeyId: "fixture", secretAccessKey: "fixture" });
    try {
      const control = createExecutorControl({ database: single, domain, subjectKind: "ingest_job" });
      const transfer = createExecutionTransfer({ database: single, authority: control, storage,
        resolvePackage: async () => { throw new Error("Local input must resolve in the live transaction"); },
        resolvePackageWithinAuthority: async (tx, authority, ref) => {
          expect(ref.id).toBe(f.job.id);
          // Reenter the held row lock on the exact same connection. Opening a
          // second authority/resolver transaction here would deadlock itself.
          await tx.$queryRaw`SELECT "id" FROM "IngestJob" WHERE "id"=${authority.fence.reference.subject.id}::uuid FOR UPDATE`;
          return { input: { kind: "inline", command: { kind: "local_fixture" } },
            sources: [{ name: "original", storageKey: "projects/frozen/source", etag: '"original"', byteLength: 1000 }],
            outputs: [{ role: "clip_preview", contentType: "video/mp4", maxBytes: 1024, bindingHash: "c".repeat(64) },
              { role: "preview_peaks", contentType: "application/json", maxBytes: 1024, bindingHash: "c".repeat(64) }] };
        } });
      const command = { action: "work-package", fence: f.fence }, deliveryId = crypto.randomUUID();
      const request = await verified(command, "/api/execution/transfer", deliveryId);
      const before = await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: f.fence.attemptToken } });
      const requests = [request, ...await Promise.all(Array.from({ length: 5 }, () => verified(command)))];
      const results = await Promise.all(requests.map(verifiedRequest => transfer.execute({ command, verifiedRequest })));
      expect(results.every(value => value.disposition === "work_package")).toBe(true);
      const first = results[0];
      if (first?.disposition !== "work_package") throw Error("Missing local package");
      expect(results.every(value => value.disposition === "work_package" && JSON.stringify(value.outputs) === JSON.stringify(first.outputs))).toBe(true);
      expect(first.sources[0]?.headers).toEqual({ "If-Match": '"original"' });
      expect(await db.executionArtifact.count({ where: { attemptToken: f.fence.attemptToken, role: { in: ["clip_preview", "preview_peaks"] } } })).toBe(2);
      expect((await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: f.fence.attemptToken } }))).toEqual(before);
      expect((await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).attemptCount).toBe(0);
      expect((await db.executionInboxReceipt.findUniqueOrThrow({ where: { audience_deliveryId: { audience: "executor-control", deliveryId } } })).disposition).toEqual({ disposition: "transfer_granted" });
      const changed = { ...command, fence: { ...f.fence, owner: crypto.randomUUID() } };
      await expect(transfer.execute({ command: changed, verifiedRequest: await verified(changed, "/api/execution/transfer", deliveryId) })).rejects.toMatchObject({ code: "replay_conflict" });
    } finally { storage.close(); await single.$disconnect(); }
  }, 30_000);
  test("expiry during local package signing rolls back assignments, cleanup and inbox together", async () => {
    const f = await fixture(undefined, undefined, undefined, false);
    await db.$executeRaw`UPDATE "ExecutionAttempt" SET "leaseExpiresAt"=(clock_timestamp() AT TIME ZONE 'UTC') + interval '2 seconds' WHERE "attemptToken"=${f.fence.attemptToken}::uuid`;
    const before = await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: f.fence.attemptToken } });
    const storage = createExecutionStorage({ accountId: "a".repeat(32), bucket: "test", accessKeyId: "fixture", secretAccessKey: "fixture" });
    const signSource = storage.signSource;
    let invalidExpiry = true;
    storage.signSource = async (...args) => {
      const value = await signSource(...args);
      if (invalidExpiry) return { ...value, expiresAt: new Date(before.operationDeadlineAt.getTime() + 1000) };
      await Bun.sleep(2100);
      return value;
    };
    try {
      const transfer = createExecutionTransfer({ database: db, authority: f.control, storage,
        resolvePackageWithinAuthority: async () => ({ input: { kind: "inline", command: {} },
          sources: [{ name: "original", storageKey: "projects/frozen/source", etag: '"original"', byteLength: 1000 }],
          outputs: [{ role: "clip_preview", contentType: "video/mp4", maxBytes: 1024, bindingHash: "c".repeat(64) }] }) });
      const command = { action: "work-package", fence: f.fence }, request = await verified(command);
      const cleanupBefore = await db.mediaCleanupObligation.count();
      await expect(transfer.execute({ command, verifiedRequest: request })).rejects.toMatchObject({ code: "storage_grant_expired" });
      invalidExpiry = false;
      await expect(transfer.execute({ command, verifiedRequest: request })).rejects.toMatchObject({ code: "authority_lost" });
      expect(await db.executionArtifact.count({ where: { attemptToken: f.fence.attemptToken, role: "clip_preview" } })).toBe(0);
      expect(await db.mediaCleanupObligation.count()).toBe(cleanupBefore);
      expect(await db.executionInboxReceipt.findUnique({ where: { audience_deliveryId: { audience: "executor-control", deliveryId: request.metadata.deliveryId } } })).toBeNull();
      expect(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: f.fence.attemptToken } })).toEqual(before);
      expect((await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).attemptCount).toBe(0);
    } finally { storage.close(); }
  }, 30_000);
  test("large frozen asset inventories fit the envelope with one initial grant and exact on-demand reads", async () => {
    const sources = Array.from({ length: 200 }, (_, index) => ({ name: `source_${index}`, storageKey: `projects/frozen/assets/${index}`, etag: '"source"', byteLength: 1000, sha256: "a".repeat(64) }));
    const f = await fixture(undefined, { sources, initialSourceNames: ["source_0"] });
    expect(f.work.sources.map(source => source.name)).toEqual(["source_0"]);
    expect(new TextEncoder().encode(JSON.stringify(f.work)).byteLength).toBeLessThan(64*1024);
    expect(f.provider.sourceKeys).toEqual([sources[0]!.storageKey]);
    const read = await f.call({ action: "source-read", fence: f.fence, sourceId: "source_199" });
    expect(read).toMatchObject({ disposition: "source_read", sourceId: "source_199", object: { storageKey: sources[199]!.storageKey, etag: '"source"', byteLength: 1000, sha256: "a".repeat(64) } });
    expect(f.provider.sourceKeys).toEqual([sources[0]!.storageKey,sources[199]!.storageKey]);
    await expect(f.call({ action: "source-read", fence: f.fence, sourceId: "foreign_source" })).rejects.toMatchObject({ code: "artifact_invalid" });
  });
  test("server-assigned previews and peaks preserve the one sibling-key storage contract", async () => {
    const f = await fixture([{ role: "clip_preview", contentType: "video/mp4", maxBytes: 512*1024**2, bindingHash: "b".repeat(64) },
      { role: "preview_peaks", contentType: "application/json", maxBytes: 256*1024, bindingHash: "b".repeat(64) }]);
    const preview = await db.executionArtifact.findUniqueOrThrow({ where: { id: f.work.outputs[0]!.artifactId } });
    const peaks = await db.executionArtifact.findUniqueOrThrow({ where: { id: f.work.outputs[1]!.artifactId } });
    expect(preview.storageKey).toEndWith(".mp4");
    expect(peaks.storageKey).toBe(preview.storageKey.slice(0,-4)+".peaks.json");
    expect(preview.storageKey).toStartWith(`execution/${f.fence.reference.deploymentEpoch}/${f.fence.attemptToken}/${f.fence.owner}/`);
    expect(f.work.outputs[0]).not.toHaveProperty("storageKey");
    const cleanup = await db.mediaCleanupObligation.findMany({ where: { objectKey: { in: [preview.storageKey, peaks.storageKey] }, origin: "assigned_execution_artifact" } });
    expect(cleanup).toHaveLength(2);
    const attempt = await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: f.fence.attemptToken } });
    expect(cleanup.every(row => row.nextAttemptAt.getTime() === attempt.operationDeadlineAt.getTime() + 120_000)).toBe(true);
    expect(f.provider.creates).toBe(0);
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
    const changed = { ...command, parts: [{ ...command.parts[0], checksumSha256: Buffer.alloc(32, 3).toString("base64") }] };
    await expect(f.call(changed, deliveryId)).rejects.toMatchObject({ code: "replay_conflict" });
    await expect(f.call(changed)).rejects.toMatchObject({ code: "artifact_invalid" });
    await db.executionAttempt.update({ where: { attemptToken: f.fence.attemptToken }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    await expect(f.call(command, deliveryId)).rejects.toMatchObject({code:"authority_lost"});
    await expect(f.call(command)).rejects.toMatchObject({ code: "authority_lost" });
    expect(f.provider).toMatchObject({ creates: 1, grants: 2 });
    expect((await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).attemptCount).toBe(1);
  }, 120_000);
  test("expiry during local signing returns no grant and rolls back the whole grant boundary", async () => {
    const f = await fixture(), base = { fence: f.fence, artifactId: f.artifactId };
    await f.call({ action: "upload-initialize", ...base, byteLength: 128, contentType: "audio/webm" });
    const before = await db.executionArtifact.findUniqueOrThrow({ where: { id: f.artifactId } });
    await db.$executeRaw`UPDATE "ExecutionAttempt" SET "leaseExpiresAt"=(clock_timestamp() AT TIME ZONE 'UTC') + interval '2 seconds' WHERE "attemptToken"=${f.fence.attemptToken}::uuid`;
    const lease = (await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: f.fence.attemptToken } })).leaseExpiresAt!;
    f.provider.beforeGrant = async () => {
      // Observe the real database clock; local signing is deliberately held
      // beyond the existing lease without mutating or extending its deadline.
      while (true) {
        const [clock] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
        if (clock!.now >= lease) return;
        await Bun.sleep(25);
      }
    };
    const command = { action: "upload-parts", ...base, parts: [{ partNumber: 1, byteLength: 128, checksumMd5: md5, checksumSha256: sha }] };
    const deliveryId = crypto.randomUUID();
    await expect(f.call(command, deliveryId)).rejects.toMatchObject({ code: "authority_lost" });
    expect(f.provider.grants).toBe(1);
    const after = await db.executionArtifact.findUniqueOrThrow({ where: { id: f.artifactId } });
    expect(after.multipartPartChecksums).toEqual(before.multipartPartChecksums);
    expect(after.grantExpiresAt).toEqual(before.grantExpiresAt);
    expect(await db.executionInboxReceipt.findUnique({ where: { audience_deliveryId: { audience: "executor-control", deliveryId } } })).toBeNull();
  }, 30_000);
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
  test("source-range uses the locked transaction and replays only while current", async () => {
    const frozen = { storageKey: "uploads/frozen/source", etag: '"frozen"', byteLength: 128 };
    const f = await fixture([{ role: "source_video", contentType: "video/mp4", maxBytes: 128, bindingHash: "b".repeat(64), sourceEtag: frozen.etag, sourceByteLength: frozen.byteLength }], undefined, frozen);
    const base = { fence: f.fence, artifactId: f.artifactId };
    await f.call({ action: "upload-initialize", ...base, byteLength: 128, contentType: "video/mp4" });
    const command = { action: "source-range", ...base, partNumber: 1 }, deliveryId = crypto.randomUUID();
    const result = await f.call(command, deliveryId);
    expect(result).toMatchObject({ disposition: "source_range", partNumber: 1, grant: { headers: { "If-Match": frozen.etag, Range: "bytes=0-127" } } });
    expect(await f.call(command, deliveryId)).toMatchObject({ disposition: "source_range" });
    await expect(f.call({ ...command, partNumber: 2 }, deliveryId)).rejects.toMatchObject({ code: "replay_conflict" });
    const receipt = await db.executionInboxReceipt.findUniqueOrThrow({ where: { audience_deliveryId: { audience: "executor-control", deliveryId } } });
    expect(receipt.disposition).toEqual({ disposition: "transfer_granted" });
    const assigned = await db.executionArtifact.findUniqueOrThrow({ where: { id: f.artifactId } });
    if (result.disposition !== "source_range") throw new Error("Expected range grant");
    expect(assigned.grantExpiresAt.getTime()).toBeGreaterThanOrEqual(Date.parse(result.grant.expiresAt));
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id"=1 FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "IngestJob" WHERE "id"=${f.job.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "attemptToken" FROM "ExecutionAttempt" WHERE "attemptToken"=${f.fence.attemptToken}::uuid FOR UPDATE`;
      await tx.ingestJob.update({ where: { id: f.job.id }, data: { status: "cancelled" } });
      await tx.executionAttempt.update({ where: { attemptToken: f.fence.attemptToken }, data: { status: "cancelled", revokedAt: new Date(), finishedAt: new Date() } });
    });
    await expect(f.call(command, deliveryId)).rejects.toMatchObject({ code: "authority_lost" });
    await expect(f.call(command)).rejects.toMatchObject({ code: "authority_lost" });
    expect(f.provider.rangeGrants).toBe(2);
    expect((await db.ingestJob.findUniqueOrThrow({ where: { id: f.job.id } })).attemptCount).toBe(1);
  }, 30_000);
  test("expiry during range signing rolls back without returning a URL", async () => {
    const frozen = { storageKey: "uploads/frozen/source", etag: '"frozen"', byteLength: 128 };
    const f = await fixture([{ role: "source_video", contentType: "video/mp4", maxBytes: 128, bindingHash: "b".repeat(64), sourceEtag: frozen.etag, sourceByteLength: frozen.byteLength }], undefined, frozen);
    const base = { fence: f.fence, artifactId: f.artifactId };
    await f.call({ action: "upload-initialize", ...base, byteLength: 128, contentType: "video/mp4" });
    const before = await db.executionArtifact.findUniqueOrThrow({ where: { id: f.artifactId } });
    // Cross the original lease while signing; no deadline is rewritten.
    await db.$executeRaw`UPDATE "ExecutionAttempt" SET "leaseExpiresAt"=(clock_timestamp() AT TIME ZONE 'UTC') + interval '2 seconds' WHERE "attemptToken"=${f.fence.attemptToken}::uuid`;
    const lease = (await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: f.fence.attemptToken } })).leaseExpiresAt!;
    f.provider.beforeGrant = async () => {
      while (true) {
        const [clock] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
        if (clock!.now >= lease) return;
        await Bun.sleep(25);
      }
    };
    const deliveryId = crypto.randomUUID();
    await expect(f.call({ action: "source-range", ...base, partNumber: 1 }, deliveryId)).rejects.toMatchObject({ code: "authority_lost" });
    expect(f.provider.rangeGrants).toBe(1);
    expect((await db.executionArtifact.findUniqueOrThrow({ where: { id: f.artifactId } })).grantExpiresAt).toEqual(before.grantExpiresAt);
    expect(await db.executionInboxReceipt.findUnique({ where: { audience_deliveryId: { audience: "executor-control", deliveryId } } })).toBeNull();
  }, 30_000);
  test("every grant must be live and remain inside its authoritative deadline", async () => {
    const f = await fixture(), base = { fence: f.fence, artifactId: f.artifactId }, bytes = 16 * 1024 ** 2;
    await f.call({ action: "upload-initialize", ...base, byteLength: 4 * bytes, contentType: "audio/webm" });
    f.provider.grantExpiryForPart = number => new Date(Date.now() + (number === 1 ? -1000 : 60_000));
    const command = { action: "upload-parts", ...base, parts: Array.from({ length: 4 }, (_, index) => ({ partNumber: index + 1, byteLength: bytes, checksumMd5: md5, checksumSha256: sha })) };
    await expect(f.call(command)).rejects.toMatchObject({ code: "storage_grant_expired" });
    expect((await db.executionArtifact.findUniqueOrThrow({ where: { id: f.artifactId } })).multipartPartChecksums).toEqual([]);
    const frozen = { storageKey: "uploads/frozen/source", etag: '"frozen"', byteLength: 128 };
    const pin = await fixture([{ role: "source_video", contentType: "video/mp4", maxBytes: 128, bindingHash: "b".repeat(64), sourceEtag: frozen.etag, sourceByteLength: frozen.byteLength }], undefined, frozen);
    const pinBase = { fence: pin.fence, artifactId: pin.artifactId };
    await pin.call({ action: "upload-initialize", ...pinBase, byteLength: 128, contentType: "video/mp4" });
    const attempt = await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: pin.fence.attemptToken } });
    pin.provider.rangeExpiry = new Date(attempt.operationDeadlineAt.getTime() + 1000);
    await expect(pin.call({ action: "source-range", ...pinBase, partNumber: 1 })).rejects.toMatchObject({ code: "storage_grant_expired" });
  }, 30_000);
  test("an inbox-blocked grant does not take domain locks ahead of ordinary commands", async () => {
    const f = await fixture(), base = { fence: f.fence, artifactId: f.artifactId };
    await f.call({ action: "upload-initialize", ...base, byteLength: 128, contentType: "audio/webm" });
    const deliveryId = crypto.randomUUID(), inboxKey = `executor-inbox:executor-control:${deliveryId}`;
    let unblock!: () => void, entered!: (pid: number) => void;
    const released = new Promise<void>(resolve => { unblock = resolve; });
    const held = new Promise<number>(resolve => { entered = resolve; });
    const blocker = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "epoch" FROM "ExecutionEpoch" WHERE "id"=1 FOR SHARE`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${inboxKey},0)) IS NULL AS "locked"`;
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS "pid"`;
      entered(backend!.pid);
      await released;
    });
    const pid = await held;
    const grant = f.call({ action: "upload-parts", ...base, parts: [{ partNumber: 1, byteLength: 128, checksumMd5: md5, checksumSha256: sha }] }, deliveryId);
    let ordinary: Promise<unknown> | undefined;
    try {
      const limit = Date.now() + 2000;
      while (true) {
        const [blocked] = await db.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}::int=ANY(pg_blocking_pids(pid))) AS "waiting"`;
        if (blocked!.waiting) break;
        if (Date.now() >= limit) throw new Error("Grant did not reach held inbox");
        await Bun.sleep(10);
      }
      const command = { action: "progress", fence: f.fence, phase: "uploading", progress: 1 };
      ordinary = f.control.execute({ command, verifiedRequest: await verified(command, "/api/execution/command") });
      const progressed = await Promise.race([ordinary.then(() => true), Bun.sleep(2000).then(() => false)]);
      expect(progressed).toBe(true);
    } finally {
      unblock();
      await blocker;
      await ordinary;
      await grant;
    }
    expect(f.provider.grants).toBe(1);
  }, 30_000);
  test("grant envelopes keep the64KiB boundary and never commit an oversized part plan", async () => {
    const f = await fixture(), base = { fence: f.fence, artifactId: f.artifactId }, bytes = 16 * 1024 ** 2;
    await f.call({ action: "upload-initialize", ...base, byteLength: 8 * bytes, contentType: "audio/webm" });
    f.provider.grantUrlLength = 8192;
    const deliveryId = crypto.randomUUID();
    await expect(f.call({ action: "upload-parts", ...base, parts: Array.from({ length: 8 }, (_, index) => ({ partNumber: index + 1, byteLength: bytes, checksumMd5: md5, checksumSha256: sha })) }, deliveryId)).rejects.toMatchObject({ code: "artifact_invalid" });
    expect((await db.executionArtifact.findUniqueOrThrow({ where: { id: f.artifactId } })).multipartPartChecksums).toEqual([]);
    expect(await db.executionInboxReceipt.findUnique({ where: { audience_deliveryId: { audience: "executor-control", deliveryId } } })).toBeNull();
  }, 30_000);
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
