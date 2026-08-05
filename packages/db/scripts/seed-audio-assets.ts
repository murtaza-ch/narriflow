#!/usr/bin/env bun
/**
 * Seeds curated AudioAsset rows (Music/SFX library,
 * docs/plans/vizard-parity.md "Music/SFX library") from
 * packages/db/audio-manifest.json.
 *
 * Upserts by `storageKey` (the row's unique R2 object key), so re-running
 * after editing the manifest is idempotent and safe. Removing an entry from
 * the manifest does NOT delete its DB row — curation removals (taking a
 * track out of the library) are a manual ops step, not something this
 * script does, so a bad manifest edit can never silently strip tracks out
 * of every user's library on the next deploy. See the `AudioAsset` doc
 * comment in schema.prisma for the same policy stated at the model level.
 *
 * Manifest population (actual track/SFX curation) is a content/ops task,
 * not a code task — see the `_README` field in audio-manifest.json for
 * sourcing rules.
 *
 * M5 (placeholder-seeding safety): any manifest entry whose `title` starts
 * with "PLACEHOLDER" is refused by default — a real deploy pipeline running
 * this script against a manifest that still has scaffolding entries in it
 * would otherwise seed those placeholder rows straight into every user's
 * curated library, a one-way door once users start referencing the row's id
 * from their own clips. Pass `--allow-placeholders` to intentionally seed
 * them anyway (e.g. local/staging fixture data).
 *
 * Usage: bun run seed:audio   (from packages/db; requires DATABASE_URL)
 *        bun run seed:audio --allow-placeholders
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPrismaClient } from "../src/client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(__dirname, "..", "audio-manifest.json");

const PLACEHOLDER_TITLE_PREFIX = "PLACEHOLDER";
const ALLOW_PLACEHOLDERS_FLAG = "--allow-placeholders";

function log(
  level: "info" | "error",
  message: string,
  context?: Record<string, unknown>,
) {
  console.warn(JSON.stringify({ level, message, ...context }));
}

interface ManifestTrack {
  kind: "music" | "sfx";
  storageKey: string;
  title: string;
  moodTags?: string[];
  durationSec?: number;
}

function isManifestTrack(value: unknown): value is ManifestTrack {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    (row.kind === "music" || row.kind === "sfx") &&
    typeof row.storageKey === "string" &&
    row.storageKey.length > 0 &&
    typeof row.title === "string" &&
    row.title.length > 0 &&
    (row.moodTags === undefined || Array.isArray(row.moodTags)) &&
    (row.durationSec === undefined || typeof row.durationSec === "number")
  );
}

function isPlaceholderTitle(title: string): boolean {
  return title.trim().toUpperCase().startsWith(PLACEHOLDER_TITLE_PREFIX);
}

async function main() {
  const allowPlaceholders = process.argv.includes(ALLOW_PLACEHOLDERS_FLAG);

  const raw = await readFile(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(raw) as { tracks?: unknown[] };
  const candidates = Array.isArray(manifest.tracks) ? manifest.tracks : [];

  const rows: ManifestTrack[] = [];
  let skipped = 0;
  for (const candidate of candidates) {
    if (isManifestTrack(candidate)) {
      rows.push(candidate);
    } else {
      skipped += 1;
    }
  }

  // M5: refuse to seed placeholder-titled entries unless explicitly
  // overridden — see this file's top doc comment for why.
  const placeholders = rows.filter((row) => isPlaceholderTitle(row.title));
  if (placeholders.length > 0 && !allowPlaceholders) {
    log("error", "audio_asset_seed_refused_placeholders", {
      placeholderCount: placeholders.length,
      placeholders: placeholders.map((row) => ({
        storageKey: row.storageKey,
        title: row.title,
      })),
      hint: `re-run with ${ALLOW_PLACEHOLDERS_FLAG} to seed these anyway`,
    });
    process.exitCode = 1;
    return;
  }

  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("Database client unavailable — set DATABASE_URL");
  }

  let created = 0;
  let updated = 0;
  for (const row of rows) {
    const existing = await prisma.audioAsset.findUnique({
      where: { storageKey: row.storageKey },
      select: { id: true },
    });

    const data = {
      kind: row.kind,
      title: row.title,
      moodTags: row.moodTags ?? [],
      durationSec: row.durationSec ?? 0,
      // M5: force userId back to null (curated) on every update, even
      // though `storageKey` is the upsert key and a curated manifest key
      // colliding with a user-owned row shouldn't normally be reachable —
      // this is the second gate so a key collision can never leave a
      // curated-looking title/moodTags update sitting on a still
      // user-owned row.
      userId: null,
    };

    if (existing) {
      await prisma.audioAsset.update({ where: { id: existing.id }, data });
      updated += 1;
    } else {
      await prisma.audioAsset.create({
        data: { ...data, storageKey: row.storageKey },
      });
      created += 1;
    }
  }

  log("info", "audio_asset_seed_complete", {
    manifestEntries: candidates.length,
    skippedInvalid: skipped,
    created,
    updated,
  });
}

main()
  .catch((error) => {
    log("error", "audio_asset_seed_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    const prisma = getPrismaClient();
    await prisma?.$disconnect();
  });
