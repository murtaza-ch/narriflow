/**
 * Fetch one real clip for the Scene Style real-render check (ticket 04): READ-ONLY.
 *
 *   bun apps/media/scripts/caption-scene-real-fetch.ts <clipId> <outDir> [--no-source]
 *
 * Writes into <outDir> (keep it under `.scratch/motion-captions/out/real/`, which is git-ignored; the clip is
 * private): `document.json` (the clip's editor document, exactly the fields the render attempt decodes),
 * `evidence.json` (the stored layout analyses), `meta.json` (project facts, no secrets) and `source.mp4` (the
 * project's source object from R2, a GET).
 *
 * The database is opened with `default_transaction_read_only=on` through `psql`; R2 is only read. Credentials are
 * read from `packages/db/.env` and `apps/api/.dev.vars` and never printed.
 */
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_CAPTION_PRESET, EDITOR_DOCUMENT_VERSION, editorDocumentSchema } from "@narriflow/validators";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readEnvFile(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]!] = value;
  }
  return result;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function queryOne(databaseUrl: string, sql: string): Record<string, any> {
  const result = spawnSync("psql", [databaseUrl, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, PGOPTIONS: "-c default_transaction_read_only=on" },
  });
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr.replace(/postgres(ql)?:\/\/\S+/g, "<url>").slice(0, 400)}`);
  return JSON.parse(result.stdout.trim());
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const noSource = args.includes("--no-source");
  const [clipId, outArg] = args.filter((arg) => !arg.startsWith("--"));
  if (!clipId || !outArg || !UUID.test(clipId)) throw new Error("usage: caption-scene-real-fetch.ts <clipId> <outDir> [--no-source]");
  const outDir = resolve(outArg);
  if (!outDir.includes(`${join(".scratch", "motion-captions", "out", "real")}`)) throw new Error("outDir must be under .scratch/motion-captions/out/real/ (git-ignored)");
  await mkdir(outDir, { recursive: true });

  const db = readEnvFile(join(REPO_ROOT, "packages/db/.env"));
  const databaseUrl = (db.DATABASE_URL ?? "").split("?")[0]!;
  if (!databaseUrl) throw new Error("DATABASE_URL missing in packages/db/.env");

  const row = queryOne(
    databaseUrl,
    `select json_build_object(
      'clip', json_build_object(
        'id', c.id, 'projectId', c."projectId", 'title', c.title, 'status', c.status, 'editorRevision', c."editorRevision",
        'startSec', c."startSec", 'endSec', c."endSec", 'captionPreset', c."captionPreset", 'transcriptSlice', c."transcriptSlice",
        'studioEdits', c."studioEdits", 'brollUrl', c."brollUrl", 'deletedRanges', c."deletedRanges",
        'editorDocumentVersion', c."editorDocumentVersion", 'sceneBlocks', c."sceneBlocks", 'censorSegments', c."censorSegments",
        'mediaMotions', c."mediaMotions", 'emphasisWords', c."emphasisWords", 'wholeSource', c."wholeSource"),
      'evidence', json_build_object('automatic', c."autoLayoutAnalysis", 'screen', c."layoutAnalysis", 'split', c."splitLayoutAnalysis"),
      'project', json_build_object('sourceStorageKey', p."sourceStorageKey", 'sourceMimeType', p."sourceMimeType", 'sourceSizeBytes', p."sourceSizeBytes",
        'sourceDurationSeconds', p."sourceDurationSeconds", 'languageCode', p."languageCode", 'sourceType', p."sourceType")
    ) from "Clip" c join "Project" p on p.id = c."projectId" where c.id = '${clipId}'`,
  );
  const clip = row.clip;
  const documentInput = {
    version: EDITOR_DOCUMENT_VERSION,
    sceneBlocks: clip.sceneBlocks,
    censorSegments: clip.censorSegments,
    mediaMotions: clip.mediaMotions,
    clipStartSec: clip.startSec,
    clipEndSec: clip.endSec,
    captionPreset: clip.captionPreset ?? DEFAULT_CAPTION_PRESET,
    transcriptSlice: clip.transcriptSlice,
    studioEdits: clip.studioEdits ?? undefined,
    brollUrl: clip.brollUrl,
    deletedRanges: clip.deletedRanges ?? [],
    ...(clip.emphasisWords ? { emphasisWords: clip.emphasisWords } : {}),
  };
  const document = editorDocumentSchema.parse(documentInput);
  await writeFile(join(outDir, "document.json"), `${JSON.stringify(document, null, 2)}\n`);
  await writeFile(join(outDir, "evidence.json"), `${JSON.stringify(row.evidence, null, 2)}\n`);
  const meta = {
    clipId: clip.id,
    projectId: clip.projectId,
    title: clip.title,
    status: clip.status,
    editorRevision: clip.editorRevision,
    wholeSource: clip.wholeSource,
    project: { ...row.project, sourceStorageKey: undefined },
    storedPresetId: (clip.captionPreset as { id?: string } | null)?.id ?? null,
  };
  await writeFile(join(outDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(JSON.stringify({ clipId: clip.id, durationSec: document.clipEndSec - document.clipStartSec, utterances: document.transcriptSlice.length, deletedRanges: document.deletedRanges.length, sourceBytes: row.project.sourceSizeBytes }));

  if (noSource) return;
  const sourceKey = row.project.sourceStorageKey as string | null;
  if (!sourceKey) throw new Error("project has no source object");
  const target = join(outDir, "source.mp4");
  if (existsSync(target)) {
    console.log("source.mp4 already present; skipping download");
    return;
  }
  const env = readEnvFile(join(REPO_ROOT, "apps/api/.dev.vars"));
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) throw new Error("R2 credentials missing in apps/api/.dev.vars");
  // The S3 client lives in packages/services (the media app does not depend on it); this one-off tool loads it by path.
  const sdk: any = await import(join(REPO_ROOT, "packages/services/node_modules/@aws-sdk/client-s3"));
  const client = new sdk.S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  const response = await client.send(new sdk.GetObjectCommand({ Bucket: R2_BUCKET, Key: sourceKey }));
  if (!response.Body) throw new Error("empty source body");
  await pipeline(Readable.fromWeb(response.Body.transformToWebStream() as never), createWriteStream(`${target}.partial`));
  const { renameSync } = await import("node:fs");
  renameSync(`${target}.partial`, target);
  console.log(`source.mp4 downloaded (${response.ContentLength ?? "?"} bytes)`);
}

await main();
