import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { PrismaClient } from "@prisma/client";
import {
  DEFAULT_CAPTION_PRESET,
  captionPresetSchema,
  editorDocumentSchema,
  studioEditsSchema,
} from "@narriflow/validators";
import {
  ClipEditorRevisionConflictError,
  createClipEditorDocumentPersistence,
  prismaClipEditorDocumentStore,
  type ClipEditorDocumentStore,
} from "./clip-editor-document-persistence";
import {
  addClipPersistenceFixtureClip,
  clipPersistenceDbTestEnabled,
  clipPersistenceEditorDocument,
  createClipPersistenceFixture,
  openClipPersistenceTestDatabase,
} from "./clip-persistence-db-test-support";
import { prismaMediaCleanupStore } from "./media-cleanup";
import { ClipService } from "./clip.service";

const dbDescribe = clipPersistenceDbTestEnabled ? describe : describe.skip;

setDefaultTimeout(180_000);

const editorDocument = clipPersistenceEditorDocument;

dbDescribe("Clip Editor Document Persistence PostgreSQL invariants", () => {
  let prisma: PrismaClient;
  let testDatabase: Awaited<ReturnType<typeof openClipPersistenceTestDatabase>>;

  beforeAll(async () => {
    testDatabase = await openClipPersistenceTestDatabase();
    prisma = testDatabase.prisma;
  });

  afterAll(async () => {
    await testDatabase?.close();
  });

  async function fixture() {
    return createClipPersistenceFixture(prisma);
  }

  async function addClip(
    fixtureState: Awaited<ReturnType<typeof fixture>>,
    index: number,
    document: ReturnType<typeof editorDocument>,
  ) {
    return addClipPersistenceFixtureClip(prisma, fixtureState, index, document);
  }

  test("preview candidates decode the complete current editor document", async () => {
    const f = await fixture();
    await prisma.$transaction([
      prisma.project.update({
        where: { id: f.project.id },
        data: { ingestStatus: "ready" },
      }),
      prisma.clip.update({
        where: { id: f.clip.id },
        data: { previewStorageKey: null, previewStartSec: null, previewDurationSec: null },
      }),
    ]);

    const candidates = await new ClipService().getClipsNeedingPreview(10);

    expect(candidates.map((candidate) => candidate.id)).toContain(f.clip.id);
    expect(candidates.find((candidate) => candidate.id === f.clip.id)).toMatchObject({
      startSec: f.document.clipStartSec,
      endSec: f.document.clipEndSec,
    });
  });

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
      prisma.mediaCleanupObligation.findMany({ where: { clipId: f.clip.id } }),
    ]);
    expect(clip.editorRevision).toBe(1);
    expect(editorDocumentSchema.parse(clip.editorOriginal)).toEqual(f.document);
    expect(clip.brollUrl).toBe(next.brollUrl);
    expect(mutableRenderCount).toBe(0);
    expect(obligations.map((item) => item.cleanupClass)).toEqual(["mutable_render"]);
    expect(obligations.map((item) => item.origin)).toEqual([
      "clip_editor_document_persistence",
    ]);
  });

  test("project selection commits every changed document and cleanup obligation atomically", async () => {
    const f = await fixture();
    const secondDocument = editorDocument({
      brollUrl: "https://cdn.example.com/keep.mp4",
      studioEdits: studioEditsSchema.parse({ sourceAudio: { volume: 64 } }),
    });
    const second = await addClip(f, 1, secondDocument);
    const captionPreset = {
      ...DEFAULT_CAPTION_PRESET,
      fontName: "Impact",
      primaryColor: "#123456",
    };
    const persistence = createClipEditorDocumentPersistence({
      store: prismaClipEditorDocumentStore,
    });

    const result = await persistence.mutateProjectSelection({
      actorUserId: f.user.id,
      projectId: f.project.id,
      intent: { kind: "set_caption_preset", captionPreset },
    });
    expect(result).toEqual({ updated: 2 });

    const [clips, renderCount, obligations] = await Promise.all([
      prisma.clip.findMany({
        where: { id: { in: [f.clip.id, second.id] } },
        orderBy: { index: "asc" },
      }),
      prisma.clipRender.count({
        where: { clipId: { in: [f.clip.id, second.id] }, exportVariantId: null },
      }),
      prisma.mediaCleanupObligation.findMany({
        where: { clipId: { in: [f.clip.id, second.id] } },
      }),
    ]);
    expect(clips.map((clip) => clip.editorRevision)).toEqual([1, 1]);
    expect(clips.map((clip) => clip.status)).toEqual(["edited", "edited"]);
    expect(editorDocumentSchema.parse(clips[0]!.editorOriginal)).toEqual(f.document);
    expect(editorDocumentSchema.parse(clips[1]!.editorOriginal)).toEqual(secondDocument);
    expect(clips[1]).toMatchObject({
      brollUrl: secondDocument.brollUrl,
      previewStorageKey: `projects/${f.project.id}/clips/preview-1.mp4`,
      layoutAnalysis: { version: 1 },
      autoLayoutAnalysis: { version: 1 },
      splitLayoutAnalysis: { version: 1 },
    });
    expect(studioEditsSchema.parse(clips[1]!.studioEdits).sourceAudio.volume).toBe(64);
    expect(renderCount).toBe(0);
    expect(obligations).toHaveLength(2);

    await expect(
      persistence.mutateProjectSelection({
        actorUserId: f.user.id,
        projectId: f.project.id,
        intent: { kind: "set_caption_preset", captionPreset },
      }),
    ).resolves.toEqual({ updated: 0 });
    expect(
      await prisma.mediaCleanupObligation.count({
        where: { clipId: { in: [f.clip.id, second.id] } },
      }),
    ).toBe(2);
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
    const beforeRetry = await prisma.mediaCleanupObligation.count({
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
      prisma.mediaCleanupObligation.count({ where: { clipId: f.clip.id } }),
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
      confirmRevision: (scope, revision) =>
        prismaClipEditorDocumentStore.confirmRevision(scope, revision),
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

  test("a project selection race retries the whole selection without losing the winning edit", async () => {
    const f = await fixture();
    const second = await addClip(f, 1, editorDocument());
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
      ...prismaClipEditorDocumentStore,
      async commitProjectSelection(input) {
        if (firstCommit) {
          firstCommit = false;
          announceCommit();
          await gate;
        }
        return prismaClipEditorDocumentStore.commitProjectSelection(input);
      },
    };
    const bulkPersistence = createClipEditorDocumentPersistence({ store: delayingStore });
    const singlePersistence = createClipEditorDocumentPersistence({
      store: prismaClipEditorDocumentStore,
    });
    const captionPreset = { ...DEFAULT_CAPTION_PRESET, fontName: "Impact" };
    const bulk = bulkPersistence.mutateProjectSelection({
      actorUserId: f.user.id,
      projectId: f.project.id,
      intent: { kind: "set_caption_preset", captionPreset },
    });
    await entered;
    await singlePersistence.mutateDocument({
      actorUserId: f.user.id,
      projectId: f.project.id,
      clipId: f.clip.id,
      intent: {
        kind: "set_broll_url",
        brollUrl: "https://cdn.example.com/race-winner.mp4",
      },
    });
    releaseCommit();

    await expect(bulk).resolves.toEqual({ updated: 2 });
    const clips = await prisma.clip.findMany({
      where: { id: { in: [f.clip.id, second.id] } },
      orderBy: { index: "asc" },
    });
    expect(clips.map((clip) => clip.editorRevision)).toEqual([2, 1]);
    expect(clips[0]!.brollUrl).toBe("https://cdn.example.com/race-winner.mp4");
    expect(clips.map((clip) => captionPresetSchema.parse(clip.captionPreset))).toEqual([
      captionPreset,
      captionPreset,
    ]);
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
      BEFORE INSERT ON "MediaCleanupObligation"
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
        `DROP TRIGGER IF EXISTS "fail_editor_cleanup_insert_trigger" ON "MediaCleanupObligation"`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS "fail_editor_cleanup_insert"()`,
      );
    }
    const [clip, renderCount, cleanupCount] = await Promise.all([
      prisma.clip.findUniqueOrThrow({ where: { id: f.clip.id } }),
      prisma.clipRender.count({ where: { clipId: f.clip.id, storageKey: failingKey } }),
      prisma.mediaCleanupObligation.count({ where: { clipId: f.clip.id } }),
    ]);
    expect(clip).toMatchObject({ editorRevision: 0, editorOriginal: null, brollUrl: null });
    expect(renderCount).toBe(1);
    expect(cleanupCount).toBe(0);
  });

  test("a project cleanup-insert failure rolls back every selected clip", async () => {
    const f = await fixture();
    const second = await addClip(f, 1, editorDocument());
    const failingKey = `projects/${f.project.id}/renders/bulk-force-rollback.mp4`;
    await prisma.clipRender.updateMany({
      where: { clipId: second.id, exportVariantId: null },
      data: { storageKey: failingKey },
    });
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "fail_editor_bulk_cleanup_insert"() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."objectKey" LIKE '%/bulk-force-rollback.mp4' THEN
          RAISE EXCEPTION 'injected bulk cleanup failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "fail_editor_bulk_cleanup_insert_trigger"
      BEFORE INSERT ON "MediaCleanupObligation"
      FOR EACH ROW EXECUTE FUNCTION "fail_editor_bulk_cleanup_insert"()
    `);
    try {
      const persistence = createClipEditorDocumentPersistence({
        store: prismaClipEditorDocumentStore,
      });
      await expect(
        persistence.mutateProjectSelection({
          actorUserId: f.user.id,
          projectId: f.project.id,
          intent: {
            kind: "set_caption_preset",
            captionPreset: { ...DEFAULT_CAPTION_PRESET, fontName: "Impact" },
          },
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "fail_editor_bulk_cleanup_insert_trigger" ON "MediaCleanupObligation"`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS "fail_editor_bulk_cleanup_insert"()`,
      );
    }
    const [clips, renderCount, cleanupCount] = await Promise.all([
      prisma.clip.findMany({
        where: { id: { in: [f.clip.id, second.id] } },
        orderBy: { index: "asc" },
      }),
      prisma.clipRender.count({
        where: { clipId: { in: [f.clip.id, second.id] }, exportVariantId: null },
      }),
      prisma.mediaCleanupObligation.count({
        where: { clipId: { in: [f.clip.id, second.id] } },
      }),
    ]);
    expect(clips.map((clip) => clip.editorRevision)).toEqual([0, 0]);
    expect(clips.map((clip) => clip.editorOriginal)).toEqual([null, null]);
    expect(renderCount).toBe(2);
    expect(cleanupCount).toBe(0);
  });

  test("non-null malformed document columns never collapse to defaults", async () => {
    const persistence = createClipEditorDocumentPersistence({
      store: prismaClipEditorDocumentStore,
    });
    for (const column of ["captionPreset", "studioEdits", "deletedRanges"] as const) {
      const f = await fixture();
      if (column === "captionPreset") {
        await prisma.clip.update({
          where: { id: f.clip.id },
          data: { captionPreset: false },
        });
      } else if (column === "studioEdits") {
        await prisma.clip.update({
          where: { id: f.clip.id },
          data: { studioEdits: false },
        });
      } else {
        await prisma.clip.update({
          where: { id: f.clip.id },
          data: { deletedRanges: false },
        });
      }
      await expect(
        persistence.readDocument({
          actorUserId: f.user.id,
          projectId: f.project.id,
          clipId: f.clip.id,
        }),
      ).rejects.toMatchObject({ code: "corrupt_stored_document" });
    }
  });

  test("expired cleanup claims recover and stale settlement cannot win", async () => {
    const f = await fixture();
    const obligation = await prisma.mediaCleanupObligation.create({
      data: {
        origin: "clip_editor_document_persistence",
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
    const [claim] = await prismaMediaCleanupStore.claimDue({
      now,
      limit: 1,
      leaseMs: 30_000,
      createId: () => randomUUID(),
    });
    expect(claim?.id).toBe(obligation.id);
    expect(
      await prismaMediaCleanupStore.complete({
        id: obligation.id,
        claimId: obligation.claimId!,
        now,
      }),
    ).toBe(false);
    expect(
      await prismaMediaCleanupStore.complete({
        id: obligation.id,
        claimId: claim!.claimId,
        now,
      }),
    ).toBe(true);
  });

  test("cleanup meaning and exact object key are unique", async () => {
    const f = await fixture();
    const data = {
      origin: "clip_editor_document_persistence",
      projectId: f.project.id,
      clipId: f.clip.id,
      cleanupClass: "mutable_render",
      objectKey: `private/${randomUUID()}/unique.mp4`,
      nextAttemptAt: new Date("2100-01-01T00:00:00.000Z"),
    };
    await prisma.mediaCleanupObligation.create({ data });

    await expect(
      Promise.resolve(prisma.mediaCleanupObligation.create({ data })),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  test("concurrent claimers cannot own the same obligation", async () => {
    await prisma.mediaCleanupObligation.updateMany({
      where: { completedAt: null },
      data: { nextAttemptAt: new Date("2100-01-01T00:00:00.000Z") },
    });
    const obligation = await prisma.mediaCleanupObligation.create({
      data: {
        origin: "clip_editor_document_persistence",
        cleanupClass: "preview_proxy",
        objectKey: `private/${randomUUID()}/claim.mp4`,
        nextAttemptAt: new Date("2000-01-01T00:00:00.000Z"),
      },
    });
    const now = new Date("2026-08-29T00:01:00.000Z");
    const claims = await Promise.all([
      prismaMediaCleanupStore.claimDue({
        now,
        limit: 1,
        leaseMs: 30_000,
        createId: () => randomUUID(),
      }),
      prismaMediaCleanupStore.claimDue({
        now,
        limit: 1,
        leaseMs: 30_000,
        createId: () => randomUUID(),
      }),
    ]);

    expect(claims.flat().map((claim) => claim.id)).toEqual([obligation.id]);
  });

  test("cleanup obligations survive deletion of their source Clip", async () => {
    const f = await fixture();
    const obligation = await prisma.mediaCleanupObligation.create({
      data: {
        origin: "clip_editor_document_persistence",
        projectId: f.project.id,
        clipId: f.clip.id,
        cleanupClass: "preview_peaks",
        objectKey: `private/${randomUUID()}/preview.peaks.json`,
      },
    });

    await prisma.clip.delete({ where: { id: f.clip.id } });

    await expect(
      Promise.resolve(
        prisma.mediaCleanupObligation.findUniqueOrThrow({
          where: { id: obligation.id },
        }),
      ),
    ).resolves.toMatchObject({
      projectId: f.project.id,
      clipId: f.clip.id,
    });
  });

});
