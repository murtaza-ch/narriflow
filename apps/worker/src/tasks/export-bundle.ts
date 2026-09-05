import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import archiver from "archiver";
import { getPrismaClient } from "@narriflow/db/client";
import {
  copyObject,
  type ClaimedWorkflowAttempt,
  deleteObject,
  downloadObjectToFile,
  getWorkflowRunLifecycle,
  putFileFromPath,
  rethrowWorkflowAttemptLost,
  type WorkflowAttemptContext,
  workflowFailureFromUnknown,
} from "@narriflow/services";
import { exportBundleManifestSchema, type ExportBundleManifest } from "@narriflow/validators";
import { productionWorkerProcessModule, type WorkerProcessModule } from "../worker-process";

export async function createExportBundleArchive(input: {
  outputPath: string;
  manifest: ExportBundleManifest;
  files: Array<{ path: string; name: string }>;
}) {
  const output = createWriteStream(input.outputPath, { flags: "wx" });
  const archive = archiver("zip", { zlib: { level: 6 } });
  const completion = pipeline(archive, output);
  archive.append(`${JSON.stringify(input.manifest, null, 2)}\n`, {
    name: "manifest.json",
  });
  for (const file of input.files) archive.append(createReadStream(file.path), { name: file.name });
  await archive.finalize();
  await completion;
  return stat(input.outputPath);
}

