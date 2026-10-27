/**
 * Music/SFX library (docs/plans/vizard-parity.md "Music/SFX library").
 *
 * `AudioAsset` rows are either curated (userId null, managed by content
 * operations using packages/db/audio-manifest.json as the catalog) or
 * user-owned uploads (userId set, soft-deletable). Mirrors the shape of
 * `brand-template.service.ts`'s logo upload flow: presign against R2, verify
 * the finalized key is owned by the caller, and serve playback through a
 * short-lived presigned download URL rather than a public bucket.
 */
import { randomUUID } from "node:crypto";
import { Prisma, type AudioAsset } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  AUDIO_UPLOAD_MAX_BYTES,
  audioUploadContentTypeSchema,
  finalizeAudioUploadSchema,
  listAudioAssetsQuerySchema,
  presignAudioUploadSchema,
  type AudioAssetKindInput,
  type FinalizeAudioUploadInput,
  type ListAudioAssetsQuery,
  type PresignAudioUploadInput,
} from "@narriflow/validators";
import {
  deleteObject,
  headObject,
  isR2Configured,
  presignDownloadUrl,
  presignSingleUploadUrl,
} from "./r2-storage";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";
import { isUniqueConstraintError } from "./generation-sequencing";

function log(
  level: "info" | "error",
  message: string,
  context?: Record<string, unknown>,
) {
  console.warn(JSON.stringify({ level, message, ...context }));
}

const audioAssetFailureCatalog = {
	audio_asset_object_missing: "missing",
  audio_asset_size_invalid: "unprocessable",
  audio_asset_size_mismatch: "unprocessable",
  audio_asset_mime_invalid: "unprocessable",
	audio_asset_key_forbidden: "forbidden",
  audio_asset_not_found: "missing",
  audio_asset_presign_failed: "unavailable",
  audio_asset_duplicate: "conflict",
	audio_asset_storage_unavailable: "unavailable",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type AudioAssetFailureCode = keyof typeof audioAssetFailureCatalog;

export class AudioAssetError extends ExpectedDomainFailureError<AudioAssetFailureCode> {
  constructor(code: AudioAssetFailureCode, message: string) {
    super({ code, kind: audioAssetFailureCatalog[code], message });
    this.name = "AudioAssetError";
  }
}

/** L3: thrown by `deleteUserAsset` when the id doesn't resolve to a live row
 *  the caller owns — lets the route map this to a clean 404 instead of the
 *  generic 400 every other service error gets. */
export class AudioAssetNotFoundError extends ExpectedDomainFailureError<"audio_asset_not_found"> {
  constructor() {
    const code = "audio_asset_not_found" satisfies AudioAssetFailureCode;
    super({ code, kind: audioAssetFailureCatalog[code], message: "Audio asset not found" });
    this.name = "AudioAssetNotFoundError";
  }
}

/** Stable render-boundary classification for a live asset whose short-lived
 * access location could not be refreshed. The underlying storage error is
 * deliberately not exposed because provider messages may contain credentials. */
export class AudioAssetAccessError extends ExpectedDomainFailureError<"audio_asset_presign_failed"> {
  constructor() {
    const code = "audio_asset_presign_failed" satisfies AudioAssetFailureCode;
    super({ code, kind: audioAssetFailureCatalog[code], message: "Audio asset access is temporarily unavailable" });
    this.name = "AudioAssetAccessError";
  }
}

export class AudioAssetDuplicateError extends ExpectedDomainFailureError<"audio_asset_duplicate"> {
  constructor() {
    const code = "audio_asset_duplicate" satisfies AudioAssetFailureCode;
    super({ code, kind: audioAssetFailureCatalog[code], message: "This upload has already been added to your library" });
    this.name = "AudioAssetDuplicateError";
  }
}

export interface AudioAssetListRow {
  id: string;
  kind: AudioAssetKindInput;
  scope: "curated" | "user";
  title: string;
  moodTags: string[];
  durationSec: number;
  favorited: boolean;
}

/**
 * The prefix every user-owned upload key must live under. Mirrors
 * `assertOwnedLogoKey` in brand-template.service.ts: without this check, a
 * user could finalize an upload pointed at another tenant's R2 object (or a
 * totally unrelated key) and have it claimed as their own library row.
 * Exported so the pure ownership check can be unit-tested without a DB.
 */
export function audioAssetUploadPrefix(userId: string): string {
  return `audio-assets/${userId}/`;
}

export function isOwnedAudioUploadKey(userId: string, key: string): boolean {
  return key.startsWith(audioAssetUploadPrefix(userId));
}

function workspaceAudioAssetUploadPrefix(workspaceId: string): string {
  return `workspaces/${workspaceId}/audio-assets/`;
}

type AudioWorkspaceContext = { workspaceId: string; actorUserId: string };

const CONTENT_TYPE_EXT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
};

