import { workspaceService } from "./workspace.service";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  DEFAULT_CAPTION_PRESET,
  CLIP_AUTO_LAYOUT_ENGINE,
  CLIP_AUTO_LAYOUT_VERSION,
  captionPresetSchema,
  getCaptionPresetById,
  editorDocumentSchema,
  studioEditsSchema,
  type ClipAutoLayoutAnalysis,
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
import { LayoutEvidenceLifecycle } from "./layout-evidence";

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

  function fixtureActorScope(f: Awaited<ReturnType<typeof fixture>>) {
    return {
      actorUserId: f.user.id,
      workspaceId: f.workspace.id,
    };
  }

  test("caption snapshot migration repairs old styles and preserves current snapshots", async () => {
    const client = await testDatabase.pool.connect();
    try {
      await client.query("BEGIN");
      // Temporary tables shadow the durable tables so this exercises the
      // actual migration without rewriting other tests' immutable fixtures.
      await client.query(`
        CREATE TEMP TABLE "BrandTemplate" ("builtInKey" text, "captionPreset" jsonb) ON COMMIT DROP;
        CREATE TEMP TABLE "Project" ("brandSnapshot" jsonb, "brandProfileSnapshot" jsonb) ON COMMIT DROP;
        CREATE TEMP TABLE "UploadSession" ("brandSnapshot" jsonb, "brandProfileSnapshot" jsonb) ON COMMIT DROP;
        CREATE TEMP TABLE "Clip" ("editorOriginal" jsonb) ON COMMIT DROP;
        CREATE TEMP TABLE "ClipRender" ("clipSnapshot" jsonb) ON COMMIT DROP;
      `);
      const karaoke = getCaptionPresetById("karaoke")!.preset;
      await client.query('INSERT INTO "BrandTemplate" VALUES ($1, $2), ($3, $4)', [
        "karaoke", JSON.stringify(karaoke), "bold-pop", JSON.stringify(DEFAULT_CAPTION_PRESET),
      ]);
      const oldCaption = { ...karaoke, bold: true, shadow: 1, fontSize: 42 };
      const old = { captionPreset: oldCaption, logoStorageKey: "keep/logo.png", clipStartSec: 5 };
      const profile = { profileRevision: 7, style: old };
      const current = { ...old, captionPreset: { ...karaoke, positionX: 32, primaryColor: "#123456" } };
      for (const table of ["Project", "UploadSession"]) {
        await client.query(`INSERT INTO "${table}" VALUES ($1, $2), ($3, NULL), (NULL, NULL)`, [
          JSON.stringify(old), JSON.stringify(profile), JSON.stringify(current),
        ]);
      }
      await client.query('INSERT INTO "Clip" VALUES ($1)', [JSON.stringify({ ...old, captionPreset: { ...oldCaption, animation: "pop" } })]);
      await client.query('INSERT INTO "ClipRender" VALUES ($1)', [JSON.stringify(old)]);
      const sql = readFileSync(new URL("../../db/prisma/migrations/20261005130000_caption_snapshot_contracts/migration.sql", import.meta.url), "utf8");
      await client.query(sql);
      for (const table of ["Project", "UploadSession"]) {
        const rows = (await client.query(`SELECT * FROM "${table}"`)).rows;
        expect(rows).toContainEqual({ brandSnapshot: { ...old, captionPreset: karaoke }, brandProfileSnapshot: { ...profile, style: { ...old, captionPreset: karaoke } } });
        expect(rows).toContainEqual({ brandSnapshot: current, brandProfileSnapshot: null });
        expect(rows).toContainEqual({ brandSnapshot: null, brandProfileSnapshot: null });
      }
      expect((await client.query('SELECT "editorOriginal" FROM "Clip"')).rows[0].editorOriginal)
        .toEqual({ ...old, captionPreset: DEFAULT_CAPTION_PRESET });
      expect((await client.query('SELECT "clipSnapshot" FROM "ClipRender"')).rows[0].clipSnapshot)
        .toEqual({ ...old, captionPreset: karaoke });
      const repeat = await client.query(sql);
      expect(repeat.filter((result) => result.command === "UPDATE").every((result) => result.rowCount === 0)).toBe(true);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  test("non-owner editors save by Workspace scope while viewers and foreign Workspaces cannot write", async () => {
    const f = await fixture();
    const editor = await prisma.user.create({ data: { clerkId: `editor-member:${randomUUID()}` } });
    await prisma.workspaceMember.create({ data: { userId: editor.id, workspaceId: f.workspace.id, role: "editor" } });
    const persistence = createClipEditorDocumentPersistence({
      store: prismaClipEditorDocumentStore,
      authorize: async (scope, capability) => { await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, capability); },
    });
    const scope = { actorUserId: editor.id, workspaceId: f.workspace.id, projectId: f.project.id, clipId: f.clip.id };
    const current = await persistence.readDocument(scope);
    const saved = await persistence.mutateDocument({ ...scope, intent: { kind: "replace", baseRevision: current.revision, document: { ...current.document, brollUrl: "https://example.test/editor.mp4" } } });
    expect(saved.revision).toBe(current.revision + 1);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: f.project.id } })).createdByUserId).toBe(f.user.id);
    await prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: f.workspace.id, userId: editor.id } }, data: { role: "viewer" } });
    await expect(persistence.mutateDocument({ ...scope, intent: { kind: "set_broll_url", brollUrl: null } })).rejects.toMatchObject({ code: "workspace_access_denied" });
    const other = await prisma.workspace.create({ data: { name: "Different editor Workspace", ownerUserId: editor.id, members: { create: { userId: editor.id, role: "owner" } } } });
    await expect(persistence.readDocument({ ...scope, workspaceId: other.id })).rejects.toMatchObject({ code: "clip_not_found" });
    expect((await prisma.clip.findUniqueOrThrow({ where: { id: f.clip.id } })).editorRevision).toBe(saved.revision);
  });

  test("unknown automatic layout evidence is not upgraded or claimed", async () => {
    const f = await fixture();
    const evidence = new LayoutEvidenceLifecycle({ prisma });
    const unknownEvidence = { version: 99, engine: "shot-layout-v99" };
    await prisma.clip.update({
      where: { id: f.clip.id },
      data: { autoLayoutStatus: "completed", autoLayoutAnalysis: unknownEvidence },
    });

    expect(await evidence.claimAutomatic(60_000)).toBeNull();
    const stored = await prisma.clip.findUniqueOrThrow({ where: { id: f.clip.id } });
    expect(stored.autoLayoutStatus).toBe("completed");
    expect(stored.autoLayoutAnalysis).toEqual(unknownEvidence);
    expect(stored.autoLayoutClaimToken).toBeNull();
  });

  test("automatic evidence rejects expired and edited claim owners", async () => {
    const f = await fixture();
    let now = new Date();
    const evidence = new LayoutEvidenceLifecycle({ prisma, now: () => now });
    await prisma.clip.update({
      where: { id: f.clip.id },
      data: { autoLayoutAnalysis: Prisma.DbNull, viralityScore: 100 },
    });
    const claim = await evidence.claimAutomatic(60_000);
    expect(claim?.id).toBe(f.clip.id);
    if (!claim) throw new Error("expected evidence claim");
    const duration = claim.endSec - claim.startSec;
    const segment = { startSec: 0, endSec: duration, layout: "single" as const, cxNorm: 0.5, cyNorm: 0.5, zoom: 1, subjects: [] };
    const analysis: ClipAutoLayoutAnalysis = {
      version: CLIP_AUTO_LAYOUT_VERSION, engine: CLIP_AUTO_LAYOUT_ENGINE,
      sourceIdentity: `source:${f.project.id}`, analyzedAtISO: now.toISOString(),
      clipStartSec: claim.startSec, clipEndSec: claim.endSec,
      deletedRanges: [], editedDurationSec: duration,
      sourceWidth: 1920, sourceHeight: 1080,
      segments: [segment], noSplitSegments: [segment],
      shotCount: 0, soloShotCount: 0, multiShotCount: 0,
      twoUpSegmentCount: 0, speakerCount: 0, mappedSpeakerCount: 0,
    };
    const expected = { editorRevision: claim.editorRevision, previewStorageKey: claim.previewStorageKey, claimToken: claim.autoLayoutClaimToken };
    now = new Date(now.getTime() + 60_001);
    expect(await evidence.completeAutomatic(claim.id, analysis, expected)).toBe(false);
    expect(await evidence.deferAutomatic(claim.id, claim.autoLayoutClaimToken, new Date(now.getTime() + 60_000))).toBe(false);
    const reclaimed = await evidence.claimAutomatic(60_000);
    expect(reclaimed?.id).toBe(claim.id);
    if (!reclaimed) throw new Error("expected reclaimed evidence");
    expect(reclaimed.autoLayoutClaimToken).not.toBe(claim.autoLayoutClaimToken);
    await prisma.clip.update({ where: { id: claim.id }, data: { editorRevision: { increment: 1 } } });
    expect(await evidence.completeAutomatic(claim.id, analysis, { ...expected, claimToken: reclaimed.autoLayoutClaimToken })).toBe(false);
    expect((await prisma.clip.findUniqueOrThrow({ where: { id: claim.id } })).autoLayoutAnalysis).toBeNull();
  });

  test("preview completion rejects a proxy cut before an editor revision", async () => {
    const f = await fixture();
    const evidence = new LayoutEvidenceLifecycle({ prisma });
    await prisma.clip.update({ where: { id: f.clip.id }, data: { previewStorageKey: null, editorRevision: 1 } });
    const input = { storageKey: "test/new-preview.mp4", startSec: 6, durationSec: 28, expectedClipStartSec: f.clip.startSec, expectedClipEndSec: f.clip.endSec, expectedEditorRevision: 0 };
    expect((await evidence.completePreview(f.clip.id, input)).persisted).toBe(false);
    expect((await prisma.clip.findUniqueOrThrow({ where: { id: f.clip.id } })).previewStorageKey).toBeNull();
    expect((await evidence.completePreview(f.clip.id, { ...input, expectedEditorRevision: 1 })).persisted).toBe(true);
  });

  test("document, revision, original, render retirement, and cleanup commit together", async () => {
    const f = await fixture();
    const persistence = createClipEditorDocumentPersistence({ authorize: async (scope, capability) => { await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, capability); },
      store: prismaClipEditorDocumentStore,
    });
    const sceneLayouts = [
      { id: "opening-layout", aspectRatio: "9:16" as const, startSec: 0, endSec: 2, preset: "fit" as const },
      { id: "closing-layout", aspectRatio: "9:16" as const, startSec: 2, endSec: 4, preset: "screen-top-two-circle" as const },
    ];
    const next = editorDocument({
      studioEdits: studioEditsSchema.parse({ sceneLayouts }),
    });
    const result = await persistence.mutateDocument({
      ...fixtureActorScope(f),
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
    expect(studioEditsSchema.parse(clip.studioEdits).sceneLayouts).toEqual(sceneLayouts);
    const reopened = await persistence.readDocument({
      ...fixtureActorScope(f),
      projectId: f.project.id,
      clipId: f.clip.id,
    });
    expect(reopened.document.studioEdits.sceneLayouts).toEqual(sceneLayouts);
    expect(mutableRenderCount).toBe(0);
    expect(obligations.map((item) => item.cleanupClass)).toEqual(["mutable_render"]);
    expect(obligations.map((item) => item.origin)).toEqual([
      "clip_editor_document_persistence",
    ]);
  });

  test("a Workspace editor can save a Clip Editor Document owned by the Workspace owner", async () => {
    const f = await fixture();
    const member = await prisma.user.create({
      data: {
        clerkId: `clip-editor-member:${randomUUID()}`,
        primaryEmail: `clip-editor-member-${randomUUID()}@example.test`,
        workspaceMemberships: {
          create: { workspaceId: f.workspace.id, role: "editor" },
        },
      },
    });
    const persistence = createClipEditorDocumentPersistence({ authorize: async (scope, capability) => { await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, capability); },
      store: prismaClipEditorDocumentStore,
    });

    const result = await persistence.mutateDocument({
      actorUserId: member.id,
      workspaceId: f.workspace.id,
      projectId: f.project.id,
      clipId: f.clip.id,
      intent: {
        kind: "replace",
        baseRevision: 0,
        document: editorDocument({ brollUrl: "https://cdn.example.com/member.mp4" }),
      },
    });

    expect(result).toMatchObject({ revision: 1, noop: false });
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
      fontName: "Anton",
      primaryColor: "#123456",
    };
    const persistence = createClipEditorDocumentPersistence({ authorize: async (scope, capability) => { await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, capability); },
      store: prismaClipEditorDocumentStore,
    });

    const result = await persistence.mutateProjectSelection({
      ...fixtureActorScope(f),
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
        ...fixtureActorScope(f),
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

  test("a Workspace editor can bulk-edit Clip Editor Documents owned by the Workspace owner", async () => {
    const f = await fixture();
    const member = await prisma.user.create({
      data: {
        clerkId: `clip-editor-bulk-member:${randomUUID()}`,
        primaryEmail: `clip-editor-bulk-member-${randomUUID()}@example.test`,
        workspaceMemberships: {
          create: { workspaceId: f.workspace.id, role: "editor" },
        },
      },
    });
    const persistence = createClipEditorDocumentPersistence({ authorize: async (scope, capability) => { await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, capability); },
      store: prismaClipEditorDocumentStore,
    });

    const result = await persistence.mutateProjectSelection({
      actorUserId: member.id,
      workspaceId: f.workspace.id,
      projectId: f.project.id,
      intent: {
        kind: "set_caption_preset",
        captionPreset: { ...DEFAULT_CAPTION_PRESET, fontName: "Anton" },
      },
    });

    expect(result).toEqual({ updated: 1 });
  });

  test("two different full replacements from one revision have one winner", async () => {
    const f = await fixture();
    const persistence = createClipEditorDocumentPersistence({ authorize: async (scope, capability) => { await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, capability); }, store: prismaClipEditorDocumentStore });
    const attempts = await Promise.allSettled([
      persistence.mutateDocument({
        ...fixtureActorScope(f),
        projectId: f.project.id,
        clipId: f.clip.id,
        intent: {
          kind: "replace",
          baseRevision: 0,
          document: editorDocument({ brollUrl: "https://cdn.example.com/a.mp4" }),
        },
      }),
      persistence.mutateDocument({
        ...fixtureActorScope(f),
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
    const persistence = createClipEditorDocumentPersistence({ authorize: async (scope, capability) => { await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, capability); }, store: prismaClipEditorDocumentStore });
    await persistence.mutateDocument({
      ...fixtureActorScope(f),
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
        layoutAnalysis: { version: 1 },
        autoLayoutAnalysis: { version: 1 },
        splitLayoutAnalysis: { version: 1 },
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
      ...fixtureActorScope(f),
      projectId: f.project.id,
      clipId: f.clip.id,
      intent: { kind: "reset", baseRevision: 1 },
    });
    expect(reset).toMatchObject({ revision: 2, document: f.document, noop: false });
    const beforeRetry = await prisma.mediaCleanupObligation.count({
      where: { clipId: f.clip.id },
    });
    const retry = await persistence.mutateDocument({
      ...fixtureActorScope(f),
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
    const persistence = createClipEditorDocumentPersistence({ authorize: async (scope, capability) => { await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, capability); }, store: prismaClipEditorDocumentStore });
    await persistence.mutateDocument({
      ...fixtureActorScope(f),
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
        ...fixtureActorScope(f),
        projectId: f.project.id,
        clipId: f.clip.id,
        intent: { kind: "reset", baseRevision: 1 },
      }),
      persistence.mutateDocument({
        ...fixtureActorScope(f),
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
    const fieldPersistence = createClipEditorDocumentPersistence({ authorize: async (scope, capability) => { await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, capability); }, store: delayingStore });
    const fullPersistence = createClipEditorDocumentPersistence({ authorize: async (scope, capability) => { await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, capability); },
      store: prismaClipEditorDocumentStore,
    });
    const fieldMutation = fieldPersistence.mutateDocument({
      ...fixtureActorScope(f),
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
      ...fixtureActorScope(f),
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
    const bulkPersistence = createClipEditorDocumentPersistence({ authorize: async (scope, capability) => { await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, capability); }, store: delayingStore });
    const singlePersistence = createClipEditorDocumentPersistence({ authorize: async (scope, capability) => { await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, capability); },
      store: prismaClipEditorDocumentStore,
    });
    const captionPreset = { ...DEFAULT_CAPTION_PRESET, fontName: "Anton" };
    const bulk = bulkPersistence.mutateProjectSelection({
      ...fixtureActorScope(f),
      projectId: f.project.id,
      intent: { kind: "set_caption_preset", captionPreset },
    });
    await entered;
    await singlePersistence.mutateDocument({
      ...fixtureActorScope(f),
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
      const persistence = createClipEditorDocumentPersistence({ authorize: async (scope, capability) => { await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, capability); },
        store: prismaClipEditorDocumentStore,
      });
      await expect(
        persistence.mutateDocument({
          ...fixtureActorScope(f),
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
      const persistence = createClipEditorDocumentPersistence({ authorize: async (scope, capability) => { await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, capability); },
        store: prismaClipEditorDocumentStore,
      });
      await expect(
        persistence.mutateProjectSelection({
          ...fixtureActorScope(f),
          projectId: f.project.id,
          intent: {
            kind: "set_caption_preset",
            captionPreset: { ...DEFAULT_CAPTION_PRESET, fontName: "Anton" },
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
    const persistence = createClipEditorDocumentPersistence({ authorize: async (scope, capability) => { await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, capability); },
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
          ...fixtureActorScope(f),
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
