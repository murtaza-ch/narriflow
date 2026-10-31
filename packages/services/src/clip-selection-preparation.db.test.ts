import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { contentPackSchema } from "@narriflow/validators";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { appendExecutionDispatch } from "./execution-dispatch";
import { workflowRunExecutionInputHash } from "./workflow-execution-input";
import { clipSelectionBytesHash, decodeClipSelectionInput } from "./clip-selection-input";
import { createClipSelectionPreparation, type ClipSelectionStorage } from "./clip-selection-preparation";
import { createClipSelectionLifecycle, clipSelectionWindowResultKey } from "./clip-selection-window";
import { createClipSelectionControl } from "./clip-selection-control";
import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { withServiceEnvironment } from "./runtime-environment";
import { lockWorkspaceUsage } from "./processing-usage";

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
    const utterances = Array.from({ length: captionOnly ? 0 : sparse ? 1 : 60 }, (_, index) => ({ index, speaker: 0, speakerLabel: "Speaker 1", startSec: index * 60, endSec: index * 60 + 20,
      text: "A complete story.", confidence: null, words: [{ word: "story.", startSec: index * 60, endSec: index * 60 + 20, confidence: null }] }));
    const transcript = await db.transcript.create({ data: { projectId: project.id, status: "completed", workflowAttemptId: crypto.randomUUID(), sourceRevision: 1, text: captionOnly ? "" : "A completed frozen transcript", utterancesJson: utterances, speakerCount: 1, languageCode: "en" } });
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
  test("failed scheduler confirmation and corrupt private inputs spend no paid start", async () => {
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
  test("a capacity waiter does not fetch or parse the private transcript while another uncharged reservation owns the slot", async () => {
    const first = await fixture(), waiting = await fixture(), store = storageFixture();
    const preparation = createClipSelectionPreparation({ database: db, storage: store.storage, provider });
    const a = await preparation.prepare(first.reference), b = await preparation.prepare(waiting.reference);
    if (a.kind !== "prepared" || b.kind !== "prepared") throw new Error("Selection was not prepared");
    const lifecycle = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 1, maxEstimatedTokens: 1_000_000 });
    expect((await lifecycle.admit(a.windows[0]!, { owner: crypto.randomUUID() })).kind).toBe("acquired");
    let reads = 0;
    const control = createClipSelectionControl({ preparation, lifecycle, storage: { ...store.storage, async read(reference) { reads++; return store.storage.read(reference); } },
      async deliver() {}, provider: { async generate() { throw new Error("Capacity wait cannot POST"); } } });
    expect((await control.runWindow(b.windows[0]!)).kind).toBe("wait");
    expect(reads).toBe(0);
    expect((await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: b.windows[0]!.subject.id } }))).toMatchObject({ status: "queued", attemptCount: 0, executorOwner: null });
  });
  test("one global finalization deduplicates overlapping windows and atomically publishes Clips, renders and terminal progress; replay preserves edits and repairs wakes", async () => {
    const f = await fixture(), store = storageFixture();
    const preparation = createClipSelectionPreparation({ database: db, storage: store.storage, provider });
    const lifecycle = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 2, maxEstimatedTokens: 1_000_000 });
    const workflow = withServiceEnvironment({}, () => new WorkflowRunLifecycle({ prisma: db }));
    const delivered: string[] = [];
    let requests = 0;
    const candidate = (start: number) => ({ title: "A complete story", start_time: start, end_time: start + 45, hook_text: "A hook", payoff_text: "A payoff", reasoning: "A complete story",
      category: "story", platform_fit: ["tiktok"], hook_strength: 80, emotional_intensity: 80, story_completeness_score: 95, broll_cues: [] });
    const control = createClipSelectionControl({ preparation, lifecycle, finalization: workflow, storage: store.storage, async deliver(ids) { delivered.push(...ids); }, provider: { async generate(input) {
      requests++; return { kind: "completed", content: JSON.stringify({ clips: input.userPrompt.includes("start_sec=1800.000") && !input.userPrompt.includes("start_sec=0.000")
        ? [candidate(1800), candidate(2700)] : [candidate(0), candidate(1800)] }), tokensUsed: 100, providerRequestId: `req_${requests}`, rateLimitHeaders: {} };
    } } });
    expect((await withServiceEnvironment({}, () => control.runParent(f.reference))).kind).toBe("wait");
    const prepared = await preparation.prepare(f.reference);
    if (prepared.kind !== "prepared") throw new Error("Selection was not prepared");
    for (const reference of prepared.windows) expect(await control.runWindow(reference)).toEqual({ kind: "complete", outcome: "completed" });
    expect(requests).toBe(2);
    const trigger = `selection_fail_${crypto.randomUUID().replaceAll("-", "")}`;
    await db.$executeRawUnsafe(`CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM "Clip" WHERE id=NEW."clipId" AND "projectId"='${f.project.id}'::uuid) THEN RAISE EXCEPTION 'Injected render admission failure'; END IF; RETURN NEW; END; $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" BEFORE INSERT ON "ClipRender" FOR EACH ROW EXECUTE FUNCTION "${trigger}"()`);
    try {
      await expect(withServiceEnvironment({}, () => control.runParent(f.reference))).rejects.toThrow("Injected render admission failure");
      expect(await db.clip.count({ where: { projectId: f.project.id } })).toBe(0);
      expect((await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).status).toBe("waiting");
      expect(await db.workflowEvent.count({ where: { workflowRunId: f.run.id, status: "completed" } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER "${trigger}" ON "ClipRender"`);
      await db.$executeRawUnsafe(`DROP FUNCTION "${trigger}"()`);
    }
    expect(await withServiceEnvironment({}, () => control.runParent(f.reference))).toEqual({ kind: "complete", outcome: "completed" });
    const clips = await db.clip.findMany({ where: { projectId: f.project.id }, orderBy: { index: "asc" } });
    expect(clips).toHaveLength(3);
    expect(await db.clipRender.count({ where: { clip: { projectId: f.project.id }, resolution: "720p" } })).toBe(3);
    expect(await db.workflowRun.count({ where: { projectId: f.project.id, stage: "clip_rendering" } })).toBe(1);
    expect((await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } }))).toMatchObject({ status: "completed", attemptCount: 0, attemptId: null, leaseOwner: null, leaseExpiresAt: null });
    await db.clip.update({ where: { id: clips[0]!.id }, data: { title: "Human edit" } });
    delivered.length = 0;
    expect(await withServiceEnvironment({}, () => control.runParent(f.reference))).toEqual({ kind: "complete", outcome: "completed" });
    expect((await db.clip.findMany({ where: { projectId: f.project.id }, orderBy: { index: "asc" } })).map(clip => clip.id)).toEqual(clips.map(clip => clip.id));
    expect((await db.clip.findUniqueOrThrow({ where: { id: clips[0]!.id } })).title).toBe("Human edit");
    expect(await db.workflowEvent.count({ where: { workflowRunId: f.run.id, status: "completed" } })).toBe(1);
    const renderRun = await db.workflowRun.findFirstOrThrow({ where: { projectId: f.project.id, stage: "clip_rendering" } });
    const child = await db.executionDispatch.findFirstOrThrow({ where: { subjectKind: "workflow_run", kind: "render_run", subjectId: renderRun.id } });
    expect(delivered).toContain(child.id);
  });
  test("caption-only finalization admits one whole-source export and its render driver without any model request", async () => {
    const f = await fixture(true, true), store = storageFixture();
    await db.contentPack.update({ where: { id: f.pack.id }, data: { captionedVideo: { framing: "fit", aspectRatios: ["9:16", "1:1"], resolution: "1080p", captions: { source: "none" } } } });
    const preparation = createClipSelectionPreparation({ database: db, storage: store.storage, provider });
    const lifecycle = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 2, maxEstimatedTokens: 1_000_000 });
    const workflow = withServiceEnvironment({}, () => new WorkflowRunLifecycle({ prisma: db }));
    const control = createClipSelectionControl({ preparation, lifecycle, finalization: workflow, storage: store.storage, async deliver() {}, provider: { async generate() { throw new Error("Caption-only cannot call the model"); } } });
    expect(await withServiceEnvironment({}, () => control.runParent(f.reference))).toEqual({ kind: "complete", outcome: "completed" });
    const clip = await db.clip.findFirstOrThrow({ where: { projectId: f.project.id } });
    expect(clip).toMatchObject({ wholeSource: true, startSec: 0, endSec: 120, llmModel: "caption-only", llmTokensUsed: 0 });
    const exported = await db.clipExport.findFirstOrThrow({ where: { projectId: f.project.id }, include: { variants: true } });
    expect(exported).toMatchObject({ resolution: "720p", watermark: true });
    expect(exported.variants).toHaveLength(2);
    expect(await db.clipRender.count({ where: { clipId: clip.id } })).toBe(2);
    expect(await db.workflowRun.count({ where: { projectId: f.project.id, stage: "clip_rendering" } })).toBe(1);
    expect(await withServiceEnvironment({}, () => control.runParent(f.reference))).toEqual({ kind: "complete", outcome: "completed" });
    expect(await db.clipExport.count({ where: { projectId: f.project.id } })).toBe(1);
    expect(await db.clip.count({ where: { projectId: f.project.id } })).toBe(1);
  });
  test("an exhausted window fails its unleased parent and revokes a sibling before its late result can publish", async () => {
    const f = await fixture(), store = storageFixture();
    const preparation = createClipSelectionPreparation({ database: db, storage: store.storage, provider });
    const prepared = await preparation.prepare(f.reference);
    if (prepared.kind !== "prepared") throw new Error("Selection was not prepared");
    const lifecycle = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 2, maxEstimatedTokens: 1_000_000 });
    const first = await lifecycle.admit(prepared.windows[0]!, { owner: crypto.randomUUID() });
    const sibling = await lifecycle.admit(prepared.windows[1]!, { owner: crypto.randomUUID() });
    if (first.kind !== "acquired" || sibling.kind !== "acquired") throw new Error("Windows were not acquired");
    await lifecycle.start(first.attempt); await lifecycle.start(sibling.attempt);
    expect((await lifecycle.retry(first.attempt, { code: "openai_quota_exhausted" })).kind).toBe("failed");
    const workflow = withServiceEnvironment({}, () => new WorkflowRunLifecycle({ prisma: db }));
    const control = createClipSelectionControl({ preparation, lifecycle, finalization: workflow, storage: store.storage, async deliver() {}, provider: { async generate() { throw new Error("No new model request"); } } });
    expect(await withServiceEnvironment({}, () => control.runParent(f.reference))).toEqual({ kind: "complete", outcome: "failed" });
    expect((await db.clipSelectionWindow.findUniqueOrThrow({ where: { id: prepared.windows[1]!.subject.id } })).status).toBe("cancelled");
    expect((await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: sibling.attempt.token } }))).toMatchObject({ status: "cancelled", failureCode: "openai_quota_exhausted" });
    expect((await lifecycle.complete(sibling.attempt, { storageKey: clipSelectionWindowResultKey(sibling.attempt, "f".repeat(64)), etag: '"late"', sha256: "f".repeat(64), byteLength: 100, tokensUsed: 100, providerRequestId: "req_late" })).kind).toBe("superseded");
    expect(await db.clip.count({ where: { projectId: f.project.id } })).toBe(0);
    expect((await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } }))).toMatchObject({ status: "failed", errorCode: "openai_quota_exhausted", attemptId: null });
  });
  test("source cancellation revokes active window ownership together with its unleased parent", async () => {
    const f = await fixture(), store = storageFixture();
    const preparation = createClipSelectionPreparation({ database: db, storage: store.storage, provider });
    const prepared = await preparation.prepare(f.reference);
    if (prepared.kind !== "prepared") throw new Error("Selection was not prepared");
    const lifecycle = createClipSelectionLifecycle({ database: db, maxInFlightRequests: 2, maxEstimatedTokens: 1_000_000 });
    const active = await lifecycle.admit(prepared.windows[0]!, { owner: crypto.randomUUID() });
    if (active.kind !== "acquired") throw new Error("Window was not acquired");
    await lifecycle.start(active.attempt);
    const workflow = withServiceEnvironment({}, () => new WorkflowRunLifecycle({ prisma: db }));
    await withServiceEnvironment({}, () => db.$transaction(async tx => {
      await tx.$queryRaw`SELECT epoch FROM "ExecutionEpoch" WHERE id = 1 FOR SHARE`;
      await lockWorkspaceUsage(tx, f.project.workspaceId);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${f.project.id}, 0)) IS NULL AS "locked"`;
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${f.project.id}::uuid FOR UPDATE`;
      return workflow.cancelSourceExecutionsWithinTransaction(tx, { projectId: f.project.id, deploymentEpoch: f.reference.deploymentEpoch, errorCode: "source_audio_video_mismatch", now: new Date() });
    }));
    expect((await db.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).status).toBe("cancelled");
    expect(await db.clipSelectionWindow.count({ where: { workflowRunId: f.run.id, status: "cancelled" } })).toBe(2);
    expect((await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: active.attempt.token } }))).toMatchObject({ status: "cancelled", failureCode: "source_audio_video_mismatch" });
    expect((await lifecycle.start(active.attempt)).kind).toBe("superseded");
  });
});
