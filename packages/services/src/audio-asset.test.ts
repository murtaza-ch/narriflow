import { describe, expect, test } from "bun:test";
import { finalizeAudioUploadSchema, listAudioAssetsQuerySchema } from "@narriflow/validators";
import { AudioAssetService, extensionForAudioContentType } from "./audio-asset.service";
import type { BrandActorScope } from "./brand-ownership";

// Service behavior against PostgreSQL lives in audio-asset.db.test.ts.

describe("extensionForAudioContentType", () => {
  test("maps every accepted content type to its expected extension", () => {
    expect(extensionForAudioContentType("audio/mpeg")).toBe("mp3");
    expect(extensionForAudioContentType("audio/wav")).toBe("wav");
    expect(extensionForAudioContentType("audio/x-wav")).toBe("wav");
    expect(extensionForAudioContentType("audio/mp4")).toBe("m4a");
    expect(extensionForAudioContentType("audio/x-m4a")).toBe("m4a");
  });

  test("falls back to a safe default extension for an unrecognized content type", () => {
    expect(extensionForAudioContentType("application/octet-stream")).toBe(
      "bin",
    );
  });
});

describe("audio request validation", () => {
  test("coerces bounded pages and explicit favorite filters from query strings", () => {
    expect(listAudioAssetsQuerySchema.parse({ kind: "music", limit: "10", offset: "20", favorited: "false", search: " calm " })).toEqual({
      kind: "music", scope: "all", limit: 10, offset: 20, favorited: false, search: "calm",
    });
  });

  test.each([{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: "invalid" }, { limit: 1.5 }, { favorited: "invalid" }, { search: "x".repeat(121) }])("rejects invalid list input %j", (query) => {
    expect(listAudioAssetsQuerySchema.safeParse({ kind: "music", ...query }).success).toBe(false);
  });

  test("accepts an optional declared upload size and rejects sizes outside the bound", () => {
    const input = { key: "audio-assets/user/track.mp3", kind: "music", title: "Track", sizeBytes: 128 };
    expect(finalizeAudioUploadSchema.parse(input).sizeBytes).toBe(128);
    expect(finalizeAudioUploadSchema.safeParse({ ...input, sizeBytes: 0 }).success).toBe(false);
  });
});

/**
 * The upload gate against an in-memory stand-in for the audio table and its
 * lock. The Prisma queries and the lock are not run here; only the PostgreSQL
 * contract in audio-asset.db.test.ts would, and it needs a database.
 */
describe("audio upload plan gate", () => {
  function setup(live: number) {
    const rows: Array<{ id: string; storageKey: string; deletedAt: null }> = Array.from({ length: live }, (_, index) => ({
      id: `asset-${index}`,
      storageKey: `workspaces/ws/audio-assets/${index}.mp3`,
      deletedAt: null,
    }));
    const client = {
      $queryRaw: async () => [],
      audioAsset: {
        count: async () => rows.length,
        findFirst: async ({ where }: { where: { storageKey: string } }) =>
          rows.find((row) => row.storageKey === where.storageKey) ?? null,
        create: async ({ data }: { data: { storageKey: string; kind: string; title: string; durationSec: number; userId: string } }) => {
          const row = { id: `asset-${rows.length}`, storageKey: data.storageKey, deletedAt: null, ...data, moodTags: [] as string[] };
          rows.push(row);
          return row;
        },
      },
      $transaction: async <T>(run: (tx: typeof client) => Promise<T>) => run(client),
    };
    const storage = {
      headObject: async () => ({ contentType: "audio/mpeg", sizeBytes: 128, etag: null, metadata: {} }),
      presignDownloadUrl: async () => "https://audio.test/x",
      presignSingleUploadUrl: async () => "https://upload.test/x",
      isR2Configured: () => true,
      deleteObject: async (key: string) => ({ key }),
    };
    const service = new AudioAssetService(storage as never);
    (service as unknown as { requirePrisma: () => unknown }).requirePrisma = () => client;
    return { service, rows };
  }
  const scope = (pricingTier: string): BrandActorScope => ({
    workspaceId: "ws",
    actorUserId: "user",
    workspaceOwnerUserId: "user",
    role: "owner",
    status: "active",
    pricingTier,
    isPersonalWorkspace: true,
  });
  const upload = (name: string) => ({ key: `workspaces/ws/audio-assets/${name}.mp3`, kind: "music" as const, title: "Track", durationSec: 3 });

  test("Free can neither presign nor finalize", async () => {
    const { service, rows } = setup(0);
    const presign = await service.presignUpload({ contentType: "audio/mpeg", sizeBytes: 128 }, scope("free")).catch((error) => error);
    const finalize = await service.finalizeUpload("user", upload("new"), scope("free")).catch((error) => error);
    expect(presign).toMatchObject({ code: "plan_feature_required", kind: "payment_required" });
    expect(finalize).toMatchObject({ code: "plan_feature_required" });
    expect(rows).toHaveLength(0);
  });

  test("a full library refuses at presign and at finalize, but a replay still succeeds", async () => {
    const { service, rows } = setup(10);
    const presign = await service.presignUpload({ contentType: "audio/mpeg", sizeBytes: 128 }, scope("creator")).catch((error) => error);
    expect(presign).toMatchObject({ code: "plan_limit_reached", details: { limit: "audioAssets", used: 10, max: 10, requiredTier: "pro" } });
    const finalize = await service.finalizeUpload("user", upload("new"), scope("creator")).catch((error) => error);
    expect(finalize).toMatchObject({ code: "plan_limit_reached", details: { limit: "audioAssets", used: 10, max: 10 } });
    expect(rows).toHaveLength(10);
    expect(await service.finalizeUpload("user", upload("3"), scope("creator"))).toMatchObject({ id: "asset-3" });
  });

  test("a library with room accepts the upload", async () => {
    const { service, rows } = setup(9);
    const created = await service.finalizeUpload("user", upload("tenth"), scope("creator"));
    expect(created).toMatchObject({ kind: "music", title: "Track", scope: "user" });
    expect(rows).toHaveLength(10);
  });
});
