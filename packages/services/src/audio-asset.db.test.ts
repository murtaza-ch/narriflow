import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { AUDIO_UPLOAD_MAX_BYTES } from "@narriflow/validators";
import { AudioAssetError, AudioAssetService } from "./audio-asset.service";

const databaseUrl = process.env.AUDIO_ASSET_TEST_DATABASE_URL;
const dbDescribe = databaseUrl ? describe : describe.skip;

dbDescribe("Audio library PostgreSQL contracts", () => {
  const schema = `audio_asset_test_${randomUUID().replaceAll("-", "")}`;
  const prismaGlobal = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };
  let priorPrisma: PrismaClient | undefined;
  let priorDatabaseUrl: string | undefined;
  let pool: Pool;
  let prisma: PrismaClient;
  let userId: string;
  let workspaceId: string;
  const storage = {
    headObject: mock(async (_key: string) => ({ contentType: "audio/mpeg" as string | null, sizeBytes: 128 as number | null, etag: null, metadata: {} })),
    presignDownloadUrl: mock(async ({ key }: { key: string }) => `https://audio.example.test/${key}`),
    presignSingleUploadUrl: mock(async () => "https://upload.example.test/audio"),
    isR2Configured: () => true,
    deleteObject: mock(async (key: string) => ({ key })),
  };
  const service = new AudioAssetService(storage);
  const scope = () => ({ workspaceId, actorUserId: userId });
  const upload = () => ({ key: `workspaces/${workspaceId}/audio-assets/${randomUUID()}.mp3`, kind: "music" as const, title: "My track", durationSec: 12 });

  beforeAll(async () => {
    if (!databaseUrl || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(databaseUrl).hostname)) {
      throw new Error("Audio tests require throwaway local PostgreSQL");
    }
    pool = new Pool({ connectionString: databaseUrl, options: `-csearch_path=${schema},public` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const migrations = resolve(import.meta.dir, "../../db/prisma/migrations");
    for (const name of readdirSync(migrations).sort()) {
      if (!/^\d/.test(name)) continue;
      await pool.query(readFileSync(resolve(migrations, name, "migration.sql"), "utf8"));
    }
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
    priorPrisma = prismaGlobal.narriflowPrismaClient;
    priorDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl;
    prismaGlobal.narriflowPrismaClient = prisma;
  }, 120_000);

  beforeEach(async () => {
    storage.headObject.mockReset();
    storage.headObject.mockImplementation(async () => ({ contentType: "audio/mpeg", sizeBytes: 128, etag: null, metadata: {} }));
    storage.presignDownloadUrl.mockClear();
    const user = await prisma.user.create({ data: { clerkId: `audio-${randomUUID()}`, primaryEmail: `${randomUUID()}@example.test` } });
    userId = user.id;
    workspaceId = (await prisma.workspace.create({ data: { name: "Audio tests", ownerUserId: userId } })).id;
  });

  afterEach(async () => {
    await prisma.audioAssetFavorite.deleteMany();
    await prisma.audioAsset.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    prismaGlobal.narriflowPrismaClient = priorPrisma;
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    await prisma?.$disconnect();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });

  test("finalize refuses an absent object and creates no library row", async () => {
    storage.headObject.mockRejectedValue(Object.assign(new Error("Missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } }));
    const input = upload();
    const error = await service.finalizeUpload(userId, input, scope()).catch((error) => error);
    expect(error).toBeInstanceOf(AudioAssetError);
    expect(error.code).toBe("audio_asset_object_missing");
    expect(await prisma.audioAsset.count()).toBe(0);
  });

  test.each([null, 0, -1, 1.5, AUDIO_UPLOAD_MAX_BYTES + 1])("finalize refuses invalid stored size %s", async (sizeBytes) => {
    storage.headObject.mockResolvedValue({ contentType: "audio/mpeg", sizeBytes, etag: null, metadata: {} });
    const error = await service.finalizeUpload(userId, upload(), scope()).catch((error) => error);
    expect(error).toBeInstanceOf(AudioAssetError);
    expect(error.code).toBe("audio_asset_size_invalid");
    expect(await prisma.audioAsset.count()).toBe(0);
  });

  test("finalize refuses an object whose stored size differs from the declared size", async () => {
    const error = await service.finalizeUpload(userId, { ...upload(), sizeBytes: 129 }, scope()).catch((error) => error);
    expect(error).toBeInstanceOf(AudioAssetError);
    expect(error.code).toBe("audio_asset_size_mismatch");
    expect(await prisma.audioAsset.count()).toBe(0);
  });

  test.each([null, "application/octet-stream", "video/mp4", "text/plain"])("finalize refuses unsupported stored MIME %s", async (contentType) => {
    storage.headObject.mockResolvedValue({ contentType, sizeBytes: 128, etag: null, metadata: {} });
    const error = await service.finalizeUpload(userId, upload(), scope()).catch((error) => error);
    expect(error).toBeInstanceOf(AudioAssetError);
    expect(error.code).toBe("audio_asset_mime_invalid");
    expect(await prisma.audioAsset.count()).toBe(0);
  });

  test("a storage outage is typed and creates no row", async () => {
    storage.headObject.mockRejectedValue(new Error("provider detail must not escape"));
    const error = await service.finalizeUpload(userId, upload(), scope()).catch((error) => error);
    expect(error).toBeInstanceOf(AudioAssetError);
    expect(error.code).toBe("audio_asset_storage_unavailable");
    expect(error.message).not.toContain("provider detail");
    expect(await prisma.audioAsset.count()).toBe(0);
  });

  test.each(["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/x-m4a"])("finalize accepts verified %s and replays without probing again", async (contentType) => {
    storage.headObject.mockResolvedValue({ contentType, sizeBytes: 128, etag: null, metadata: {} });
    const input = { ...upload(), sizeBytes: 128 };
    const first = await service.finalizeUpload(userId, input, scope());
    storage.headObject.mockRejectedValue(new Error("Storage unavailable on replay"));
    const replay = await service.finalizeUpload(userId, input, scope());
    expect(replay).toEqual(first);
    expect(await prisma.audioAsset.count()).toBe(1);
  });

  test("concurrent finalizes return the same verified asset", async () => {
    const input = upload();
    const rows = await Promise.all(Array.from({ length: 3 }, () => service.finalizeUpload(userId, input, scope())));
    expect(new Set(rows.map((row) => row.id)).size).toBe(1);
    expect(await prisma.audioAsset.count()).toBe(1);
  });

  test("finalize accepts the 50MB boundary and supports user-owned keys", async () => {
    storage.headObject.mockResolvedValue({ contentType: "audio/mpeg", sizeBytes: AUDIO_UPLOAD_MAX_BYTES, etag: null, metadata: {} });
    const input = { ...upload(), key: `audio-assets/${userId}/${randomUUID()}.mp3`, sizeBytes: AUDIO_UPLOAD_MAX_BYTES };
    const first = await service.finalizeUpload(userId, input);
    expect(await service.finalizeUpload(userId, input)).toEqual(first);
    expect(first.scope).toBe("user");
    expect(storage.headObject).toHaveBeenCalledTimes(1);
    expect(storage.presignDownloadUrl).not.toHaveBeenCalled();
  });

  test("a deleted upload cannot be revived by replaying finalize", async () => {
    const input = upload();
    const first = await service.finalizeUpload(userId, input, scope());
    await service.deleteUserAsset(userId, first.id, scope());
    const error = await service.finalizeUpload(userId, input, scope()).catch((error) => error);
    expect(error.code).toBe("audio_asset_duplicate");
    expect(await service.getPlaybackSource(userId, first.id, scope())).toBeNull();
  });

  test("finalize rejects keys from another Workspace before probing", async () => {
    const error = await service.finalizeUpload(userId, { ...upload(), key: `workspaces/${randomUUID()}/audio-assets/track.mp3` }, scope()).catch((error) => error);
    expect(error.code).toBe("audio_asset_key_forbidden");
    expect(storage.headObject).not.toHaveBeenCalled();
    expect(await prisma.audioAsset.count()).toBe(0);
  });

  async function asset(title: string, options: { curated?: boolean; moodTags?: string[]; kind?: "music" | "sfx"; deleted?: boolean; workspaceId?: string } = {}) {
    return prisma.audioAsset.create({ data: {
      kind: options.kind ?? "music", title, storageKey: `fixtures/${randomUUID()}.mp3`,
      userId: options.curated ? null : userId,
      workspaceId: options.curated ? null : options.workspaceId ?? workspaceId,
      moodTags: options.moodTags ?? [], durationSec: 10,
      deletedAt: options.deleted ? new Date() : null,
    } });
  }

  test("list returns bounded metadata pages, followed by uploads, without signing any URL", async () => {
    const a = await asset("A track", { curated: true, moodTags: ["Calm"] });
    const b = await asset("B track", { curated: true, moodTags: ["Happy"] });
    const mine = await asset("My track");
    await asset("Hidden deleted track", { curated: true, deleted: true, moodTags: ["Hidden"] });
    const first = await service.listAssets(userId, { kind: "music", limit: 2 }, scope());
    expect(first.assets.map((row) => row.id)).toEqual([a.id, b.id]);
    expect(first.nextOffset).toBe(2);
    expect(first.moodTags).toEqual(["Calm", "Happy"]);
    const second = await service.listAssets(userId, { kind: "music", limit: 2, offset: first.nextOffset! }, scope());
    expect(second.assets.map((row) => row.id)).toEqual([mine.id]);
    expect(second.nextOffset).toBeNull();
    expect(first.assets[0]).not.toHaveProperty("playbackUrl");
    expect(first.assets[0]).not.toHaveProperty("storageKey");
    expect(storage.presignDownloadUrl).not.toHaveBeenCalled();
    expect(await service.getPlaybackSource(userId, a.id, scope())).toEqual({ url: `https://audio.example.test/${a.storageKey}`, durationSec: 10 });
    expect(storage.presignDownloadUrl).toHaveBeenCalledTimes(1);
  });

  test("search and mood filters run before pagination across the entire catalog", async () => {
    await asset("A no match", { curated: true });
    const tagged = await asset("B track", { curated: true, moodTags: ["Upbeat", "Happy"] });
    const titled = await asset("C UPBEAT track", { curated: true, moodTags: ["Happy"] });
    await asset("Deleted upbeat", { curated: true, moodTags: ["Happy"], deleted: true });
    await asset("Wrong kind upbeat", { curated: true, kind: "sfx", moodTags: ["Happy"] });
    const first = await service.listAssets(userId, { kind: "music", search: " upbeat ", mood: "hap", limit: 1 }, scope());
    expect(first.assets.map((row) => row.id)).toEqual([tagged.id]);
    expect(first.nextOffset).toBe(1);
    const second = await service.listAssets(userId, { kind: "music", search: "upbeat", mood: "HAP", limit: 1, offset: 1 }, scope());
    expect(second.assets.map((row) => row.id)).toEqual([titled.id]);
    expect(second.nextOffset).toBeNull();
  });

  test("uploads pages exclude curated, deleted, and other Workspace rows", async () => {
    const otherWorkspace = await prisma.workspace.create({ data: { ownerUserId: userId, name: "Other" } });
    await asset("Curated", { curated: true });
    await asset("Other Workspace", { workspaceId: otherWorkspace.id });
    await asset("Deleted", { deleted: true });
    const mine = await asset("Mine");
    const page = await service.listAssets(userId, { kind: "music", scope: "user", limit: 1 }, scope());
    expect(page.assets.map((row) => row.id)).toEqual([mine.id]);
    expect(page.nextOffset).toBeNull();
    expect(await service.getPlaybackSource(userId, (await asset("Other", { workspaceId: otherWorkspace.id })).id, scope())).toBeNull();
  });

  test("Saved pages and favorite flags are scoped to the current Workspace", async () => {
    const otherWorkspace = await prisma.workspace.create({ data: { ownerUserId: userId, name: "Other" } });
    const a = await asset("A", { curated: true });
    const b = await asset("B", { curated: true });
    await prisma.audioAssetFavorite.createMany({ data: [
      { userId, workspaceId: otherWorkspace.id, assetId: a.id },
      { userId, workspaceId, assetId: b.id },
    ] });
    const page = await service.listAssets(userId, { kind: "music", favorited: true, limit: 1 }, scope());
    expect(page.assets.map((row) => ({ id: row.id, favorited: row.favorited }))).toEqual([{ id: b.id, favorited: true }]);
    expect(page.nextOffset).toBeNull();
  });

  test("ties have stable ordering and pages are bounded by default", async () => {
    await prisma.audioAsset.createMany({ data: Array.from({ length: 35 }, () => ({ kind: "music", title: "Same", storageKey: `fixtures/${randomUUID()}` })) });
    const first = await service.listAssets(userId, { kind: "music" }, scope());
    expect(first.assets.length).toBe(30);
    const replay = await service.listAssets(userId, { kind: "music" }, scope());
    expect(replay).toEqual(first);
    const last = await service.listAssets(userId, { kind: "music", offset: first.nextOffset! }, scope());
    expect(last.assets.length).toBe(5);
    expect(new Set([...first.assets, ...last.assets].map((row) => row.id)).size).toBe(35);
    expect(last.nextOffset).toBeNull();
  });
});
