import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import {
  DEFAULT_CAPTION_PRESET,
  editorDocumentSchema,
  studioEditsSchema,
  type EditorDocument,
} from "@narriflow/validators";
import { Pool } from "pg";
import { encodeClipEditorDocumentForStorage } from "./clip-editor-document-persistence";

const databaseUrl = process.env.CLIP_EDITOR_PERSISTENCE_TEST_DATABASE_URL;
const databaseSchema = process.env.CLIP_EDITOR_PERSISTENCE_TEST_DATABASE_SCHEMA;

export const clipPersistenceDbTestEnabled =
  process.env.ALLOW_CLIP_EDITOR_PERSISTENCE_DB_TESTS === "1" &&
  Boolean(databaseUrl);

function assertSafeDatabase(url: string) {
  const parsed = new URL(url);
  const local =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  const namedTestDatabase = parsed.pathname.toLowerCase().includes("test");
  const isolatedSchema = databaseSchema?.startsWith(
    "clip_editor_persistence_test_",
  );
  if (!local && !namedTestDatabase && !isolatedSchema) {
    throw new Error("Clip persistence DB tests require isolation");
  }
}

export function clipPersistenceEditorDocument(
  overrides: Partial<EditorDocument> = {},
) {
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

export async function openClipPersistenceTestDatabase() {
  if (!databaseUrl) throw new Error("database URL is required");
  assertSafeDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      pool as unknown as ConstructorParameters<typeof PrismaPg>[0],
      databaseSchema ? { schema: databaseSchema } : undefined,
    ),
    transactionOptions: { maxWait: 120_000, timeout: 120_000 },
  });
  const prismaGlobal = globalThis as unknown as {
    narriflowPrismaClient?: PrismaClient;
  };
  const priorPrisma = prismaGlobal.narriflowPrismaClient;
  prismaGlobal.narriflowPrismaClient = prisma;
  return {
    pool,
    prisma,
    async close() {
      prismaGlobal.narriflowPrismaClient = priorPrisma;
      await prisma.$disconnect();
      await pool.end();
    },
  };
}

export async function createClipPersistenceFixture(prisma: PrismaClient) {
  const suffix = randomUUID();
  const user = await prisma.user.create({
    data: {
      clerkId: `clip-editor-persistence-db-test:${suffix}`,
      primaryEmail: `clip-editor-${suffix}@example.test`,
    },
  });
  const workspace = await prisma.workspace.create({
    data: {
      name: "Clip persistence DB test",
      ownerUserId: user.id,
      personalOwnerUserId: user.id,
    },
  });
  const project = await prisma.project.create({
    data: {
      title: "Clip persistence fixture",
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
      idempotencyKey: `clip-persistence:${suffix}`,
      stage: "moment_detection",
      status: "completed",
      lifecycleVersion: 2,
    },
  });
  const document = clipPersistenceEditorDocument();
  const storedDocument = encodeClipEditorDocumentForStorage(
    document,
    project.sourceDurationSeconds,
  );
  const clip = await prisma.clip.create({
    data: {
      projectId: project.id,
      workflowRunId: workflowRun.id,
      index: 0,
      ...storedDocument,
      hookText: "Persistence fixture",
      reasoning: "Fixture",
      category: "hook",
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
  return { user, project, workflowRun, clip, document };
}

export async function addClipPersistenceFixtureClip(
  prisma: PrismaClient,
  fixture: Awaited<ReturnType<typeof createClipPersistenceFixture>>,
  index: number,
  document: EditorDocument,
) {
  const storedDocument = encodeClipEditorDocumentForStorage(
    document,
    fixture.project.sourceDurationSeconds,
  );
  const clip = await prisma.clip.create({
    data: {
      projectId: fixture.project.id,
      workflowRunId: fixture.workflowRun.id,
      index,
      ...storedDocument,
      hookText: `Persistence fixture ${index}`,
      reasoning: "Fixture",
      category: "hook",
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
      previewStorageKey: `projects/${fixture.project.id}/clips/preview-${index}.mp4`,
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
      storageKey: `projects/${fixture.project.id}/renders/current-${index}.mp4`,
    },
  });
  return clip;
}