export function extensionForAudioContentType(contentType: string): string {
  return CONTENT_TYPE_EXT[contentType] ?? "bin";
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("Database client unavailable");
  }
  return prisma;
}

function toListRow(row: AudioAsset, favorited = false): AudioAssetListRow {
  return {
    id: row.id,
    kind: row.kind as AudioAssetKindInput,
    scope: row.userId ? "user" : "curated",
    title: row.title,
    moodTags: row.moodTags,
    durationSec: row.durationSec,
    favorited,
  };
}

export class AudioAssetService {
  private requirePrisma = requirePrisma;

  constructor(private readonly storage = { headObject, presignDownloadUrl, presignSingleUploadUrl, isR2Configured, deleteObject }) {}

  /** Bounded metadata pages. Only playback/render resolution signs access URLs. */
  async listAssets(
    userId: string,
    query: Pick<ListAudioAssetsQuery, "kind"> & Partial<Omit<ListAudioAssetsQuery, "kind">>,
    context?: AudioWorkspaceContext,
  ): Promise<{ assets: AudioAssetListRow[]; moodTags: string[]; nextOffset: number | null }> {
    const parsed = listAudioAssetsQuerySchema.parse(query);
    const prisma = this.requirePrisma();
    const owner = context
      ? Prisma.sql`asset."workspaceId" = ${context.workspaceId}::uuid`
      : Prisma.sql`asset."userId" = ${userId}::uuid`;
    const favoriteOwner = context
      ? Prisma.sql`favorite."workspaceId" = ${context.workspaceId}::uuid`
      : Prisma.sql`favorite."userId" = ${userId}::uuid`;
    const favorite = Prisma.sql`EXISTS (
      SELECT 1 FROM "AudioAssetFavorite" favorite
      WHERE favorite."assetId" = asset.id AND ${favoriteOwner}
    )`;
    const scope = parsed.scope === "user"
      ? owner
      : Prisma.sql`(asset."userId" IS NULL OR ${owner})`;
    const mood = parsed.mood
      ? Prisma.sql`AND (asset."userId" IS NOT NULL OR EXISTS (
          SELECT 1 FROM unnest(asset."moodTags") tag
          WHERE strpos(lower(tag), lower(${parsed.mood})) > 0
        ))`
      : Prisma.empty;
    const search = parsed.search
      ? Prisma.sql`AND strpos(lower(concat_ws(' ', asset.title, array_to_string(asset."moodTags", ' '))), lower(${parsed.search})) > 0`
      : Prisma.empty;
    const [rows, tags] = await Promise.all([
      prisma.$queryRaw<(AudioAsset & { favorited: boolean })[]>(Prisma.sql`
        SELECT asset.*, ${favorite} AS favorited
        FROM "AudioAsset" asset
        WHERE asset.kind = ${parsed.kind}::"AudioAssetKind"
          AND asset."deletedAt" IS NULL
          AND ${scope}
          ${mood} ${search}
          ${parsed.favorited === undefined ? Prisma.empty : Prisma.sql`AND ${favorite} = ${parsed.favorited}`}
        ORDER BY (asset."userId" IS NOT NULL) ASC,
          CASE WHEN asset."userId" IS NULL THEN asset.title END ASC,
          CASE WHEN asset."userId" IS NOT NULL THEN asset."createdAt" END DESC,
          asset.id ASC
        LIMIT ${parsed.limit + 1} OFFSET ${parsed.offset}
      `),
      // Aggregate facets in PostgreSQL rather than reading every catalog row.
      prisma.$queryRaw<{ tag: string }[]>(Prisma.sql`
        SELECT DISTINCT unnest("moodTags") AS tag FROM "AudioAsset"
        WHERE kind = ${parsed.kind}::"AudioAssetKind" AND "userId" IS NULL AND "deletedAt" IS NULL
        ORDER BY tag
      `),
    ]);
    const assets = rows.slice(0, parsed.limit).map((row) => toListRow(row, row.favorited));
    return {
      assets,
      moodTags: tags.map(({ tag }) => tag),
      nextOffset: rows.length > parsed.limit ? parsed.offset + assets.length : null,
    };
  }

