import { bindServiceTestEnvironment } from "./runtime-test-support";
import { createDatabaseTestContext } from "@narriflow/db/testing";
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
import { LibrarySearch } from "./library-search";
import { createLibraryIndex, queueLibraryIndex } from "./library-index";
import { librarySearchService } from "./library-search-runtime";
import { projectsCommands } from "./projects-commands-runtime";
import { workspaceLibraryService } from "./workspace-library.service";
import {
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
  const prismaGlobal = createDatabaseTestContext();
  let priorPrisma: PrismaClient | undefined;
  let library: LibrarySearch;

  beforeAll(bindServiceTestEnvironment(prismaGlobal.bind(() => {
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, databaseSchema ? { schema: databaseSchema } : undefined) });
    // The services under test (membership checks, clips) read the shared client.
    priorPrisma = prismaGlobal.client;
    prismaGlobal.client = prisma;
    library = new LibrarySearch({ prisma, embeddings: embeddings.provider, log: (entry) => logs.push(entry) });
  })));

  afterAll(bindServiceTestEnvironment(prismaGlobal.bind(async () => {
    prismaGlobal.client = priorPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  })));

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
    await indexTranscript(transcript.id);
    return { projectId: created.id, transcriptId: transcript.id };
  }

  async function indexTranscript(id: string) {
    const driver = createLibraryIndex({ database: prisma, embeddings: embeddings.provider,
      register: async () => {}, log: entry => logs.push(entry) });
    let reference = await prisma.$transaction(tx => queueLibraryIndex(tx, id));
    for (let step = 0; reference; step++) {
      if (step >= 100) throw Error("Fixture indexing did not finish");
      const result = await driver.run(reference);
      if (result.kind !== "complete") throw Error(`Fixture indexing failed: ${result.kind}`);
      reference = await prisma.$transaction(tx => queueLibraryIndex(tx, id));
    }
  }

  async function passageCount(transcriptId: string) {
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM "TranscriptPassage" WHERE "transcriptId" = ${transcriptId}::uuid`;
    return rows[0]!.count;
  }

  describe("Workspace isolation", () => {
    test("never returns another Workspace's passages, including by project filter", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
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
    })));

    test("does not trust a stale denormalized workspaceId on a passage", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const first = await workspaceFixture("stale-first");
      const second = await workspaceFixture("stale-second");
      const moved = await indexedProject(first.workspaceId, "Moved episode", ["The hiring interview went well"]);
      // The passage claims the second Workspace, but its Project belongs to the first.
      await prisma.$executeRaw`UPDATE "TranscriptPassage" SET "workspaceId" = ${second.workspaceId}::uuid WHERE "projectId" = ${moved.projectId}::uuid`;
      expect(await library.search(second.scope, { query: "hiring interview" })).toEqual([]);
      expect(await library.search(first.scope, { query: "hiring interview" })).toEqual([]);
    })));

    test("only Projects the actor can view: purging and expired Projects are excluded", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { scope, workspaceId } = await workspaceFixture("access");
      const live = await indexedProject(workspaceId, "Live", ["Dough needs a hot oven"]);
      const later = await indexedProject(workspaceId, "Expires later", ["Dough rests before the oven"], { expiresAt: new Date(Date.now() + 86_400_000) });
      await indexedProject(workspaceId, "Purging", ["Dough in the oven during purge"], { purgeStartedAt: new Date() });
      await indexedProject(workspaceId, "Expired", ["Dough and oven after expiry"], { expiresAt: new Date(Date.now() - 1_000) });

      const results = await library.search(scope, { query: "dough oven" });
      expect(results.map((result) => result.projectTitle).sort()).toEqual(["Expires later", "Live"]);
      expect(results.map((result) => result.projectId).sort()).toEqual([live.projectId, later.projectId].sort());
    })));

    test("deleting a Project removes its passages", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { scope, workspaceId } = await workspaceFixture("cascade");
      const doomed = await indexedProject(workspaceId, "Doomed", ["Recruit the best candidate"]);
      expect(await passageCount(doomed.transcriptId)).toBe(1);
      await prisma.project.delete({ where: { id: doomed.projectId } });
      expect(await passageCount(doomed.transcriptId)).toBe(0);
      expect(await library.search(scope, { query: "recruit candidate" })).toEqual([]);
    })));
  });

  describe("hybrid ranking", () => {
    test("ranks a passage that matches both meaning and words above those matching only one", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
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
    })));

    test("finds exact words that a semantic search alone would bury", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { scope, workspaceId } = await workspaceFixture("exact");
      await indexedProject(workspaceId, "Show notes", [
        "The pricing page and subscription cost were debated",
        "We hire slowly and interview every candidate",
        "Our codename was Zanzibar for the recipe oven launch", // far from any meaning in the query
      ]);
      const [top] = await library.search(scope, { query: "Zanzibar" });
      expect(top?.text).toBe("Our codename was Zanzibar for the recipe oven launch");
    })));

    test("respects the limit and the project filter", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { scope, workspaceId } = await workspaceFixture("limit");
      const a = await indexedProject(workspaceId, "A", ["subscription price one", "subscription price two", "subscription price three"]);
      const b = await indexedProject(workspaceId, "B", ["subscription price four"]);
      expect(await library.search(scope, { query: "subscription price", limit: 2 })).toHaveLength(2);
      const onlyB = await library.search(scope, { query: "subscription price", projectIds: [b.projectId] });
      expect(onlyB.map((result) => result.projectId)).toEqual([b.projectId]);
      expect((await library.search(scope, { query: "subscription price", projectIds: [a.projectId], limit: 25 })).length).toBe(3);
    })));

    test("a query of only stop words and punctuation still returns by meaning", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { scope, workspaceId } = await workspaceFixture("stopwords");
      await indexedProject(workspaceId, "Quiet", ["subscription price talk"]);
      expect((await library.search(scope, { query: "the of and" })).length).toBe(1);
    })));
  });

  describe("access through the service", () => {
    test("admits a member who can view content and refuses a non-member", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
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
    })));
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

    test("a Project without clips has nothing to join and is refused with a conflict", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { scope, workspaceId, userId } = await workspaceFixture("clips-none");
      const project = await clipProject(workspaceId, userId);
      const refusal = await clipService.createClipFromRange(scope, project.id, range).catch((error) => error);
      expect(refusal).toMatchObject({ code: "clip_source_missing", kind: "conflict" });
      expect(await prisma.clip.count({ where: { projectId: project.id } })).toBe(0);
    })));

    test("starts from the run's defaults and copies nothing from the source clip's look", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
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
    })));

    test("starts with the Project's brand music, and leaves the source clip's music alone", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
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
    })));

    test("the run's default falls back to the Brand Profile style, then the built-in style", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const { scope, workspaceId, userId } = await workspaceFixture("clips-brand");
      const project = await clipProject(workspaceId, userId);
      const run = await generationRun(project.id, "brand_default");
      await sourceClip(project.id, run.id);
      const brand = getCaptionPresetById("punch")!.preset;
      await prisma.project.update({ where: { id: project.id }, data: { brandSnapshot: { captionPreset: brand } } });

      const created = await clipService.createClipFromRange(scope, project.id, range);
      expect((await prisma.clip.findUniqueOrThrow({ where: { id: created.id } })).captionPreset).toEqual(brand);
    })));

    test("a clip created from a selection keeps the source style but not its timed B-roll", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
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
    })));

    test("refuses a Project from another Workspace or one that does not exist", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
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
    })));
  });
  describe("Folder names", () => {
    test("a name is unique per Workspace regardless of case or spacing, on create, rename and the receipt-backed create", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const mine = await workspaceFixture("folders-mine");
      const other = await workspaceFixture("folders-other");
      const taken = { code: "workspace_folder_name_taken", kind: "conflict" };

      const launch = await workspaceLibraryService.createFolder(mine.scope, "Launch");
      expect(await workspaceLibraryService.createFolder(mine.scope, " launch ").catch((error) => error)).toMatchObject(taken);
      expect(await workspaceLibraryService.createFolder(mine.scope, "LAUNCH").catch((error) => error)).toMatchObject(taken);
      expect(await projectsCommands.createFolder(mine.scope, "launch", { clientIdempotencyKey: randomUUID() }).catch((error) => error)).toMatchObject(taken);
      // Another Workspace may reuse the name.
      await workspaceLibraryService.createFolder(other.scope, "Launch");

      const second = await workspaceLibraryService.createFolder(mine.scope, "Teasers");
      expect(await workspaceLibraryService.renameFolder(mine.scope, second.id, "launch").catch((error) => error)).toMatchObject(taken);
      // Renaming a folder to its own name in another case is not a conflict.
      await workspaceLibraryService.renameFolder(mine.scope, launch.id, "LAUNCH");
      expect((await prisma.workspaceFolder.findUniqueOrThrow({ where: { id: launch.id } })).name).toBe("LAUNCH");
      expect(await prisma.workspaceFolder.count({ where: { workspaceId: mine.workspaceId } })).toBe(2);
    })));

    test("replaying a successful create still replays, and the same key keeps its original folder", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
      const mine = await workspaceFixture("folders-replay");
      const key = randomUUID();
      const first = await projectsCommands.createFolder(mine.scope, "Replay", { clientIdempotencyKey: key });
      const replay = await projectsCommands.createFolder(mine.scope, "Replay", { clientIdempotencyKey: key });
      expect(replay).toEqual({ folder: first.folder, replayed: true });
      const clash = await projectsCommands.createFolder(mine.scope, "replay", { clientIdempotencyKey: randomUUID() }).catch((error) => error);
      expect(clash).toMatchObject({ code: "workspace_folder_name_taken" });
    })));
  });
});
