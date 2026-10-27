import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { getCaptionPresetById, studioEditsSchema } from "@narriflow/validators";
import { Pool } from "pg";
import { clipService } from "./clip.service";
import { clipPersistenceEditorDocument } from "./clip-persistence-db-test-support";
import { encodeClipEditorDocumentForStorage } from "./clip-editor-document-persistence";
import { isExpectedDomainFailure } from "./expected-domain-failure";
import { LibrarySearch, MAX_INDEX_ATTEMPTS } from "./library-search";
import { librarySearchService } from "./library-search-runtime";
import {
  EmbeddingProviderError,
  LIBRARY_EMBEDDING_DIMENSIONS,
  LIBRARY_EMBEDDING_MODEL,
  type EmbeddingProvider,
} from "./openai-embedding-provider";

const databaseUrl = process.env.LIBRARY_SEARCH_TEST_DATABASE_URL;
const databaseSchema = process.env.LIBRARY_SEARCH_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_LIBRARY_SEARCH_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;

setDefaultTimeout(60_000);

/** Words that mean the same thing share an axis, so tests control which
 * passages are close in meaning without calling a model. */
const TOPICS: Record<string, string[]> = {
  pricing: ["price", "pricing", "cost", "subscription", "fee", "fees", "charge", "charges"],
  hiring: ["hire", "hiring", "recruit", "candidate", "interview"],
  cooking: ["recipe", "oven", "bake", "dough", "kitchen"],
};
const AXES = Object.keys(TOPICS);

function meaningVector(text: string) {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const vector = new Array<number>(LIBRARY_EMBEDDING_DIMENSIONS).fill(0);
  AXES.forEach((topic, axis) => {
    vector[axis] = words.filter((word) => TOPICS[topic]!.includes(word)).length;
  });
  // Text without any topic word would be the zero vector; give it its own axis.
  if (vector.every((value) => value === 0)) vector[AXES.length] = 1;
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length);
}

function fakeEmbeddings() {
  const embedded: string[] = [];
  const state = { calls: 0 };
  let failWith: Error | null = null;
  // One entry per upcoming request: an Error fails that request, null lets it through.
  let script: Array<Error | null> = [];
  const provider: EmbeddingProvider = {
    model: LIBRARY_EMBEDDING_MODEL,
    configured: true,
    async embed(texts) {
      state.calls++;
      const scripted = script.shift();
      if (scripted) throw scripted;
      if (failWith) throw failWith;
      embedded.push(...texts);
      return { vectors: texts.map(meaningVector), tokens: texts.length * 10 };
    },
  };
  return {
    provider, embedded, state,
    failNext: (error: Error | null) => { failWith = error; },
    script: (...results: Array<Error | null>) => { script = results; },
  };
}

/** Utterances with word timings every half second, as the clip planner needs. */
function wordedUtterances(seconds = 120) {
  const words = Array.from({ length: seconds * 2 }, (_, index) => ({ word: `word${index}`, startSec: index * 0.5, endSec: index * 0.5 + 0.5, confidence: null }));
  return [{ index: 0, speaker: 0, speakerLabel: "Speaker 1", startSec: 0, endSec: seconds, text: words.map((word) => word.word).join(" "), confidence: null, words }];
}

/** One utterance per passage: each is longer than the 30 second minimum. */
const utterancesFor = (texts: string[]) => texts.map((text, index) => ({
  index, speaker: 0, speakerLabel: "Speaker 1", startSec: index * 40, endSec: index * 40 + 35, text, confidence: null, words: [],
}));

