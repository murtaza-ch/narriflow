import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OBJECT_CACHE_CONTROL, OBJECTS_DIR, PUBLIC_BUCKET, REPO_ROOT } from "./config";
import { readEnvFile, requireKeys, resolveFrom } from "./env";
import { readManifest } from "./manifest";
import { fileSize, log } from "./util";

/** The few S3 pieces used here. The real classes come from packages/services, which owns the dependency. */
interface S3Like {
  send(command: unknown): Promise<unknown>;
}
interface S3Commands {
  HeadObjectCommand: new (input: { Bucket: string; Key: string }) => unknown;
  PutObjectCommand: new (input: {
    Bucket: string;
    Key: string;
    Body: Uint8Array;
    ContentLength: number;
    ContentType: string;
    CacheControl: string;
  }) => unknown;
}

const R2_KEYS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const;

function isMissingObject(error: unknown): boolean {
  const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return failure.name === "NotFound" || failure.name === "NoSuchKey" || failure.$metadata?.httpStatusCode === 404;
}

/**
 * Both buckets get the same immutable object under the same key: the private
 * bucket serves renders, the public one serves browser previews. HEAD first,
 * so a rerun uploads only what is missing.
 */
export async function runUpload(dryRun: boolean): Promise<void> {
  const manifest = await readManifest();
  const env = readEnvFile("apps/api/.dev.vars");
  requireKeys(env, R2_KEYS, "apps/api/.dev.vars");
  const privateBucket = env.R2_BUCKET as string;
  const buckets = [...new Set([privateBucket, PUBLIC_BUCKET])];

  const objects = manifest.entries.map((entry) => ({
    key: entry.storageKey,
    path: join(OBJECTS_DIR, entry.kind, `${entry.sha256.slice(0, 16)}.mp3`),
  }));
  let totalBytes = 0;
  for (const object of objects) {
    const size = await fileSize(object.path);
    if (size === 0) throw new Error(`Encoded file missing for ${object.key}; run build`);
    totalBytes += size;
  }
  if (dryRun) {
    log("upload_plan", { buckets, objects: objects.length, megabytesPerBucket: Math.round((totalBytes / 1024 / 1024) * 10) / 10, cacheControl: OBJECT_CACHE_CONTROL });
    return;
  }

  const { HeadObjectCommand, PutObjectCommand } = (await import(resolveFrom("@aws-sdk/client-s3", "packages/services/src"))) as S3Commands;
  // The one place an R2 client is built: reuse it so the checksum workaround for R2 applies here too.
  const { createR2Client } = (await import(join(REPO_ROOT, "packages/services/src/r2-client.ts"))) as {
    createR2Client(credentials: { accountId: string; accessKeyId: string; secretAccessKey: string }): S3Like;
  };
  const client = createR2Client({
    accountId: env.R2_ACCOUNT_ID as string,
    accessKeyId: env.R2_ACCESS_KEY_ID as string,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
  });

  const counts = { uploaded: 0, skipped: 0 };
  for (const bucket of buckets) {
    for (const object of objects) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: object.key }));
        counts.skipped++;
        continue;
      } catch (error) {
        if (!isMissingObject(error)) throw error;
      }
      const body = await readFile(object.path);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: object.key,
          Body: body,
          ContentLength: body.byteLength,
          ContentType: "audio/mpeg",
          CacheControl: OBJECT_CACHE_CONTROL,
        }),
      );
      counts.uploaded++;
      if (counts.uploaded % 25 === 0) log("uploading", { bucket, ...counts });
    }
    log("bucket_done", { bucket, ...counts });
  }
  log("upload_done", { buckets, objects: objects.length, ...counts });
}
