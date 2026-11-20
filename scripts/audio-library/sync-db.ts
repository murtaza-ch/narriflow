import { readEnvFile, requireKeys, resolveFrom } from "./env";
import { readManifest } from "./manifest";
import type { ManifestEntry } from "./types";
import { describeError, log } from "./util";

/** Below this the manifest is probably truncated; refuse to soft-delete against it. */
const MIN_ENTRIES_FOR_DELETION = 50;

/**
 * The few Prisma calls used here. The real client comes from packages/db, which
 * owns the schema; this keeps the script independent of generation timing.
 */
interface AudioAssetDelegate {
  findMany(args: { where: Record<string, unknown>; select: Record<string, true> }): Promise<unknown[]>;
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
}
interface PrismaLike {
  audioAsset: AudioAssetDelegate;
  $disconnect(): Promise<void>;
}

type CuratedFields = Pick<
  ManifestEntry,
  "kind" | "title" | "artist" | "license" | "attribution" | "sourceUrl" | "sortOrder" | "durationSec"
> & { moodTags: string[] };

function fieldsOf(entry: ManifestEntry): CuratedFields {
  return {
    kind: entry.kind,
    title: entry.title,
    moodTags: entry.moods,
    durationSec: entry.durationSec,
    license: entry.license,
    artist: entry.artist,
    attribution: entry.attribution,
    sourceUrl: entry.sourceUrl,
    sortOrder: entry.sortOrder,
  };
}

interface ExistingRow extends CuratedFields {
  id: string;
  storageKey: string;
  deletedAt: Date | null;
}

export function planSync(entries: readonly ManifestEntry[], existing: readonly ExistingRow[]) {
  const byKey = new Map(existing.map((row) => [row.storageKey, row]));
  const wanted = new Set(entries.map((entry) => entry.storageKey));
  const create: ManifestEntry[] = [];
  const update: Array<{ id: string; entry: ManifestEntry }> = [];
  let unchanged = 0;
  for (const entry of entries) {
    const row = byKey.get(entry.storageKey);
    if (!row) {
      create.push(entry);
      continue;
    }
    const next = fieldsOf(entry);
    const same =
      row.deletedAt === null &&
      (Object.keys(next) as Array<keyof CuratedFields>).every(
        (key) => JSON.stringify(row[key]) === JSON.stringify(next[key]),
      );
    if (same) unchanged++;
    else update.push({ id: row.id, entry });
  }
  const softDelete = existing.filter((row) => row.deletedAt === null && !wanted.has(row.storageKey)).map((row) => row.id);
  return { create, update, softDelete, unchanged };
}

/** The URL and its credentials, so none of them can leak through an error message. */
function connectionSecrets(url: string): string[] {
  try {
    const parsed = new URL(url);
    return [url, parsed.password, decodeURIComponent(parsed.password), parsed.username].filter((part) => part.length > 3);
  } catch {
    return [url];
  }
}

/**
 * Curated rows have no userId, workspaceId or createdByUserId. Rows are keyed
 * by storageKey; a key that leaves the manifest is soft-deleted, never removed,
 * because brand profiles and editor documents reference these ids.
 */
export async function runSyncDb(dryRun: boolean): Promise<void> {
  const manifest = await readManifest();
  const env = readEnvFile("packages/db/.env");
  requireKeys(env, ["DATABASE_URL"], "packages/db/.env");

  const { PrismaClient: Client } = (await import(resolveFrom("@prisma/client", "packages/db/src"))) as {
    PrismaClient: new (options: { adapter: unknown; log: string[] }) => PrismaLike;
  };
  const { PrismaPg } = (await import(resolveFrom("@prisma/adapter-pg", "packages/db/src"))) as {
    PrismaPg: new (options: { connectionString: string }) => unknown;
  };
  const prisma = new Client({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL as string }), log: ["error"] });
  try {
    const rows = (await prisma.audioAsset.findMany({
      where: { userId: null, workspaceId: null, createdByUserId: null },
      select: {
        id: true,
        storageKey: true,
        deletedAt: true,
        kind: true,
        title: true,
        moodTags: true,
        durationSec: true,
        license: true,
        artist: true,
        attribution: true,
        sourceUrl: true,
        sortOrder: true,
      },
    })) as unknown as ExistingRow[];

    const plan = planSync(manifest.entries, rows);
    if (plan.softDelete.length > 0 && manifest.entries.length < MIN_ENTRIES_FOR_DELETION) {
      throw new Error(`Manifest has only ${manifest.entries.length} entries; refusing to soft-delete ${plan.softDelete.length} rows`);
    }
    const summary = { create: plan.create.length, update: plan.update.length, softDelete: plan.softDelete.length, unchanged: plan.unchanged };
    if (dryRun) {
      log("sync_plan", summary);
      return;
    }

    for (const entry of plan.create) {
      await prisma.audioAsset.create({ data: { storageKey: entry.storageKey, ...fieldsOf(entry) } });
    }
    for (const { id, entry } of plan.update) {
      await prisma.audioAsset.update({ where: { id }, data: { ...fieldsOf(entry), deletedAt: null } });
    }
    if (plan.softDelete.length > 0) {
      await prisma.audioAsset.updateMany({ where: { id: { in: plan.softDelete } }, data: { deletedAt: new Date() } });
    }
    log("sync_done", summary);
  } catch (error) {
    // A failed connect can echo the connection string; log only Prisma's code and a redacted message.
    throw new Error(describeError(error, connectionSecrets(env.DATABASE_URL as string)));
  } finally {
    await prisma.$disconnect();
  }
}