  async presignUpload(
    userId: string,
    input: PresignAudioUploadInput,
    context?: AudioWorkspaceContext,
  ): Promise<{ key: string; uploadUrl: string; contentType: string }> {
    const parsed = presignAudioUploadSchema.parse(input);
    if (!this.storage.isR2Configured()) {
      throw new AudioAssetError(
        "audio_asset_storage_unavailable",
        "Audio asset storage is temporarily unavailable",
      );
    }

    const ext = extensionForAudioContentType(parsed.contentType);
    const key = `${context ? workspaceAudioAssetUploadPrefix(context.workspaceId) : audioAssetUploadPrefix(userId)}${randomUUID()}.${ext}`;
    const uploadUrl = await this.storage.presignSingleUploadUrl({
      key,
      contentType: parsed.contentType,
    });
    return { key, uploadUrl, contentType: parsed.contentType };
  }

  async finalizeUpload(
    userId: string,
    input: FinalizeAudioUploadInput,
    context?: AudioWorkspaceContext,
  ): Promise<AudioAssetListRow> {
    const parsed = finalizeAudioUploadSchema.parse(input);
    const owned = context
      ? parsed.key.startsWith(workspaceAudioAssetUploadPrefix(context.workspaceId))
      : isOwnedAudioUploadKey(userId, parsed.key);
    if (!owned) {
      throw new AudioAssetError(
        "audio_asset_key_forbidden",
        "The audio upload does not belong to this Workspace",
      );
    }

    const prisma = this.requirePrisma();
    const replayWhere = {
      storageKey: parsed.key,
      deletedAt: null,
      ...(context ? { workspaceId: context.workspaceId } : { userId }),
    };
    const existing = await prisma.audioAsset.findFirst({ where: replayWhere });
    if (existing) return toListRow(existing);
    let object;
    try {
      object = await this.storage.headObject(parsed.key);
    } catch (error) {
      const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
      if (failure?.name === "NotFound" || failure?.name === "NoSuchKey" || failure?.$metadata?.httpStatusCode === 404) {
        throw new AudioAssetError("audio_asset_object_missing", "The uploaded audio object was not found");
      }
      throw new AudioAssetError("audio_asset_storage_unavailable", "Audio asset storage is temporarily unavailable");
    }
    if (object.sizeBytes === null || !Number.isSafeInteger(object.sizeBytes) || object.sizeBytes <= 0 || object.sizeBytes > AUDIO_UPLOAD_MAX_BYTES) {
      throw new AudioAssetError("audio_asset_size_invalid", "The uploaded audio must be between 1 byte and 50MB");
    }
    if (parsed.sizeBytes !== undefined && object.sizeBytes !== parsed.sizeBytes) {
      throw new AudioAssetError("audio_asset_size_mismatch", "The uploaded audio size does not match the declared size");
    }
    if (!audioUploadContentTypeSchema.safeParse(object.contentType).success) {
      throw new AudioAssetError("audio_asset_mime_invalid", "The uploaded object must be MP3, WAV, or M4A audio");
    }
    const created = await prisma.audioAsset.create({
      data: {
        kind: parsed.kind,
        userId,
        workspaceId: context?.workspaceId ?? null,
        createdByUserId: context?.actorUserId ?? userId,
        storageKey: parsed.key,
        title: parsed.title,
        durationSec: parsed.durationSec,
      },
    }).catch(async (error) => {
      if (isUniqueConstraintError(error)) {
        const replay = await prisma.audioAsset.findFirst({ where: replayWhere });
        if (replay) return replay;
        throw new AudioAssetDuplicateError();
      }
      throw error;
    });
    return toListRow(created);
  }

