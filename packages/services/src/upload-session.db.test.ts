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
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import {
  createUploadSessionModule,
  defaultUploadSessionConfig,
  prismaUploadSessionPersistence,
  type UploadSessionStorage,
} from "./upload-session.service";

const databaseUrl = process.env.UPLOAD_SESSION_TEST_DATABASE_URL;
const databaseSchema = process.env.UPLOAD_SESSION_TEST_DATABASE_SCHEMA;
const enabled =
  process.env.ALLOW_UPLOAD_SESSION_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;

setDefaultTimeout(180_000);

function assertSafeDatabase(url: string) {
  const parsed = new URL(url);
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  const namedTestDatabase = parsed.pathname.toLowerCase().includes("test");
  const isolatedSchema = databaseSchema?.startsWith("upload_session_test_");
  if (!local && !namedTestDatabase && !isolatedSchema) {
    throw new Error("Upload Session DB tests require an isolated test database");
  }
}

const CONTENT_PACK = {
  outputTypes: ["short_clip"],
  clipGenerationMode: "best",
  clipCountTarget: 10,
  clipDurationSecTarget: 45,
  minDurationSec: 15,
  preferredMinDurationSec: 30,
  preferredMaxDurationSec: 60,
  maxDurationSec: 90,
  platformTargets: ["tiktok", "youtube_shorts", "instagram_reels"],
  autoRenderClips: false,
  toneConstraints: ["concise", "conversational"],
  captionPreset: "brand_default",
  platformPlaybookVersion: "2026-07-01",
  mode: "clip",
  autoHook: true,
  specificMoments: "",
  processingStartSec: null,
  processingEndSec: null,
  clipLengthPreset: "auto",
  defaultAspectRatio: "9:16",
};

dbDescribe("Upload Session PostgreSQL invariants", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let priorPrisma: PrismaClient | undefined;
  const prismaGlobal = globalThis as unknown as {
    narriflowPrismaClient?: PrismaClient;
  };

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("UPLOAD_SESSION_TEST_DATABASE_URL is required");
    assertSafeDatabase(databaseUrl);
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
    prisma = new PrismaClient({
      adapter: new PrismaPg(
        pool,
        databaseSchema ? { schema: databaseSchema } : undefined,
      ),
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

  test("concurrent open and finalize produce one session and one atomic handoff", async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: {
        clerkId: `upload-session-db-test:${suffix}`,
        primaryEmail: `upload-${suffix}@example.test`,
      },
    });
    const workspace = await prisma.workspace.create({
      data: {
        name: "Upload Session DB test",
        ownerUserId: user.id,
        personalOwnerUserId: user.id,
      },
    });
    const object = { sizeBytes: 2_048, contentType: "video/mp4" };
    let objectUploaded = false;
    const storage: UploadSessionStorage = {
      async grantSinglePut() {
        return { url: "https://upload.invalid/direct" };
      },
      async createMultipart() {
        throw new Error("multipart must not be used");
      },
      async grantMultipartParts() {
        throw new Error("multipart must not be used");
      },
      async completeMultipart() {
        throw new Error("multipart must not be used");
      },
      async listMultipartParts() {
        throw new Error("multipart must not be used");
      },
      async headExactObject() {
        return object;
      },
      async headExactObjectIfExists() {
        return objectUploaded ? object : null;
      },
      async listExactKeyMultipartUploads() {
        throw new Error("multipart must not be used");
      },
      async abortMultipart() {
        throw new Error("multipart must not be used");
      },
      async deleteExactObject() {},
    };
    const module = createUploadSessionModule({
      config: defaultUploadSessionConfig(),
      persistence: prismaUploadSessionPersistence,
      storage,
      admission: {
        async assertQuota() {},
        async resolveBrand() {
          return null;
        },
      },
      now: () => new Date(),
      createId: randomUUID,
    });
    const input = {
      actorUserId: user.id,
      workspaceId: workspace.id,
      legacyOwnerUserId: user.id,
      clientIdempotencyKey: randomUUID(),
      title: "Exactly once",
      source: {
        fileName: "exactly-once.mp4",
        sizeBytes: object.sizeBytes,
        contentType: object.contentType,
        browserFingerprint: '["exactly-once.mp4",2048,"video/mp4",1]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    };

    const [firstOpen, secondOpen] = await Promise.all([
      module.open(input),
      module.open(input),
    ]);
    expect(secondOpen.sessionId).toBe(firstOpen.sessionId);
    expect(
      await prisma.uploadSession.count({
        where: {
          workspaceId: workspace.id,
          clientIdempotencyKey: input.clientIdempotencyKey,
        },
      }),
    ).toBe(1);

    const finalizeInput = {
      actorUserId: user.id,
      workspaceId: workspace.id,
      sessionId: firstOpen.sessionId,
      parts: [],
    };
    objectUploaded = true;
    const [firstFinalize, secondFinalize] = await Promise.all([
      module.finalize(finalizeInput),
      module.finalize(finalizeInput),
    ]);

    expect(secondFinalize).toEqual(firstFinalize);
    expect(
      await prisma.project.count({
        where: { id: firstOpen.projectId, workspaceId: workspace.id },
      }),
    ).toBe(1);
    expect(
      await prisma.contentPack.count({ where: { projectId: firstOpen.projectId } }),
    ).toBe(1);
    expect(
      await prisma.ingestJob.count({
        where: { uploadSessionId: firstOpen.sessionId },
      }),
    ).toBe(1);
    expect(
      await prisma.workflowEvent.count({
        where: { projectId: firstOpen.projectId, seq: 1 },
      }),
    ).toBe(1);
  });
});