async function hashFile(path: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

export function exportBundleStorageKeys(projectId: string, operationId: string, attemptId: string) {
  const prefix = `projects/${projectId}/campaign-operations/${operationId}`;
  return {
    attemptKey: `${prefix}/attempts/${attemptId}.zip`,
    finalKey: `${prefix}/completed/${attemptId}.zip`,
  };
}

export async function runExportBundlePipeline<TArchive>(input: {
  entries: ReadonlyArray<{
    variantId: string;
    name: string;
    sizeBytes: number;
  }>;
  signal?: AbortSignal;
  download(
    entry: { variantId: string; name: string; sizeBytes: number },
    index: number,
  ): Promise<{ path: string; sizeBytes: number }>;
  archive(files: Array<{ path: string; name: string }>): Promise<TArchive>;
  upload(archive: TArchive): Promise<void>;
  assertOwnership(): Promise<void>;
  publish(): Promise<void>;
  settle(archive: TArchive): Promise<void>;
}) {
  const files: Array<{ path: string; name: string }> = [];
  for (const [index, entry] of input.entries.entries()) {
    input.signal?.throwIfAborted();
    const downloaded = await input.download(entry, index);
    if (downloaded.sizeBytes !== entry.sizeBytes) {
      throw new Error("export_bundle_variant_size_mismatch");
    }
    files.push({ path: downloaded.path, name: entry.name });
  }
  input.signal?.throwIfAborted();
  const archive = await input.archive(files);
  input.signal?.throwIfAborted();
  await input.upload(archive);
  await input.assertOwnership();
  await input.publish();
  await input.assertOwnership();
  await input.settle(archive);
  return archive;
}

export async function processExportBundleRun(
  attempt: ClaimedWorkflowAttempt,
  context: WorkflowAttemptContext,
  workerProcess: WorkerProcessModule = productionWorkerProcessModule,
) {
  const run = { ...attempt, id: attempt.workflowRunId };
  const { signal } = context;
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  const bundle = await prisma.exportBundle.findUnique({ where: { workflowRunId: run.id }, include: { operation: { include: { items: true } } } });
  if (!bundle || bundle.operation.projectId !== run.projectId) throw new Error("export_bundle_not_found");
  const lifecycle = getWorkflowRunLifecycle();
  if (bundle.status === "completed") {
    await lifecycle.completeStage(attempt);
    return;
  }
  const manifest = exportBundleManifestSchema.parse(bundle.manifest);
  const variantIds = manifest.included.flatMap((item) => item.files.map((file) => file.variantId));
  const variants = await prisma.clipExportVariant.findMany({
    where: {
      id: { in: variantIds },
      status: "completed",
      storageKey: { not: null },
      export: {
        campaignOperationItems: { some: { operationId: bundle.operationId } },
      },
    },
    select: { id: true, storageKey: true },
  });
  const byId = new Map(variants.map((variant) => [variant.id, variant.storageKey!]));
  if (byId.size !== variantIds.length) throw new Error("export_bundle_variant_missing");
  return workerProcess.withScratchDirectory("narriflow-export-bundle-", async (directory) => {
    const archivePath = join(directory, "bundle.zip");
    // Publication keys remain attempt-scoped. A stale worker that loses its
    // lease after copying can then remove only its own object, never the object
    // published by a winning takeover attempt.
    const { attemptKey, finalKey } = exportBundleStorageKeys(
      run.projectId,
      bundle.operationId,
      attempt.attemptId,
    );
    let finalPublished = false;
    let bundleSettled = false;
    try {
      await lifecycle.beginExportBundleBuild(attempt, {
        bundleId: bundle.id,
        operationId: bundle.operationId,
        attemptStorageKey: attemptKey,
      });
      const entries = manifest.included.flatMap((item) => item.files);
      await runExportBundlePipeline({
        entries,
        signal,
        download: async (entry) => {
          const path = join(directory, `${entry.variantId}.mp4`);
          await downloadObjectToFile({
            key: byId.get(entry.variantId)!,
            filePath: path,
            signal,
          });
          const downloaded = await stat(path);
          return { path, sizeBytes: downloaded.size };
        },
        archive: async (files) => {
          const archiveInfo = await createExportBundleArchive({
            outputPath: archivePath,
            manifest,
            files,
          });
          return { archiveInfo, checksumSha256: await hashFile(archivePath) };
        },
        upload: async () => {
          await putFileFromPath({
            key: attemptKey,
            filePath: archivePath,
            contentType: "application/zip",
            metadata: {
              operation_id: bundle.operationId,
              workflow_attempt_id: attempt.attemptId,
            },
            signal,
          });
        },
        assertOwnership: () => lifecycle.assertOwnership(attempt),
        publish: async () => {
          await copyObject({
            sourceKey: attemptKey,
            destinationKey: finalKey,
          });
          finalPublished = true;
        },
        settle: async ({ archiveInfo, checksumSha256 }) => {
          await lifecycle.completeExportBundleBuild(attempt, {
            bundleId: bundle.id,
            operationId: bundle.operationId,
            storageKey: finalKey,
            sizeBytes: archiveInfo.size,
            checksumSha256,
            operationStatus: manifest.excluded.length ? "partial" : "completed",
            succeededCount: manifest.included.length,
          });
          bundleSettled = true;
        },
      });
      await lifecycle.completeStage(attempt);
      await deleteObject(attemptKey, { signal }).catch(() => {});
    } catch (error) {
      signal.throwIfAborted();
      if (finalPublished && !bundleSettled) {
        await deleteObject(finalKey).catch(() => {});
      }
      await deleteObject(attemptKey).catch(() => {});
      rethrowWorkflowAttemptLost(error);
      if (!bundleSettled) {
        await lifecycle.failExportBundleBuild(attempt, {
          bundleId: bundle.id,
          operationId: bundle.operationId,
          errorCode: "export_bundle_build_failed",
          failedCount: manifest.included.length,
        });
      }
      await lifecycle.failAttempt(attempt, workflowFailureFromUnknown(error));
    }
  });
}

type ExportBundleExpiryDependencies = {
	findExpired(now: Date, take: number): Promise<Array<{ id: string; storageKey: string }>>;
	removeObject(storageKey: string): Promise<void>;
	markExpired(bundle: { id: string; storageKey: string }): Promise<number>;
};

export async function expireExportBundles(
	now = new Date(),
	batchSize = 100,
	dependencies?: ExportBundleExpiryDependencies,
) {
  const prisma = getPrismaClient();
	if (!dependencies && !prisma) return 0;
	const runtime: ExportBundleExpiryDependencies = dependencies ?? {
		findExpired: async (expiresBefore, take) => (await prisma!.exportBundle.findMany({
			where: { status: "completed", expiresAt: { lte: expiresBefore }, storageKey: { not: null } },
			select: { id: true, storageKey: true },
			orderBy: { expiresAt: "asc" },
			take,
		})).map((bundle) => ({ id: bundle.id, storageKey: bundle.storageKey! })),
		removeObject: async (storageKey) => {
			await deleteObject(storageKey);
		},
		markExpired: async (bundle) => (await prisma!.exportBundle.updateMany({
			where: { id: bundle.id, status: "completed", storageKey: bundle.storageKey },
			data: { status: "expired", storageKey: null },
		})).count,
	};
	const expired = await runtime.findExpired(now, Math.max(1, Math.min(batchSize, 500)));
  let removed = 0;
  for (const bundle of expired) {
    try {
			await runtime.removeObject(bundle.storageKey);
    } catch (error) {
      console.warn(JSON.stringify({ level: "warn", message: "export_bundle_expiry_delete_failed", bundleId: bundle.id, error: error instanceof Error ? error.message : String(error) }));
      continue;
    }
		removed += await runtime.markExpired(bundle);
  }
  return removed;
}