  /** Persist the Saved/star state for a curated or caller-owned live asset. */
  async setFavorite(
    userId: string,
    assetId: string,
    favorited: boolean,
    context?: AudioWorkspaceContext,
  ): Promise<{ favorited: boolean }> {
    const prisma = this.requirePrisma();
    const asset = await prisma.audioAsset.findFirst({
      where: {
        id: assetId,
        deletedAt: null,
        OR: [{ userId: null }, context ? { workspaceId: context.workspaceId } : { userId }],
      },
      select: { id: true },
    });
    if (!asset) throw new AudioAssetNotFoundError();

    if (favorited) {
      if (context) {
        await prisma.audioAssetFavorite.upsert({
          where: { workspaceId_assetId: { workspaceId: context.workspaceId, assetId } },
          update: {},
          create: { userId, workspaceId: context.workspaceId, assetId },
        });
      } else {
        const existing = await prisma.audioAssetFavorite.findFirst({ where: { userId, assetId } });
        if (!existing) await prisma.audioAssetFavorite.create({ data: { userId, assetId } });
      }
    } else {
      await prisma.audioAssetFavorite.deleteMany({
        where: { assetId, ...(context ? { workspaceId: context.workspaceId } : { userId }) },
      });
    }

    return { favorited };
  }

  /**
   * `assetId` must resolve to a curated row or one owned by `userId` and not
   * soft-deleted. Returns `null` (never throws) on any mismatch so callers
   * can 404 uniformly instead of leaking which case failed.
   */
  async getPlaybackSource(
    userId: string,
    assetId: string,
    context?: AudioWorkspaceContext,
  ): Promise<{ url: string; durationSec: number } | null> {
    const prisma = this.requirePrisma();
    const row = await prisma.audioAsset.findFirst({
      where: {
        id: assetId,
        deletedAt: null,
        OR: [{ userId: null }, context ? { workspaceId: context.workspaceId } : { userId }],
      },
    });
    if (!row) return null;
    return {
      url: await this.storage.presignDownloadUrl({ key: row.storageKey }),
      durationSec: row.durationSec,
    };
  }

  /**
   * Only rows the caller owns can be deleted (curated rows are untouchable
   * here — see the model doc comment on why curation removal is a manual ops
   * step, not a user action). Soft-delete first so the row disappears from
   * the library immediately even if the R2 delete below fails; the object
   * delete is best-effort and logged, not retried, since an orphaned R2
   * object costs storage but a stuck "deleting" DB row would block the user.
   */
  async deleteUserAsset(userId: string, assetId: string, context?: AudioWorkspaceContext): Promise<void> {
    const prisma = this.requirePrisma();
    const existing = await prisma.audioAsset.findFirst({
      where: { id: assetId, ...(context ? { workspaceId: context.workspaceId } : { userId }), deletedAt: null },
    });
    if (!existing) {
      throw new AudioAssetNotFoundError();
    }

    await prisma.audioAsset.update({
      where: { id: assetId },
      data: { deletedAt: new Date() },
    });

    try {
      await this.storage.deleteObject(existing.storageKey);
    } catch (error) {
      log("error", "audio_asset_r2_delete_failed", {
        assetId,
        storageKey: existing.storageKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Worker-side resolution for render time, scoped to the render's owning
   * user exactly like `getPlaybackSource` above (`OR: [{ userId: null },
   * { userId: ownerUserId }]`) — M4: a render must never resolve another
   * tenant's private upload just because it captured the row's id from a
   * `studioEdits.music.assetId`/`sfx[].assetId` value.
   *
   * M3: also filters `deletedAt: null`. `deleteUserAsset` above HARD-deletes
   * the R2 object (soft-delete is only for the DB row/library visibility),
   * so once an asset is soft-deleted there is no live object left to serve
   * at all — resolving the row anyway used to hand callers a presigned URL
   * to a 404, which then surfaced as an indistinguishable-from-transient
   * "download failed" error rather than the true "this asset is gone"
   * condition. Callers already treat a `null` return exactly like any other
   * resolve-miss (the Clip Render Attempt logs the unavailable optional track
   * and omits it without failing the clip) — same policy, now triggered by the honest
   * condition instead of masking it as a download failure.
   */
  async resolveRenderSource(
    ownerUserId: string,
    assetId: string,
    workspaceId?: string | null,
  ): Promise<{ url: string; title: string; durationSec: number } | null> {
    const prisma = this.requirePrisma();
    const row = await prisma.audioAsset.findFirst({
      where: {
        id: assetId,
        deletedAt: null,
        OR: [{ userId: null }, workspaceId ? { workspaceId } : { userId: ownerUserId }],
      },
    });
    if (!row) return null;
    try {
      return {
        url: await this.storage.presignDownloadUrl({ key: row.storageKey }),
        title: row.title,
        durationSec: row.durationSec,
      };
    } catch {
      throw new AudioAssetAccessError();
    }
  }
}

export const audioAssetService = new AudioAssetService();
