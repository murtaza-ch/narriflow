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
import type { AudioAsset } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  finalizeAudioUploadSchema,
  presignAudioUploadSchema,
  type AudioAssetKindInput,
  type FinalizeAudioUploadInput,
  type PresignAudioUploadInput,
} from "@narriflow/validators";
import {
  deleteObject,
  isR2Configured,
  presignDownloadUrl,
  presignSingleUploadUrl,
} from "./r2-storage";

function log(
  level: "info" | "error",
  message: string,
  context?: Record<string, unknown>,
) {
  console.warn(JSON.stringify({ level, message, ...context }));
}

/** L3: thrown by `deleteUserAsset` when the id doesn't resolve to a live row
 *  the caller owns — lets the route map this to a clean 404 instead of the
 *  generic 400 every other service error gets. */
export class AudioAssetNotFoundError extends Error {
  constructor() {
    super("audio asset not found");
    this.name = "AudioAssetNotFoundError";
  }
}

export interface AudioAssetListRow {
  id: string;
  kind: AudioAssetKindInput;
  scope: "curated" | "user";
  title: string;
  moodTags: string[];
  durationSec: number;
  playbackUrl: string;
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

async function toListRow(row: AudioAsset, favorited = false): Promise<AudioAssetListRow> {
  return {
    id: row.id,
    kind: row.kind as AudioAssetKindInput,
    scope: row.userId ? "user" : "curated",
    title: row.title,
    moodTags: row.moodTags,
    durationSec: row.durationSec,
    playbackUrl: await presignDownloadUrl({ key: row.storageKey }),
    favorited,
  };
}

export class AudioAssetService {
  private requirePrisma = requirePrisma;

  /**
   * Curated rows (userId null) first, then the caller's own non-deleted
   * uploads, each ordered title-then-createdAt within its group — mirrors
   * `brandTemplateService.list`'s builtIns-then-mine shape. `mood` filters
   * case-insensitively by substring against `moodTags`; this is done in
   * application code rather than a Postgres array predicate because the
   * curated library is small (~120-200 rows for music, tens for SFX per the
   * plan) and Prisma's array filters (`has`/`hasSome`) are exact-match only,
   * not case-insensitive contains.
   *
   * L2: the mood filter applies ONLY to curated rows — a user's own uploads
   * have no `moodTags` (there's no UI to set them), so filtering `mine` by
   * mood too would silently hide every upload the moment the user picked
   * any mood filter at all, rather than just narrowing the curated library
   * as intended.
   */
  async listAssets(
    userId: string,
    query: { kind: AudioAssetKindInput; mood?: string },
    context?: AudioWorkspaceContext,
  ): Promise<{ assets: AudioAssetListRow[]; moodTags: string[] }> {
    const prisma = this.requirePrisma();
    const [curated, mine, favorites] = await Promise.all([
      prisma.audioAsset.findMany({
        where: { kind: query.kind, userId: null },
        orderBy: { title: "asc" },
      }),
      prisma.audioAsset.findMany({
        where: { kind: query.kind, ...(context ? { workspaceId: context.workspaceId } : { userId }), deletedAt: null },
        orderBy: { createdAt: "desc" },
      }),
      prisma.audioAssetFavorite.findMany({
        where: context ? { workspaceId: context.workspaceId } : { userId },
        select: { assetId: true },
      }),
    ]);

    const moodTags = Array.from(
      new Set(curated.flatMap((row) => row.moodTags)),
    ).sort((a, b) => a.localeCompare(b));

    const needle = query.mood?.trim().toLowerCase();
    const matchesMood = (row: AudioAsset) =>
      !needle ||
      row.moodTags.some((tag) => tag.toLowerCase().includes(needle));

    const filtered = [...curated.filter(matchesMood), ...mine];
    const favoriteIds = new Set(favorites.map((favorite) => favorite.assetId));
    const assets = await Promise.all(
      filtered.map((row) => toListRow(row, favoriteIds.has(row.id))),
    );

    return { assets, moodTags };
  }

  async presignUpload(
    userId: string,
    input: PresignAudioUploadInput,
    context?: AudioWorkspaceContext,
  ): Promise<{ key: string; uploadUrl: string; contentType: string }> {
    const parsed = presignAudioUploadSchema.parse(input);
    if (!isR2Configured()) {
      throw new Error("R2 configuration is missing");
    }

    const ext = extensionForAudioContentType(parsed.contentType);
    const key = `${context ? workspaceAudioAssetUploadPrefix(context.workspaceId) : audioAssetUploadPrefix(userId)}${randomUUID()}.${ext}`;
    const uploadUrl = await presignSingleUploadUrl({
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
      throw new Error("upload key is not owned by this user");
    }

    const prisma = this.requirePrisma();
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
  async getPlaybackUrl(
    userId: string,
    assetId: string,
    context?: AudioWorkspaceContext,
  ): Promise<string | null> {
    const prisma = this.requirePrisma();
    const row = await prisma.audioAsset.findFirst({
      where: {
        id: assetId,
        deletedAt: null,
        OR: [{ userId: null }, context ? { workspaceId: context.workspaceId } : { userId }],
      },
    });
    if (!row) return null;
    return presignDownloadUrl({ key: row.storageKey });
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
      await deleteObject(existing.storageKey);
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
   * user exactly like `getPlaybackUrl` above (`OR: [{ userId: null },
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
   * resolve-miss (log `clip_music_asset_resolve_failed`/
   * `clip_sfx_asset_resolve_failed` in render-clips.ts and skip the track,
   * never fail the whole clip) — same policy, now triggered by the honest
   * condition instead of masking it as a download failure.
   */
  async resolveRenderSource(
    ownerUserId: string,
    assetId: string,
    workspaceId?: string | null,
  ): Promise<{ url: string; title: string } | null> {
    const prisma = this.requirePrisma();
    const row = await prisma.audioAsset.findFirst({
      where: {
        id: assetId,
        deletedAt: null,
        OR: [{ userId: null }, workspaceId ? { workspaceId } : { userId: ownerUserId }],
      },
    });
    if (!row) return null;
    return { url: await presignDownloadUrl({ key: row.storageKey }), title: row.title };
  }
}

export const audioAssetService = new AudioAssetService();
