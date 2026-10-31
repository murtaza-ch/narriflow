import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { contentPackSchema } from "@narriflow/validators";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { appendExecutionDispatch } from "./execution-dispatch";
import { workflowRunExecutionInputHash } from "./workflow-execution-input";
import { clipSelectionBytesHash, decodeClipSelectionInput } from "./clip-selection-input";
import { createClipSelectionPreparation, type ClipSelectionStorage } from "./clip-selection-preparation";
import { createClipSelectionLifecycle } from "./clip-selection-window";
import { createClipSelectionControl } from "./clip-selection-control";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const dbDescribe = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
dbDescribe("Frozen selection preparation", () => {
  let db: PrismaClient;
  const users: string[] = [];
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
    assertExecutionDatabaseTestTarget(url, schema);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 8 }, { schema }), transactionOptions: { maxWait: 10_000, timeout: 30_000 } });
  });
  afterAll(async () => {
    await db.workspace.deleteMany({ where: { ownerUserId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  });
  afterEach(async () => { await db.project.updateMany({ where: { workspace: { ownerUserId: { in: users } } }, data: { ingestStatus: "failed" } }); });
  async function fixture(sparse = false, captionOnly = false) {
    const user = await db.user.create({ data: { clerkId: `selection-preparation:${crypto.randomUUID()}` } }); users.push(user.id);
    const workspace = await db.workspace.create({ data: { ownerUserId: user.id, name: "Selection preparation" } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, title: "Frozen source", sourceMediaUrl: "r2://gate/source", sourceDurationSeconds: captionOnly ? 120 : 3600, ingestStatus: "ready" } });
    const settings = contentPackSchema.parse({ outputTypes: ["short_clip"], clipCountTarget: 3, clipDurationSecTarget: 45, platformPlaybookVersion: "platform-playbook-v1", ...(captionOnly ? { mode: "caption_only" } : {}) });
    const pack = await db.contentPack.create({ data: { projectId: project.id, outputTypes: ["short_clip"], clipCountTarget: 3, clipDurationSecTarget: 45, platformPlaybookVersion: "platform-playbook-v1",
      toneConstraints: settings.toneConstraints, captionPreset: settings.captionPreset, mode: settings.mode } });
    const utterances = Array.from({ length: sparse || captionOnly ? 1 : 60 }, (_, index) => ({ index, speaker: 0, speakerLabel: "Speaker 1", startSec: index * 60, endSec: index * 60 + 20,
      text: "A complete story.", confidence: null, words: [{ word: "story.", startSec: index * 60, endSec: index * 60 + 20, confidence: null }] }));
    const transcript = await db.transcript.create({ data: { projectId: project.id, status: "completed", workflowAttemptId: crypto.randomUUID(), sourceRevision: 1, text: "A completed frozen transcript", utterancesJson: utterances, speakerCount: 1, languageCode: "en" } });
    const epoch = (await db.executionEpoch.findUniqueOrThrow({ where: { id: 1 } })).epoch;
    const run = await db.workflowRun.create({ data: { projectId: project.id, contentPackId: pack.id, stage: "moment_detection", status: "queued", idempotencyKey: crypto.randomUUID(), deploymentEpoch: epoch } });
    const inputHash = await workflowRunExecutionInputHash({ ...run, sourceAudioId: null, sourceRevision: 1, sourceTranscript: { id: transcript.id, generation: 1, attemptId: transcript.workflowAttemptId } });
    const reference = await db.$transaction(async tx => (await appendExecutionDispatch(tx, { deploymentEpoch: epoch, generation: 1, kind: "operation_driver", subject: { kind: "workflow_run", id: run.id }, inputHash, dueAt: run.createdAt })).reference);
    return { project, transcript, pack, run, reference };
  }
  function storageFixture() {
    const objects = new Map<string, Uint8Array>();
    const storage: ClipSelectionStorage = {
      async write(key, bytes) { objects.set(key, bytes.slice()); return { etag: '"sealed"', byteLength: bytes.byteLength, sha256: await clipSelectionBytesHash(bytes) }; },
      async read(reference) { const bytes = objects.get(reference.storageKey); if (!bytes || reference.etag !== '"sealed"') throw new Error("Object precondition failed"); return bytes.slice(); },
    };
    return { storage, objects };
  }
  const provider = { model: "gpt-5.4-mini", reasoningEffort: "medium", maxOutputTokens: 32000 };
  test("preparation stores one private input, registers every window/deadline atomically and replays the frozen guidance without a new read", async () => {
    const f = await fixture(), store = storageFixture();
    let guidanceReads = 0;
    const preparation = createClipSelectionPreparation({ database: db, storage: store.storage, provider, guidance: { async promptLine() { guidanceReads++; return "Frozen audience data"; } } });
    const prepared = await preparation.prepare(f.reference);
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") throw new Error("Selection was not prepared");
    expect(prepared.windows).toHaveLength(2);
    expect(prepared.dispatchIds).toHaveLength(4);
    expect(JSON.stringify(prepared).length).toBeLessThan(65536);
    expect(store.objects.size).toBe(1);
    expect(await preparation.prepare(f.reference)).toEqual(prepared);
    expect(guidanceReads).toBe(1);
    const metadata = await preparation.readWindow(prepared.windows[0]!);
    if (!metadata) throw new Error("Frozen input unavailable");
    const decoded = await decodeClipSelectionInput(await store.storage.read(metadata.input), metadata.input, metadata.parent);
    expect(decoded.planning).toMatchObject({ projectTitle: "Frozen source", audienceDataLine: "Frozen audience data", sourceLanguageCode: "en" });
    expect((await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } }))).toMatchObject({ status: "waiting", attemptId: null, leaseOwner: null, leaseExpiresAt: null, attemptCount: 0 });
    expect(await db.executionAttempt.count({ where: { dispatch: { subjectId: { in: prepared.windows.map(reference => reference.subject.id) } } } })).toBe(0);
  });
  test("sparse and caption-only windows persist deterministic results without a provider permit or charge", async () => {
    for (const captionOnly of [false, true]) {
      const f = await fixture(true, captionOnly), store = storageFixture();
      const preparation = createClipSelectionPreparation({ database: db, storage: store.storage, provider });
      const prepared = await preparation.prepare(f.reference);
      if (prepared.kind !== "prepared") throw new Error("Selection was not prepared");
      expect(prepared.windows.length).toBe(captionOnly ? 0 : 1);
      const rows = await db.clipSelectionWindow.findMany({ where: { workflowRunId: f.run.id }, orderBy: { windowIndex: "asc" } });
      expect(rows.at(-1)).toMatchObject({ status: "completed", attemptToken: null, executorOwner: null, attemptCount: 0, tokensUsed: 0 });
      expect(rows.at(-1)!.resultStorageKey).toContain("/server/selection_window/");
    }
  });
  test("failed storage and a source replacement during external I/O leave no partially prepared membership", async () => {
    const f = await fixture(), store = storageFixture();
    const failed = createClipSelectionPreparation({ database: db, storage: { ...store.storage, async write() { throw new Error("Storage unavailable"); } }, provider });
    await expect(failed.prepare(f.reference)).rejects.toThrow("Storage unavailable");
    expect(await db.clipSelectionWindow.count({ where: { workflowRunId: f.run.id } })).toBe(0);
    const raced = createClipSelectionPreparation({ database: db, provider, storage: { ...store.storage, async write(key, bytes) {
      await db.transcript.update({ where: { id: f.transcript.id }, data: { selectionGeneration: { increment: 1 } } });
      return store.storage.write(key, bytes);
    } } });
    expect((await raced.prepare(f.reference)).kind).toBe("superseded");
    expect(await db.clipSelectionWindow.count({ where: { workflowRunId: f.run.id } })).toBe(0);
    expect((await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).status).toBe("queued");
  });
  test("the controller confirms watchdogs before a fresh paid start and reuses a completed private result without another POST", async () => {
    const f = await fixture(), store = storageFixture();
    const preparation = createClipSelectionPreparation({ database: db, storage: store.storage, provider });
    const prepared = await preparation.prepare(f.reference);
    if (prepared.kind !== "prepared") throw new Error("Selection was not prepared");
    const lifecycle = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 2, maxEstimatedTokens: 1_000_000 });
    let providerCalls = 0, confirmed = false;
    const control = createClipSelectionControl({ preparation, lifecycle, storage: store.storage, async deliver(ids) {
      expect(ids.length).toBeGreaterThan(0); confirmed = true;
    }, provider: { async generate(input) {
      expect(confirmed).toBe(true); providerCalls++;
      expect(input.configuration).toEqual(provider);
      const current = await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: prepared.windows[0]!.subject.id } });
      expect(current.attemptCount).toBe(1);
      expect((await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: current.attemptToken! } })).status).toBe("running");
      return { kind: "completed", content: '{"clips":[]}', tokensUsed: 123, providerRequestId: "req_gate", rateLimitHeaders: {} };
    } } });
    expect(await control.runWindow(prepared.windows[0]!)).toEqual({ kind: "complete", outcome: "completed" });
    expect(await control.runWindow(prepared.windows[0]!)).toEqual({ kind: "complete", outcome: "completed" });
    expect(providerCalls).toBe(1);
    const completed = await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: prepared.windows[0]!.subject.id } });
    expect(completed).toMatchObject({ status: "completed", attemptCount: 1, tokensUsed: 123 });
    expect(store.objects.has(completed.resultStorageKey!)).toBe(true);
    expect((await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } }))).toMatchObject({ status: "waiting", attemptId: null, leaseExpiresAt: null });
  });
  test("failed scheduler confirmation spends no paid start and a corrupt private input fails before ownership", async () => {
    for (const corrupt of [false, true]) {
      const f = await fixture(), store = storageFixture();
      const preparation = createClipSelectionPreparation({ database: db, storage: store.storage, provider });
      const prepared = await preparation.prepare(f.reference);
      if (prepared.kind !== "prepared") throw new Error("Selection was not prepared");
      const lifecycle = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 2, maxEstimatedTokens: 1_000_000 });
      let providerCalls = 0;
      const control = createClipSelectionControl({ preparation, lifecycle, storage: { ...store.storage, async read(reference) {
        const bytes = await store.storage.read(reference); if (corrupt) bytes[0] = 0; return bytes;
      } }, async deliver() { if (!corrupt) throw new Error("Scheduler unavailable"); }, provider: { async generate() { providerCalls++; throw new Error("Unexpected POST"); } } });
      if (corrupt) expect(await control.runWindow(prepared.windows[0]!)).toEqual({ kind: "complete", outcome: "failed" });
      else await expect(control.runWindow(prepared.windows[0]!)).rejects.toThrow("Scheduler unavailable");
      expect(providerCalls).toBe(0);
      expect((await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: prepared.windows[0]!.subject.id } }))).toMatchObject({ attemptCount: 0, status: corrupt ? "failed" : "running" });
      await db.project.update({ where: { id: f.project.id }, data: { ingestStatus: "failed" } });
    }
  });
  test("a provider 429 persists its due time, revokes the old owner and never sends a second request from an old window delivery", async () => {
    const f = await fixture(), store = storageFixture();
    const preparation = createClipSelectionPreparation({ database: db, storage: store.storage, provider });
    const prepared = await preparation.prepare(f.reference);
    if (prepared.kind !== "prepared") throw new Error("Selection was not prepared");
    const lifecycle = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 2, maxEstimatedTokens: 1_000_000 });
    let requests = 0;
    const dueAt = new Date(Date.now() + 30_000);
    const control = createClipSelectionControl({ preparation, lifecycle, storage: store.storage, async deliver() {}, provider: { async generate() {
      requests++; return { kind: "retry", dueAt, code: "openai_request_failed", providerRequestId: "req_429", rateLimitHeaders: { "x-ratelimit-remaining-requests": "0" } };
    } } });
    expect(await control.runWindow(prepared.windows[0]!)).toEqual({ kind: "complete", outcome: "retried" });
    expect(await control.runWindow(prepared.windows[0]!)).toEqual({ kind: "complete", outcome: "superseded" });
    expect(requests).toBe(1);
    expect((await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: prepared.windows[0]!.subject.id } }))).toMatchObject({ status: "queued", generation: 2,
      attemptCount: 1, attemptToken: null, executorOwner: null, retryAt: dueAt });
  });
});
