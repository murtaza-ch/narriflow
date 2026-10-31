import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { createLibraryIndex, queueLibraryIndex } from "./library-index";
import { readExecutionDispatch } from "./execution-dispatch";
import { takeExecutionDispatchIds } from "./execution-dispatch-runtime";
import { LIBRARY_EMBEDDING_DIMENSIONS, LIBRARY_EMBEDDING_MODEL, EmbeddingProviderError } from "./openai-embedding-provider";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Targeted library indexing", () => {
  let db: PrismaClient;
  const users: string[] = [], workspaces: string[] = [], transcripts: string[] = [];
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
    assertExecutionDatabaseTestTarget(url, schema);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 5 }, { schema }), transactionOptions: { timeout: 30_000, maxWait: 10_000 } });
  });
  afterEach(async () => {
    await db.executionDispatch.deleteMany({ where: { subjectKind: "library_index", subjectId: { in: transcripts } } });
    await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    users.length = workspaces.length = transcripts.length = 0;
  });
  afterAll(async () => { await db.$disconnect(); });
  async function fixture() {
    const user = await db.user.create({ data: { clerkId: `library-driver:${crypto.randomUUID()}` } }); users.push(user.id);
    const workspace = await db.workspace.create({ data: { name: "Index gate", ownerUserId: user.id } }); workspaces.push(workspace.id);
    const project = await db.project.create({ data: { workspaceId: workspace.id, title: "Index gate", sourceMediaUrl: "https://example.test/media.mp4" } });
    const transcript = await db.transcript.create({ data: { projectId: project.id, status: "completed", completedAt: new Date(), utterancesJson:
      ["First paid passage", "Second paid passage", "Third paid passage"].map((text, index) => ({ text, startSec: index * 40, endSec: index * 40 + 35 })) } });
    transcripts.push(transcript.id);
    const reference = await db.$transaction(tx => queueLibraryIndex(tx, transcript.id));
    if (!reference) throw Error("Expected index obligation");
    return { transcript, reference };
  }
  const vector = () => Array.from({ length: LIBRARY_EMBEDDING_DIMENSIONS }, (_, index) => index === 0 ? 1 : 0);
  async function current(id: string) {
    const row = await db.executionDispatch.findFirstOrThrow({ where: { subjectKind: "library_index", subjectId: id, wakeKind: null, deadlineKind: null }, orderBy: { generation: "desc" } });
    return (await readExecutionDispatch(db, row.id))!.reference;
  }
  test("indexing freezes an obligation atomically and registration precedes one owned bounded batch", async () => {
    const value = await fixture(); let calls = 0, registrations = 0;
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const driver = createLibraryIndex({ database: db, batch: { maxInputs: 1, maxEstimatedTokens: 1000 }, register: async ids => { expect(ids.length).toBeGreaterThan(0); registrations++; },
      embeddings: { configured: true, model: LIBRARY_EMBEDDING_MODEL, embed: async texts => { calls++; expect(registrations).toBeGreaterThan(0); expect(texts).toHaveLength(1); entered(); await barrier; return { vectors: texts.map(vector), tokens: 10 }; } } });
    const first = driver.run(value.reference); await started;
    expect((await driver.run(value.reference)).kind).toBe("wait"); expect(calls).toBe(1);
    release(); expect((await first).kind).toBe("complete");
    const row = await db.transcript.findUniqueOrThrow({ where: { id: value.transcript.id } });
    expect(row).toMatchObject({ passagesClaimId: null, passagesLeaseUntil: null, passagesIndexedFor: null, passagesAttempts: 0 });
    expect(await db.transcriptPassage.count({ where: { transcriptId: row.id } })).toBe(1);
    expect((await current(row.id)).generation).toBeGreaterThan(value.reference.generation);
    expect((await driver.run(value.reference)).kind).toBe("superseded");
    const generation = row.passagesGeneration;
    await expect(db.$transaction(async tx => { await tx.transcript.update({ where: { id: row.id }, data: { completedAt: new Date(Date.now()+1000) } }); await queueLibraryIndex(tx, row.id); throw Error("injected_index_rollback"); })).rejects.toThrow("injected_index_rollback");
    expect((await db.transcript.findUniqueOrThrow({ where: { id: row.id } })).passagesGeneration).toBe(generation);
  });
  test("an unconfirmed watchdog grants no provider request and no consumed attempt", async () => {
    const value = await fixture(); let calls = 0;
    const driver = createLibraryIndex({ database: db, register: async () => { throw Error("registration_failed"); }, embeddings: { configured: true, model: LIBRARY_EMBEDDING_MODEL, embed: async () => { calls++; return { vectors: [], tokens: 0 }; } } });
    await expect(driver.run(value.reference)).rejects.toThrow("registration_failed");
    expect(calls).toBe(0);
    expect(await db.transcript.findUniqueOrThrow({ where: { id: value.transcript.id } })).toMatchObject({ passagesClaimId: null, passagesLeaseUntil: null, passagesAttempts: 0 });
  });
  test("a changed transcript fences an in-flight paid response before passage publication", async () => {
    const value = await fixture(); let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    const driver = createLibraryIndex({ database: db, register: async () => {}, embeddings: { configured: true, model: LIBRARY_EMBEDDING_MODEL, embed: async texts => { entered(); await barrier; return { vectors: texts.map(vector), tokens: 10 }; } } });
    const pending = driver.run(value.reference); await started;
    const fresh = await db.$transaction(async tx => { await tx.transcript.update({ where: { id: value.transcript.id }, data: { completedAt: new Date(Date.now()+1000), utterancesJson: [{ text: "Replaced", startSec: 0, endSec: 35 }] } }); return queueLibraryIndex(tx, value.transcript.id); });
    expect(fresh!.generation).toBeGreaterThan(value.reference.generation); release();
    expect((await pending).kind).toBe("superseded");
    expect(await db.transcriptPassage.count({ where: { transcriptId: value.transcript.id } })).toBe(0);
  });
  test("a failed later batch retains paid passages and targeted retries embed only the remainder", async () => {
    const value = await fixture(); let calls = 0; const paid: string[] = [];
    const driver = createLibraryIndex({ database: db, retryBaseMs: 0, batch: { maxInputs: 1, maxEstimatedTokens: 1000 }, register: async () => {},
      embeddings: { configured: true, model: LIBRARY_EMBEDDING_MODEL, embed: async texts => { calls++; if (calls === 2) throw new EmbeddingProviderError("embedding_request_failed", { status: 429 }); paid.push(...texts); return { vectors: texts.map(vector), tokens: 10 }; } } });
    await driver.run(value.reference); expect((await driver.run(await current(value.transcript.id))).kind).toBe("retry");
    expect(await db.transcriptPassage.count({ where: { transcriptId: value.transcript.id } })).toBe(1);
    await driver.run(await current(value.transcript.id)); await driver.run(await current(value.transcript.id));
    expect(paid).toEqual(["First paid passage", "Second paid passage", "Third paid passage"]);
    expect(await db.transcript.findUniqueOrThrow({ where: { id: value.transcript.id } })).toMatchObject({ passagesIndexedFor: value.transcript.completedAt, passagesClaimId: null, passagesLeaseUntil: null, passagesRetryAt: null, passagesAttempts: 0 });
  });
  test("a revised transcript reuses unchanged paid passages and removes obsolete ones only on completion", async () => {
    const value = await fixture(); const paid: string[] = [];
    const driver = createLibraryIndex({ database: db, register: async () => {}, embeddings: { configured: true, model: LIBRARY_EMBEDDING_MODEL,
      embed: async texts => { paid.push(...texts); return { vectors: texts.map(vector), tokens: texts.length*10 }; } } });
    await driver.run(value.reference); paid.length = 0;
    const reference = await db.$transaction(async tx => {
      await tx.transcript.update({ where: { id: value.transcript.id }, data: { completedAt: new Date(Date.now()+1000), utterancesJson:
        [{ text: "First paid passage", startSec: 0, endSec: 35 }, { text: "Revised second passage", startSec: 40, endSec: 75 }] } });
      return queueLibraryIndex(tx, value.transcript.id);
    });
    await driver.run(reference!); expect(paid).toEqual(["Revised second passage"]);
    expect(await db.transcriptPassage.count({ where: { transcriptId: value.transcript.id } })).toBe(2);
  });
  test("repeated provider failure exhausts a finite budget and unchanged receipt replays spend nothing", async () => {
    const value = await fixture(); let calls = 0;
    const driver = createLibraryIndex({ database: db, register: async () => {}, retryBaseMs: 0, embeddings: { configured: true, model: LIBRARY_EMBEDDING_MODEL,
      embed: async () => { calls++; throw new EmbeddingProviderError("embedding_bad_response"); } } });
    for (let index = 0; index < 8; index++) await driver.run(await current(value.transcript.id));
    expect(calls).toBe(8);
    expect(await db.transcript.findUniqueOrThrow({ where: { id: value.transcript.id } })).toMatchObject({ passagesAttempts: 8, passagesRetryAt: null, passagesClaimId: null, passagesIndexError: "embedding_bad_response" });
    expect(await db.$transaction(tx => queueLibraryIndex(tx,value.transcript.id))).toBeNull();
    await driver.run(await current(value.transcript.id)); expect(calls).toBe(8);
  });
  test("silent transcripts finish once without provider work, and inaccessible or unfinished transcripts are refused", async () => {
    const value = await fixture(); let calls = 0;
    const reference = await db.$transaction(async tx => { await tx.transcript.update({ where: { id: value.transcript.id }, data: { utterancesJson: [] } }); return queueLibraryIndex(tx,value.transcript.id); });
    const driver = createLibraryIndex({ database: db, register: async () => {}, embeddings: { configured: true, model: LIBRARY_EMBEDDING_MODEL,
      embed: async () => { calls++; throw Error("No speech"); } } });
    expect((await driver.run(reference!)).kind).toBe("complete"); expect(calls).toBe(0);
    expect((await db.transcript.findUniqueOrThrow({ where: { id: value.transcript.id } })).passagesIndexedFor).toEqual(value.transcript.completedAt);
    expect(await db.$transaction(tx => queueLibraryIndex(tx,value.transcript.id))).toBeNull();
    await db.project.update({ where: { id: value.transcript.projectId }, data: { purgeStartedAt: new Date() } });
    expect(await db.$transaction(tx => queueLibraryIndex(tx,value.transcript.id))).toBeNull();
    expect((await driver.run(reference!)).kind).toBe("superseded");
    await db.project.update({ where: { id: value.transcript.projectId }, data: { purgeStartedAt: null } });
    await db.transcript.update({ where: { id: value.transcript.id }, data: { status: "processing" } });
    expect(await db.$transaction(tx => queueLibraryIndex(tx,value.transcript.id))).toBeNull();
  });
  test("missing provider configuration records a typed refusal without a paid attempt", async () => {
    const value = await fixture();
    const driver = createLibraryIndex({ database: db, register: async () => { throw Error("No native work"); }, embeddings: { configured: false, model: LIBRARY_EMBEDDING_MODEL,
      embed: async () => { throw Error("No provider configured"); } } });
    expect((await driver.run(value.reference)).kind).toBe("complete");
    expect(await db.transcript.findUniqueOrThrow({ where: { id: value.transcript.id } })).toMatchObject({ passagesIndexError: "embedding_not_configured", passagesAttempts: 0, passagesRetryAt: null, passagesClaimId: null });
  });
  test("a lost continuation acknowledgement is repaired by replaying the old reference without another embedding request", async () => {
    const value = await fixture(); let calls = 0; const registrations: string[][] = [];
    const driver = createLibraryIndex({ database: db, batch: { maxInputs: 1, maxEstimatedTokens: 1000 }, register: async ids => {
      registrations.push([...ids]); if (registrations.length === 2) throw Error("lost_continuation_ack");
    }, embeddings: { configured: true, model: LIBRARY_EMBEDDING_MODEL, embed: async texts => { calls++; return { vectors: texts.map(vector), tokens: 10 }; } } });
    await expect(driver.run(value.reference)).rejects.toThrow("lost_continuation_ack");
    const next = await current(value.transcript.id);
    expect((await driver.run(value.reference)).kind).toBe("superseded");
    expect(calls).toBe(1); expect(registrations).toHaveLength(3); expect(registrations.at(-1)).toEqual([next.dispatchId]);
  });
  test("restore rebinds metadata without collecting product dispatch or changing paid budget and retry time", async () => {
    const value=await fixture(),retryAt=new Date(Date.now()+60_000);
    await db.transcript.update({where:{id:value.transcript.id},data:{passagesAttempts:2,passagesRetryAt:retryAt,passagesClaimId:crypto.randomUUID(),passagesLeaseUntil:new Date(Date.now()+30_000)}});
    const before=await db.transcript.findUniqueOrThrow({where:{id:value.transcript.id}}),count=await db.executionDispatch.count({where:{subjectId:value.transcript.id}});
    await expect(db.$transaction(tx=>queueLibraryIndex(tx,value.transcript.id,{deferDispatch:true}))).rejects.toThrow("library_restore_requires_closed_admission");
    await expect(db.$transaction(async tx=>{
      const epoch=await tx.executionEpoch.update({where:{id:1},data:{epoch:{increment:1},admissionOpen:false}});
      expect(await queueLibraryIndex(tx,value.transcript.id,{deferDispatch:true})).toBeNull();
      expect(takeExecutionDispatchIds(tx)).toEqual([]);
      expect(await tx.executionDispatch.count({where:{subjectId:value.transcript.id}})).toBe(count);
      expect(await tx.transcript.findUniqueOrThrow({where:{id:value.transcript.id}})).toMatchObject({passagesEpoch:epoch.epoch,passagesGeneration:before.passagesGeneration+1,
        passagesAttempts:2,passagesDeadlineAt:before.passagesDeadlineAt,passagesRetryAt:retryAt,passagesSourceHash:before.passagesSourceHash,passagesClaimId:null,passagesLeaseUntil:null});
      throw Error("restore_test_rollback");
    })).rejects.toThrow("restore_test_rollback");
    expect(await db.transcript.findUniqueOrThrow({where:{id:value.transcript.id}})).toEqual(before);
  });
});