dbDescribe("Library search PostgreSQL contracts", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  const logs: Array<Record<string, unknown>> = [];
  const embeddings = fakeEmbeddings();
  const prismaGlobal = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };
  let priorPrisma: PrismaClient | undefined;
  let library: LibrarySearch;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, databaseSchema ? { schema: databaseSchema } : undefined) });
    // The services under test (membership checks, clips) read the shared client.
    priorPrisma = prismaGlobal.narriflowPrismaClient;
    prismaGlobal.narriflowPrismaClient = prisma;
    library = new LibrarySearch({ prisma, embeddings: embeddings.provider, log: (entry) => logs.push(entry) });
  });

  afterAll(async () => {
    prismaGlobal.narriflowPrismaClient = priorPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function workspaceFixture(label: string) {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { clerkId: `library-${label}-${suffix}`, primaryEmail: `library-${label}-${suffix}@example.test` } });
    const workspace = await prisma.workspace.create({ data: {
      name: `Library ${label}`, ownerUserId: user.id, pricingTier: "business", members: { create: { userId: user.id, role: "owner" } },
    } });
    return { scope: { actorUserId: user.id, workspaceId: workspace.id }, workspaceId: workspace.id, userId: user.id };
  }

  /** A project whose finished transcript is indexed immediately. */
  async function indexedProject(workspaceId: string, title: string, texts: string[], project: { purgeStartedAt?: Date; expiresAt?: Date } = {}) {
    const created = await prisma.project.create({ data: { title, sourceMediaUrl: "https://example.test/video.mp4", workspaceId, ...project } });
    const transcript = await prisma.transcript.create({ data: {
      projectId: created.id, status: "completed", completedAt: new Date(), utterancesJson: utterancesFor(texts),
    } });
    await indexAll();
    return { projectId: created.id, transcriptId: transcript.id };
  }

  async function indexAll() {
    while ((await library.indexNext()) > 0);
  }

  async function passageCount(transcriptId: string) {
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM "TranscriptPassage" WHERE "transcriptId" = ${transcriptId}::uuid`;
    return rows[0]!.count;
  }

  describe("Workspace isolation", () => {
    test("never returns another Workspace's passages, including by project filter", async () => {
      const mine = await workspaceFixture("mine");
      const theirs = await workspaceFixture("theirs");
      const own = await indexedProject(mine.workspaceId, "Own episode", ["Our subscription price was too high"]);
      const other = await indexedProject(theirs.workspaceId, "Their episode", ["Their subscription price is the secret plan"]);

      const results = await library.search(mine.scope, { query: "subscription price" });
      expect(results.map((result) => result.projectId)).toEqual([own.projectId]);
      expect(JSON.stringify(results)).not.toContain("secret plan");

      expect(await library.search(mine.scope, { query: "subscription price", projectIds: [other.projectId] })).toEqual([]);
      const theirResults = await library.search(theirs.scope, { query: "subscription price" });
      expect(theirResults.map((result) => result.projectId)).toEqual([other.projectId]);
    });

    test("does not trust a stale denormalized workspaceId on a passage", async () => {
      const first = await workspaceFixture("stale-first");
      const second = await workspaceFixture("stale-second");
      const moved = await indexedProject(first.workspaceId, "Moved episode", ["The hiring interview went well"]);
      // The passage claims the second Workspace, but its Project belongs to the first.
      await prisma.$executeRaw`UPDATE "TranscriptPassage" SET "workspaceId" = ${second.workspaceId}::uuid WHERE "projectId" = ${moved.projectId}::uuid`;
      expect(await library.search(second.scope, { query: "hiring interview" })).toEqual([]);
      expect(await library.search(first.scope, { query: "hiring interview" })).toEqual([]);
    });

    test("only Projects the actor can view: purging and expired Projects are excluded", async () => {
      const { scope, workspaceId } = await workspaceFixture("access");
      const live = await indexedProject(workspaceId, "Live", ["Dough needs a hot oven"]);
      const later = await indexedProject(workspaceId, "Expires later", ["Dough rests before the oven"], { expiresAt: new Date(Date.now() + 86_400_000) });
      await indexedProject(workspaceId, "Purging", ["Dough in the oven during purge"], { purgeStartedAt: new Date() });
      await indexedProject(workspaceId, "Expired", ["Dough and oven after expiry"], { expiresAt: new Date(Date.now() - 1_000) });

      const results = await library.search(scope, { query: "dough oven" });
      expect(results.map((result) => result.projectTitle).sort()).toEqual(["Expires later", "Live"]);
      expect(results.map((result) => result.projectId).sort()).toEqual([live.projectId, later.projectId].sort());
    });

    test("deleting a Project removes its passages", async () => {
      const { scope, workspaceId } = await workspaceFixture("cascade");
      const doomed = await indexedProject(workspaceId, "Doomed", ["Recruit the best candidate"]);
      expect(await passageCount(doomed.transcriptId)).toBe(1);
      await prisma.project.delete({ where: { id: doomed.projectId } });
      expect(await passageCount(doomed.transcriptId)).toBe(0);
      expect(await library.search(scope, { query: "recruit candidate" })).toEqual([]);
    });
  });

  describe("hybrid ranking", () => {
    test("ranks a passage that matches both meaning and words above those matching only one", async () => {
      const { scope, workspaceId } = await workspaceFixture("ranking");
      const { projectId } = await indexedProject(workspaceId, "Founders talk", [
        "We argued about subscription fees and the hiring interview all week", // meaning only: part pricing, never says "pricing"
        "Pricing the pizza dough in the oven and kitchen recipe", // words only: says "pricing", about cooking
        "How much is our pricing for the subscription fees", // both
        "A recipe needs dough and a hot oven in the kitchen", // neither
      ]);

      const results = await library.search(scope, { query: "pricing" });
      // Both signals first. Of the single-signal passages, the exact-word hit
      // (which also sits in the meaning list) beats the paraphrase; the
      // passage with neither signal is last.
      expect(results.map((result) => result.text)).toEqual([
        "How much is our pricing for the subscription fees",
        "Pricing the pizza dough in the oven and kitchen recipe",
        "We argued about subscription fees and the hiring interview all week",
        "A recipe needs dough and a hot oven in the kitchen",
      ]);
      expect(results[0]).toMatchObject({ projectId, projectTitle: "Founders talk", startMs: 80_000, endMs: 115_000 });
      expect(results.map((result) => result.score)).toEqual([...results.map((result) => result.score)].sort((a, b) => b - a));
      expect(results[0]!.score).toBeGreaterThan(results[2]!.score * 1.5);
    });

    test("finds exact words that a semantic search alone would bury", async () => {
      const { scope, workspaceId } = await workspaceFixture("exact");
      await indexedProject(workspaceId, "Show notes", [
        "The pricing page and subscription cost were debated",
        "We hire slowly and interview every candidate",
        "Our codename was Zanzibar for the recipe oven launch", // far from any meaning in the query
      ]);
      const [top] = await library.search(scope, { query: "Zanzibar" });
      expect(top?.text).toBe("Our codename was Zanzibar for the recipe oven launch");
    });

    test("respects the limit and the project filter", async () => {
      const { scope, workspaceId } = await workspaceFixture("limit");
      const a = await indexedProject(workspaceId, "A", ["subscription price one", "subscription price two", "subscription price three"]);
      const b = await indexedProject(workspaceId, "B", ["subscription price four"]);
      expect(await library.search(scope, { query: "subscription price", limit: 2 })).toHaveLength(2);
      const onlyB = await library.search(scope, { query: "subscription price", projectIds: [b.projectId] });
      expect(onlyB.map((result) => result.projectId)).toEqual([b.projectId]);
      expect((await library.search(scope, { query: "subscription price", projectIds: [a.projectId], limit: 25 })).length).toBe(3);
    });

    test("a query of only stop words and punctuation still returns by meaning", async () => {
      const { scope, workspaceId } = await workspaceFixture("stopwords");
      await indexedProject(workspaceId, "Quiet", ["subscription price talk"]);
      expect((await library.search(scope, { query: "the of and" })).length).toBe(1);
    });
  });

  describe("indexing", () => {
    test("indexes a finished transcript once, with usage logged", async () => {
      const { workspaceId } = await workspaceFixture("index-once");
      logs.length = 0;
      const created = await prisma.project.create({ data: { title: "Once", sourceMediaUrl: "https://example.test/once.mp4", workspaceId } });
      const transcript = await prisma.transcript.create({ data: {
        projectId: created.id, status: "completed", completedAt: new Date(), utterancesJson: utterancesFor(["First point", "Second point", "Third point"]),
      } });

      expect(await library.indexNext()).toBe(1);
      expect(await passageCount(transcript.id)).toBe(3);
      const row = (await prisma.$queryRaw<Array<{ workspaceId: string; embeddingModel: string; startMs: number; endMs: number }>>`
        SELECT "workspaceId", "embeddingModel", "startMs", "endMs" FROM "TranscriptPassage" WHERE "transcriptId" = ${transcript.id}::uuid ORDER BY "startMs" LIMIT 1`)[0];
      expect(row).toEqual({ workspaceId, embeddingModel: LIBRARY_EMBEDDING_MODEL, startMs: 0, endMs: 35_000 });
      const indexed = logs.find((entry) => entry.message === "library_passages_indexed");
      expect(indexed).toMatchObject({ transcriptId: transcript.id, passages: 3, embedded: 3, removed: 0, tokens: 30, model: LIBRARY_EMBEDDING_MODEL });

      expect(await library.indexNext()).toBe(0);
    });

    test("re-embeds only what changed when a transcript is replaced", async () => {
      const { workspaceId } = await workspaceFixture("reindex");
      const { projectId, transcriptId } = await indexedProject(workspaceId, "Changing", ["Alpha point", "Beta point", "Gamma point"]);
      embeddings.embedded.length = 0;

      await prisma.transcript.update({ where: { projectId }, data: {
        utterancesJson: utterancesFor(["Alpha point", "Beta point revised", "Gamma point", "Delta point"]),
        completedAt: new Date(Date.now() + 1_000),
      } });
      await indexAll();

      expect(embeddings.embedded.sort()).toEqual(["Beta point revised", "Delta point"]);
      const texts = (await prisma.$queryRaw<Array<{ text: string }>>`SELECT "text" FROM "TranscriptPassage" WHERE "transcriptId" = ${transcriptId}::uuid ORDER BY "startMs"`).map((row) => row.text);
      expect(texts).toEqual(["Alpha point", "Beta point revised", "Gamma point", "Delta point"]);
    });

    test("a provider failure backs off, keeps old passages, and never throws", async () => {
      const { scope, workspaceId } = await workspaceFixture("failure");
      const { projectId, transcriptId } = await indexedProject(workspaceId, "Flaky", ["Subscription price before"]);
      await prisma.transcript.update({ where: { projectId }, data: { utterancesJson: utterancesFor(["Subscription price after"]), completedAt: new Date(Date.now() + 1_000) } });

      logs.length = 0;
      embeddings.failNext(new EmbeddingProviderError("embedding_request_failed", { status: 503 }));
      expect(await library.indexNext()).toBe(0);
      embeddings.failNext(null);

      const state = (await prisma.transcript.findUniqueOrThrow({ where: { projectId } }));
      expect(state.passagesAttempts).toBe(1);
      expect(state.passagesIndexError).toBe("embedding_request_failed");
      expect(state.passagesRetryAt!.getTime()).toBeGreaterThan(Date.now() - 5_000 + 20_000);
      expect(logs.find((entry) => entry.message === "library_passages_index_failed")).toMatchObject({ transcriptId, attempts: 1, retryInSeconds: 30 });
      // Search keeps working from the passages it already had.
      expect((await library.search(scope, { query: "subscription price" })).map((result) => result.text)).toEqual(["Subscription price before"]);

      // Not due yet: another tick leaves it alone.
      expect(await library.indexNext()).toBe(0);
      expect(embeddings.embedded.includes("Subscription price after")).toBe(false);

      await prisma.$executeRaw`UPDATE "Transcript" SET "passagesRetryAt" = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE "projectId" = ${projectId}::uuid`;
      expect(await library.indexNext()).toBe(1);
      expect((await library.search(scope, { query: "subscription price" })).map((result) => result.text)).toEqual(["Subscription price after"]);
      const recovered = await prisma.transcript.findUniqueOrThrow({ where: { projectId } });
      expect([recovered.passagesAttempts, recovered.passagesRetryAt, recovered.passagesIndexError]).toEqual([0, null, null]);
    });

    test("a failure part way keeps the batches already paid for and a retry embeds only the rest", async () => {
      const { scope, workspaceId } = await workspaceFixture("partial");
      const { projectId, transcriptId } = await indexedProject(workspaceId, "Partial", ["Old point"]);
      await indexAll();
      const batched = new LibrarySearch({
        prisma, embeddings: embeddings.provider, batch: { maxInputs: 2, maxEstimatedTokens: 1_000_000 }, log: (entry) => logs.push(entry),
      });
      await prisma.transcript.update({ where: { projectId }, data: {
        utterancesJson: utterancesFor(["Point one", "Point two", "Point three", "Point four", "Point five"]), completedAt: new Date(Date.now() + 1_000),
      } });

      logs.length = 0;
      embeddings.embedded.length = 0;
      embeddings.script(null, new EmbeddingProviderError("embedding_request_failed", { status: 429 }));
      expect(await batched.indexNext()).toBe(0);

      // Two requests: the first batch of two is stored, the second failed. The
      // old passage stays until the new transcript is complete.
      expect(embeddings.embedded).toEqual(["Point one", "Point two"]);
      const texts = async () => (await prisma.$queryRaw<Array<{ text: string }>>`SELECT "text" FROM "TranscriptPassage" WHERE "transcriptId" = ${transcriptId}::uuid ORDER BY "startMs"`).map((row) => row.text);
      expect((await texts()).sort()).toEqual(["Old point", "Point one", "Point two"].sort());
      const failed = await prisma.transcript.findUniqueOrThrow({ where: { projectId } });
      expect([failed.passagesIndexedFor!.getTime() < failed.completedAt!.getTime(), failed.passagesAttempts]).toEqual([true, 1]);
      expect(logs.find((entry) => entry.message === "library_passages_index_failed")).toMatchObject({ embeddedBeforeFailure: 2, tokens: 20, code: "embedding_request_failed" });

      await prisma.$executeRaw`UPDATE "Transcript" SET "passagesRetryAt" = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE "projectId" = ${projectId}::uuid`;
      embeddings.embedded.length = 0;
      expect(await batched.indexNext()).toBe(1);
      expect(embeddings.embedded.sort()).toEqual(["Point five", "Point four", "Point three"]);
      expect(await texts()).toEqual(["Point one", "Point two", "Point three", "Point four", "Point five"]);
      expect((await library.search(scope, { query: "point" })).length).toBe(5);
    });

    test("a transcript that keeps failing is left alone after the attempt cap, with its error recorded", async () => {
      const { workspaceId } = await workspaceFixture("cap");
      await indexAll();
      const project = await prisma.project.create({ data: { title: "Never works", sourceMediaUrl: "https://example.test/n.mp4", workspaceId } });
      await prisma.transcript.create({ data: { projectId: project.id, status: "completed", completedAt: new Date(), utterancesJson: utterancesFor(["Hopeless"]) } });

      logs.length = 0;
      embeddings.failNext(new EmbeddingProviderError("embedding_bad_response"));
      for (let attempt = 1; attempt <= MAX_INDEX_ATTEMPTS; attempt++) {
        expect(await library.indexNext()).toBe(0);
        await prisma.$executeRaw`UPDATE "Transcript" SET "passagesRetryAt" = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE "projectId" = ${project.id}::uuid`;
      }
      const abandoned = await prisma.transcript.findUniqueOrThrow({ where: { projectId: project.id } });
      expect([abandoned.passagesAttempts, abandoned.passagesIndexError, abandoned.passagesIndexedFor]).toEqual([MAX_INDEX_ATTEMPTS, "embedding_bad_response", null]);
      expect(logs.filter((entry) => entry.message === "library_passages_index_failed")).toHaveLength(MAX_INDEX_ATTEMPTS - 1);
      expect(logs.filter((entry) => entry.message === "library_passages_index_abandoned")).toEqual([
        expect.objectContaining({ level: "error", transcriptId: abandoned.id, attempts: MAX_INDEX_ATTEMPTS, code: "embedding_bad_response" }),
      ]);

      // Even when due, it is no longer claimed and costs no more requests.
      const calls = embeddings.state.calls;
      embeddings.failNext(null);
      expect(await library.indexNext()).toBe(0);
      expect(embeddings.state.calls).toBe(calls);

      // An operator reset puts it back in the queue.
      await prisma.$executeRaw`UPDATE "Transcript" SET "passagesAttempts" = 0 WHERE "projectId" = ${project.id}::uuid`;
      expect(await library.indexNext()).toBe(1);
      expect((await prisma.transcript.findUniqueOrThrow({ where: { projectId: project.id } })).passagesIndexError).toBeNull();
    });

    test("two workers never claim the same transcript", async () => {
      const { workspaceId } = await workspaceFixture("claim");
      const created = await prisma.project.create({ data: { title: "Contended", sourceMediaUrl: "https://example.test/c.mp4", workspaceId } });
      await prisma.transcript.create({ data: { projectId: created.id, status: "completed", completedAt: new Date(), utterancesJson: utterancesFor(["Only one worker"]) } });
      // Drain everything else so this is the only candidate.
      await indexAll();
      await prisma.transcript.update({ where: { projectId: created.id }, data: { completedAt: new Date(Date.now() + 1_000) } });

      const results = await Promise.all([library.indexNext(), library.indexNext(), library.indexNext()]);
      expect(results.reduce((total, count) => total + count, 0)).toBe(1);
    });

    test("skips transcripts that are unfinished or whose Project is purging", async () => {
      const { workspaceId } = await workspaceFixture("skip");
      await indexAll();
      const processing = await prisma.project.create({ data: { title: "Processing", sourceMediaUrl: "https://example.test/p.mp4", workspaceId } });
      await prisma.transcript.create({ data: { projectId: processing.id, status: "processing", utterancesJson: utterancesFor(["Not done"]) } });
      const purging = await prisma.project.create({ data: { title: "Purging", sourceMediaUrl: "https://example.test/g.mp4", workspaceId, purgeStartedAt: new Date() } });
      await prisma.transcript.create({ data: { projectId: purging.id, status: "completed", completedAt: new Date(), utterancesJson: utterancesFor(["Going away"]) } });
      expect(await library.indexNext()).toBe(0);
    });

    test("a transcript with no speech is marked indexed and not retried", async () => {
      const { workspaceId } = await workspaceFixture("silent");
      const project = await prisma.project.create({ data: { title: "Silent", sourceMediaUrl: "https://example.test/s.mp4", workspaceId } });
      await prisma.transcript.create({ data: { projectId: project.id, status: "completed", completedAt: new Date(), utterancesJson: [] } });
      expect(await library.indexNext()).toBe(1);
      expect(await library.indexNext()).toBe(0);
    });
  });

  describe("access through the service", () => {
    test("admits a member who can view content and refuses a non-member", async () => {
      const member = await workspaceFixture("members");
      const outsider = await workspaceFixture("outsider");
      const viewer = await prisma.user.create({ data: { clerkId: `library-viewer-${randomUUID()}`, primaryEmail: `viewer-${randomUUID()}@example.test` } });
      await prisma.workspaceMember.create({ data: { workspaceId: member.workspaceId, userId: viewer.id, role: "viewer" } });

      const priorKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY; // No provider is configured, so nothing leaves this process.
      try {
        const refusal = await librarySearchService.search({ actorUserId: outsider.userId, workspaceId: member.workspaceId }, { query: "pricing" }).catch((error) => error);
        expect(isExpectedDomainFailure(refusal)).toBe(true);
        expect(refusal).toMatchObject({ code: "workspace_access_denied", kind: "forbidden" });

        // A viewer passes the check and reaches the search, which has no embeddings here.
        const admitted = await librarySearchService.search({ actorUserId: viewer.id, workspaceId: member.workspaceId }, { query: "pricing" }).catch((error) => error);
        expect(admitted).toMatchObject({ code: "library_search_unavailable", kind: "unavailable" });
      } finally {
        if (priorKey !== undefined) process.env.OPENAI_API_KEY = priorKey;
      }
    });
  });

  describe("Make a clip", () => {
    const range = { startSec: 20, endSec: 50 };

    async function clipProject(workspaceId: string, userId: string) {
      const project = await prisma.project.create({ data: {
        title: "Clip source", sourceMediaUrl: "https://example.test/c.mp4", sourceDurationSeconds: 300, ingestStatus: "ready", workspaceId, createdByUserId: userId,
      } });
      await prisma.transcript.create({ data: { projectId: project.id, status: "completed", completedAt: new Date(), utterancesJson: wordedUtterances() } });
      return project;
    }

    async function generationRun(projectId: string, captionPresetId: string) {
      const pack = await prisma.contentPack.create({ data: {
        projectId, outputTypes: ["short_clip"], clipCountTarget: 5, clipDurationSecTarget: 45, toneConstraints: [], captionPreset: captionPresetId, platformPlaybookVersion: "test",
      } });
      return prisma.workflowRun.create({ data: { projectId, idempotencyKey: `run-${randomUUID()}`, stage: "moment_detection", status: "completed", contentPackId: pack.id } });
    }

    const styledEdits = () => studioEditsSchema.parse({
      music: { url: "https://example.test/song.mp3", title: "Song", volume: 40, startOffsetSec: 0, fadeInSec: 0, fadeOutSec: 0 },
      logo: { enabled: true, position: null, opacity: null, scalePct: null },
      sourceAudio: { volume: 55, muted: true },
      transition: { type: "fade", durationSec: 0.6 },
      textLayers: [{ id: "layer-1", text: "Hello", startSec: 1, endSec: 3, positionX: 50, positionY: 50 }],
      visualBroll: [{
        id: randomUUID(), asset: { kind: "visual_asset", id: randomUUID(), fingerprint: "b".repeat(64) }, startSec: 2, endSec: 6, fit: "cover",
      }],
    });

    async function sourceClip(projectId: string, workflowRunId: string, index = 0) {
      return prisma.clip.create({ data: {
        projectId, workflowRunId, index,
        ...encodeClipEditorDocumentForStorage(clipPersistenceEditorDocument({
          clipStartSec: 10, clipEndSec: 40, captionPreset: getCaptionPresetById("blast")!.preset, studioEdits: styledEdits(), brollUrl: "https://example.test/broll.mp4",
        }), { durationSec: 300, wholeSource: false }),
        hookText: "Source", reasoning: "Fixture", category: "hook", platformFit: ["tiktok"],
        viralityScore: 70, hookStrengthScore: 70, emotionalIntensityScore: 70, pacingScore: 70, durationOptimalityScore: 70,
        tiktokScore: 70, youtubeScore: 70, instagramScore: 70, llmProvider: "test", llmModel: "test",
      } });
    }

    test("a Project without clips has nothing to join and is refused with a conflict", async () => {
      const { scope, workspaceId, userId } = await workspaceFixture("clips-none");
      const project = await clipProject(workspaceId, userId);
      const refusal = await clipService.createClipFromRange(scope, project.id, range).catch((error) => error);
      expect(refusal).toMatchObject({ code: "clip_source_missing", kind: "conflict" });
      expect(await prisma.clip.count({ where: { projectId: project.id } })).toBe(0);
    });

    test("starts from the run's defaults and copies nothing from the source clip's look", async () => {
      const { scope, workspaceId, userId } = await workspaceFixture("clips-range");
      const project = await clipProject(workspaceId, userId);
      const run = await generationRun(project.id, "bold-pop");
      const source = await sourceClip(project.id, run.id);

      const created = await clipService.createClipFromRange(scope, project.id, range);
      const row = await prisma.clip.findUniqueOrThrow({ where: { id: created.id } });

      expect([row.projectId, row.workflowRunId, row.index, row.status, row.platformFit]).toEqual([project.id, run.id, 1, "edited", []]);
      expect([row.startSec, row.endSec]).toEqual([20, 50]);
      expect(row.captionPreset).toEqual(getCaptionPresetById("bold-pop")!.preset);
      expect(row.captionPreset).not.toEqual(getCaptionPresetById("blast")!.preset);
      expect(studioEditsSchema.parse(row.studioEdits)).toEqual(studioEditsSchema.parse(undefined));
      expect(row.brollUrl).toBeNull();
      expect(row.id).not.toBe(source.id);
    });

    test("starts with the Project's brand music, and leaves the source clip's music alone", async () => {
      const { scope, workspaceId, userId } = await workspaceFixture("clips-brand-music");
      const project = await clipProject(workspaceId, userId);
      const run = await generationRun(project.id, "bold-pop");
      await sourceClip(project.id, run.id);
      const trackId = randomUUID();
      await prisma.project.update({ where: { id: project.id }, data: { brandProfileSnapshot: {
        version: 1, profileId: randomUUID(), profileRevision: 1, name: "Northstar", identity: {}, voice: {}, approvalRule: "none", style: null,
        audio: { music: [{ assetId: trackId, title: "Theme", durationSec: 60 }], sfx: [] },
      } } });

      const created = await clipService.createClipFromRange(scope, project.id, range);
      const edits = studioEditsSchema.parse((await prisma.clip.findUniqueOrThrow({ where: { id: created.id } })).studioEdits);
      expect(edits.music).toEqual({ ...studioEditsSchema.parse(undefined).music, assetId: trackId, title: "Theme", url: null });
    });

    test("the run's default falls back to the Brand Profile style, then the built-in style", async () => {
      const { scope, workspaceId, userId } = await workspaceFixture("clips-brand");
      const project = await clipProject(workspaceId, userId);
      const run = await generationRun(project.id, "brand_default");
      await sourceClip(project.id, run.id);
      const brand = getCaptionPresetById("punch")!.preset;
      await prisma.project.update({ where: { id: project.id }, data: { brandSnapshot: { captionPreset: brand } } });

      const created = await clipService.createClipFromRange(scope, project.id, range);
      expect((await prisma.clip.findUniqueOrThrow({ where: { id: created.id } })).captionPreset).toEqual(brand);
    });

    test("a clip created from a selection keeps the source style but not its timed B-roll", async () => {
      const { scope, workspaceId, userId } = await workspaceFixture("clips-selection");
      const project = await clipProject(workspaceId, userId);
      const run = await generationRun(project.id, "bold-pop");
      const source = await sourceClip(project.id, run.id);

      const created = await clipService.createClipFromSelection(scope, project.id, source.id, range);
      const row = await prisma.clip.findUniqueOrThrow({ where: { id: created.id } });
      const edits = studioEditsSchema.parse(row.studioEdits);
      expect(edits.visualBroll).toEqual([]);
      expect(edits.textLayers).toEqual([]);
      expect(edits.music?.url).toBe("https://example.test/song.mp3");
      expect(edits.sourceAudio).toEqual({ volume: 55, muted: true });
      expect(row.captionPreset).toEqual(getCaptionPresetById("blast")!.preset);
    });

    test("refuses a Project from another Workspace or one that does not exist", async () => {
      const mine = await workspaceFixture("clips-mine");
      const theirs = await workspaceFixture("clips-theirs");
      const project = await clipProject(theirs.workspaceId, theirs.userId);
      const run = await generationRun(project.id, "bold-pop");
      await sourceClip(project.id, run.id);

      for (const projectId of [project.id, randomUUID()]) {
        const refusal = await clipService.createClipFromRange(mine.scope, projectId, range).catch((error) => error);
        expect(refusal).toMatchObject({ code: "project_not_found", kind: "missing" });
      }
      expect(await prisma.clip.count({ where: { projectId: project.id } })).toBe(1);
      // A member of the right Workspace without edit rights is refused as well.
      const viewer = await prisma.user.create({ data: { clerkId: `clip-viewer-${randomUUID()}`, primaryEmail: `clip-viewer-${randomUUID()}@example.test` } });
      await prisma.workspaceMember.create({ data: { workspaceId: theirs.workspaceId, userId: viewer.id, role: "viewer" } });
      const forbidden = await clipService.createClipFromRange({ actorUserId: viewer.id, workspaceId: theirs.workspaceId }, project.id, range).catch((error) => error);
      expect(isExpectedDomainFailure(forbidden)).toBe(true);
      expect(await prisma.clip.count({ where: { projectId: project.id } })).toBe(1);
    });
  });
});
