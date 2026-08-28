import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  DEFAULT_CAPTION_PRESET,
  editorDocumentSchema,
  studioEditsSchema,
  type EditorDocument,
} from "@narriflow/validators";
import { Pool } from "pg";
import {
  ClipEditorRevisionConflictError,
  createClipEditorDocumentPersistence,
  prismaClipEditorDocumentStore,
  type ClipEditorDocumentStore,
} from "./clip-editor-document-persistence";
import { prismaEditorMediaCleanupStore } from "./editor-media-cleanup";

const databaseUrl = process.env.CLIP_EDITOR_PERSISTENCE_TEST_DATABASE_URL;
const databaseSchema = process.env.CLIP_EDITOR_PERSISTENCE_TEST_DATABASE_SCHEMA;
const enabled =
  process.env.ALLOW_CLIP_EDITOR_PERSISTENCE_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;

setDefaultTimeout(180_000);

function assertSafeDatabase(url: string) {
  const parsed = new URL(url);
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  const namedTestDatabase = parsed.pathname.toLowerCase().includes("test");
  const isolatedSchema = databaseSchema?.startsWith("clip_editor_persistence_test_");
  if (!local && !namedTestDatabase && !isolatedSchema) {
    throw new Error("Clip Editor Document Persistence DB tests require isolation");
  }
}

function editorDocument(overrides: Partial<EditorDocument> = {}) {
  return editorDocumentSchema.parse({
    clipStartSec: 10,
    clipEndSec: 30,
    captionPreset: DEFAULT_CAPTION_PRESET,
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse(undefined),
    brollUrl: null,
    deletedRanges: [],
    ...overrides,
  });
}

dbDescribe("Clip Editor Document Persistence PostgreSQL invariants", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let priorPrisma: PrismaClient | undefined;
  const prismaGlobal = globalThis as unknown as {
    narriflowPrismaClient?: PrismaClient;
  };

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("database URL is required");
    assertSafeDatabase(databaseUrl);
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
    prisma = new PrismaClient({
      adapter: new PrismaPg(pool, databaseSchema ? { schema: databaseSchema } : undefined),
      transactionOptions: { maxWait: 120_000, timeout: 120_000 },
    });
    priorPrisma = prismaGlobal.narriflowPrismaClient;
    prismaGlobal.narriflowPrismaClient = prisma;
  });

  afterAll(async () => {
    prismaGlobal.narriflowPrismaClient = priorPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function fixture() {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: {
        clerkId: `clip-editor-persistence-db-test:${suffix}`,
        primaryEmail: `clip-editor-${suffix}@example.test`,
      },
    });
    const workspace = await prisma.workspace.create({
      data: {
        name: "Clip editor persistence DB test",
        ownerUserId: user.id,
        personalOwnerUserId: user.id,
      },
    });
    const project = await prisma.project.create({
      data: {
        title: "Clip editor persistence fixture",
        sourceMediaUrl: "r2://test/source.mp4",
        sourceStorageKey: `projects/${suffix}/source.mp4`,
        sourceDurationSeconds: 300,
        userId: user.id,
        workspaceId: workspace.id,
        createdByUserId: user.id,
      },
    });
    const workflowRun = await prisma.workflowRun.create({
      data: {
        projectId: project.id,
        idempotencyKey: `clip-editor-persistence:${suffix}`,
        stage: "moment_detection",
        status: "completed",
        lifecycleVersion: 2,
      },
    });
    const document = editorDocument();
    const clip = await prisma.clip.create({
      data: {
        projectId: project.id,
        workflowRunId: workflowRun.id,
        index: 0,
        startSec: document.clipStartSec,
        endSec: document.clipEndSec,
        hookText: "Persistence fixture",
        reasoning: "Fixture",
        category: "hook",
        transcriptSlice: document.transcriptSlice as Prisma.InputJsonValue,
        captionPreset: document.captionPreset as Prisma.InputJsonValue,
        studioEdits: document.studioEdits as Prisma.InputJsonValue,
        deletedRanges: document.deletedRanges as Prisma.InputJsonValue,
        viralityScore: 70,
        hookStrengthScore: 70,
        emotionalIntensityScore: 70,
        pacingScore: 70,
        durationOptimalityScore: 70,
        tiktokScore: 70,
        youtubeScore: 70,
        instagramScore: 70,
        llmProvider: "test",
        llmModel: "test",
        previewStorageKey: `projects/${project.id}/clips/preview.mp4`,
        previewStartSec: 6,
        previewDurationSec: 28,
        layoutAnalysis: { version: 1 },
        autoLayoutAnalysis: { version: 1 },
        splitLayoutAnalysis: { version: 1 },
      },
    });
    await prisma.clipRender.create({
      data: {
        clipId: clip.id,
        aspectRatio: "ratio_9_16",
        status: "completed",
        storageKey: `projects/${project.id}/renders/current.mp4`,
      },
    });
    return { user, project, clip, document };
  }

  test("document, revision, original, render retirement, and cleanup commit together", async () => {
    const f = await fixture();
    const persistence = createClipEditorDocumentPersistence({
      store: prismaClipEditorDocumentStore,
    });
    const next = editorDocument({ brollUrl: "https://cdn.example.com/cutaway.mp4" });
    const result = await persistence.mutateDocument({
      actorUserId: f.user.id,
      projectId: f.project.id,
      clipId: f.clip.id,
      intent: { kind: "replace", baseRevision: 0, document: next },
    });
    expect(result.revision).toBe(1);

    const [clip, mutableRenderCount, obligations] = await Promise.all([
      prisma.clip.findUniqueOrThrow({ where: { id: f.clip.id } }),
      prisma.clipRender.count({ where: { clipId: f.clip.id, exportVariantId: null } }),
      prisma.editorMediaCleanupObligation.findMany({ where: { clipId: f.clip.id } }),
    ]);
    expect(clip.editorRevision).toBe(1);
    expect(editorDocumentSchema.parse(clip.editorOriginal)).toEqual(f.document);
    expect(clip.brollUrl).toBe(next.brollUrl);
    expect(mutableRenderCount).toBe(0);
    expect(obligations.map((item) => item.cleanupClass)).toEqual(["mutable_render"]);
  });

  test("two different full replacements from one revision have one winner", async () => {
    const f = await fixture();
    const persistence = createClipEditorDocumentPersistence({ store: prismaClipEditorDocumentStore });
    const attempts = await Promise.allSettled([
      persistence.mutateDocument({
        actorUserId: f.user.id,
        projectId: f.project.id,
        clipId: f.clip.id,
        intent: {
          kind: "replace",
          baseRevision: 0,
          document: editorDocument({ brollUrl: "https://cdn.example.com/a.mp4" }),
        },
      }),
      persistence.mutateDocument({
        actorUserId: f.user.id,
        projectId: f.project.id,
        clipId: f.clip.id,
        intent: {
          kind: "replace",
          baseRevision: 0,
          document: editorDocument({ brollUrl: "https://cdn.example.com/b.mp4" }),
        },
      }),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      ClipEditorRevisionConflictError,
    );
    expect((await prisma.clip.findUniqueOrThrow({ where: { id: f.clip.id } })).editorRevision).toBe(1);
  });

  test("boundary-changing Reset settles once, keeps the original immutable, and retries as a no-op", async () => {
    const f = await fixture();
    const persistence = createClipEditorDocumentPersistence({ store: prismaClipEditorDocumentStore });
    await persistence.mutateDocument({
      actorUserId: f.user.id,
      projectId: f.project.id,
      clipId: f.clip.id,
      intent: {
        kind: "replace",
        baseRevision: 0,
        document: editorDocument({
          clipStartSec: 12,
          clipEndSec: 32,
          brollUrl: "https://cdn.example.com/edited.mp4",
        }),
      },
    });
    await prisma.clip.update({
      where: { id: f.clip.id },
      data: {
        previewStorageKey: `projects/${f.project.id}/clips/rebuilt-preview.mp4`,
        previewStartSec: 8,
        previewDurationSec: 28,
        layoutAnalysis: { version: 2 },
        autoLayoutAnalysis: { version: 2 },
        splitLayoutAnalysis: { version: 2 },
      },
    });
    await prisma.clipRender.create({
      data: {
        clipId: f.clip.id,
        aspectRatio: "ratio_9_16",
        status: "completed",
        storageKey: `projects/${f.project.id}/renders/after-edit.mp4`,
      },
    });

    const reset = await persistence.mutateDocument({
      actorUserId: f.user.id,
      projectId: f.project.id,
      clipId: f.clip.id,
      intent: { kind: "reset", baseRevision: 1 },
    });
    expect(reset).toMatchObject({ revision: 2, document: f.document, noop: false });
    const beforeRetry = await prisma.editorMediaCleanupObligation.count({
      where: { clipId: f.clip.id },
    });
    const retry = await persistence.mutateDocument({
      actorUserId: f.user.id,
      projectId: f.project.id,
      clipId: f.clip.id,
      intent: { kind: "reset", baseRevision: 1 },
    });
    expect(retry).toMatchObject({ revision: 2, noop: true });

    const [clip, mutableRenders, cleanupCount] = await Promise.all([
      prisma.clip.findUniqueOrThrow({ where: { id: f.clip.id } }),
      prisma.clipRender.count({ where: { clipId: f.clip.id, exportVariantId: null } }),
      prisma.editorMediaCleanupObligation.count({ where: { clipId: f.clip.id } }),
    ]);
    expect(editorDocumentSchema.parse(clip.editorOriginal)).toEqual(f.document);
    expect(clip).toMatchObject({
      editorRevision: 2,
      startSec: f.document.clipStartSec,
      endSec: f.document.clipEndSec,
      previewStorageKey: null,
      layoutAnalysis: null,
      autoLayoutAnalysis: null,
      splitLayoutAnalysis: null,
    });
    expect(mutableRenders).toBe(0);
    expect(cleanupCount).toBe(beforeRetry);
  });

  test("Reset racing another full replacement has one revision winner", async () => {
    const f = await fixture();
    const persistence = createClipEditorDocumentPersistence({ store: prismaClipEditorDocumentStore });
    await persistence.mutateDocument({
      actorUserId: f.user.id,
      projectId: f.project.id,
      clipId: f.clip.id,
      intent: {
        kind: "replace",
        baseRevision: 0,
        document: editorDocument({ brollUrl: "https://cdn.example.com/first.mp4" }),
      },
    });
    const attempts = await Promise.allSettled([
      persistence.mutateDocument({
        actorUserId: f.user.id,
        projectId: f.project.id,
        clipId: f.clip.id,
        intent: { kind: "reset", baseRevision: 1 },
      }),
      persistence.mutateDocument({
        actorUserId: f.user.id,
        projectId: f.project.id,
        clipId: f.clip.id,
        intent: {
          kind: "replace",
          baseRevision: 1,
          document: editorDocument({ brollUrl: "https://cdn.example.com/second.mp4" }),
        },
      }),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    const clip = await prisma.clip.findUniqueOrThrow({ where: { id: f.clip.id } });
    expect(clip.editorRevision).toBe(2);
    expect(editorDocumentSchema.parse(clip.editorOriginal)).toEqual(f.document);
  });

  test("a field intent losing a CAS race rebases without dropping full-save fields", async () => {
    const f = await fixture();
    let releaseCommit!: () => void;
    let announceCommit!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      announceCommit = resolve;
    });
    let firstCommit = true;
    const delayingStore: ClipEditorDocumentStore = {
      read: (scope) => prismaClipEditorDocumentStore.read(scope),
      async commit(input) {
        if (firstCommit) {
          firstCommit = false;
          announceCommit();
          await gate;
        }
        return prismaClipEditorDocumentStore.commit(input);
      },
    };
    const fieldPersistence = createClipEditorDocumentPersistence({ store: delayingStore });
    const fullPersistence = createClipEditorDocumentPersistence({
      store: prismaClipEditorDocumentStore,
    });
    const fieldMutation = fieldPersistence.mutateDocument({
      actorUserId: f.user.id,
      projectId: f.project.id,
      clipId: f.clip.id,
      intent: {
        kind: "set_transcript",
        transcriptSlice: [
          {
            index: 0,
            speaker: 0,
            speakerLabel: "Speaker A",
            startSec: 10,
            endSec: 11,
            text: "racing words",
            confidence: null,
            words: [
              {
                word: "racing",
                startSec: 10,
                endSec: 10.5,
                confidence: null,
              },
              {
                word: "words",
                startSec: 10.5,
                endSec: 11,
                confidence: null,
              },
            ],
          },
        ],
      },
    });
    await entered;
    await fullPersistence.mutateDocument({
      actorUserId: f.user.id,
      projectId: f.project.id,
      clipId: f.clip.id,
      intent: {
        kind: "replace",
        baseRevision: 0,
        document: editorDocument({ brollUrl: "https://cdn.example.com/race-winner.mp4" }),
      },
    });
    releaseCommit();
    const fieldResult = await fieldMutation;
    expect(fieldResult.revision).toBe(2);
    const clip = await prisma.clip.findUniqueOrThrow({ where: { id: f.clip.id } });
    expect(clip.editorRevision).toBe(2);
    expect(clip.brollUrl).toBe("https://cdn.example.com/race-winner.mp4");
    expect(clip.transcriptSlice).toMatchObject([{ text: "racing words" }]);
  });

  test("an injected cleanup-insert failure rolls back every document side effect", async () => {
    const f = await fixture();
    const failingKey = `projects/${f.project.id}/renders/force-rollback.mp4`;
    await prisma.clipRender.updateMany({
      where: { clipId: f.clip.id, exportVariantId: null },
      data: { storageKey: failingKey },
    });
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "fail_editor_cleanup_insert"() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."objectKey" LIKE '%/force-rollback.mp4' THEN
          RAISE EXCEPTION 'injected cleanup failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "fail_editor_cleanup_insert_trigger"
      BEFORE INSERT ON "EditorMediaCleanupObligation"
      FOR EACH ROW EXECUTE FUNCTION "fail_editor_cleanup_insert"()
    `);
    try {
      const persistence = createClipEditorDocumentPersistence({
        store: prismaClipEditorDocumentStore,
      });
      await expect(
        persistence.mutateDocument({
          actorUserId: f.user.id,
          projectId: f.project.id,
          clipId: f.clip.id,
          intent: {
            kind: "replace",
            baseRevision: 0,
            document: editorDocument({ brollUrl: "https://cdn.example.com/fail.mp4" }),
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "fail_editor_cleanup_insert_trigger" ON "EditorMediaCleanupObligation"`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS "fail_editor_cleanup_insert"()`,
      );
    }
    const [clip, renderCount, cleanupCount] = await Promise.all([
      prisma.clip.findUniqueOrThrow({ where: { id: f.clip.id } }),
      prisma.clipRender.count({ where: { clipId: f.clip.id, storageKey: failingKey } }),
      prisma.editorMediaCleanupObligation.count({ where: { clipId: f.clip.id } }),
    ]);
    expect(clip).toMatchObject({ editorRevision: 0, editorOriginal: null, brollUrl: null });
    expect(renderCount).toBe(1);
    expect(cleanupCount).toBe(0);
  });

  test("expired cleanup claims recover and stale settlement cannot win", async () => {
    const f = await fixture();
    const obligation = await prisma.editorMediaCleanupObligation.create({
      data: {
        projectId: f.project.id,
        clipId: f.clip.id,
        cleanupClass: "mutable_render",
        objectKey: `projects/${f.project.id}/renders/expired.mp4`,
        nextAttemptAt: new Date("2000-01-01T00:00:00.000Z"),
        claimId: randomUUID(),
        claimExpiresAt: new Date("2026-08-29T00:00:00.000Z"),
      },
    });
    const now = new Date("2026-08-29T00:01:00.000Z");
    const [claim] = await prismaEditorMediaCleanupStore.claimDue({
      now,
      limit: 1,
      leaseMs: 30_000,
      createId: () => randomUUID(),
    });
    expect(claim?.id).toBe(obligation.id);
    expect(
      await prismaEditorMediaCleanupStore.complete({
        id: obligation.id,
        claimId: obligation.claimId!,
        now,
      }),
    ).toBe(false);
    expect(
      await prismaEditorMediaCleanupStore.complete({
        id: obligation.id,
        claimId: claim!.claimId,
        now,
      }),
    ).toBe(true);
  });
});
