import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import archiver from "archiver";
import { getPrismaClient } from "@narriflow/db/client";
import {
  adoptExportBundlePublication,
  admitExportBundleCleanup,
  copyObject,
  currentWorkflowAttempt,
  downloadObjectToFile,
  EXPORT_BUNDLE_CLEANUP_HOLD_MS,
  exportBundleStorageKeys,
  getWorkflowRunLifecycle,
  planExportBundleCleanup,
  putFileFromPath,
  releaseExportBundleCleanup,
  renewExportBundleCleanup,
  retireExpiredExportBundle,
  rethrowWorkflowAttemptLost,
  workflowFailureFromUnknown,
} from "@narriflow/services";
import { exportBundleManifestSchema, type ExportBundleManifest } from "@narriflow/validators";

interface ExportBundleHeartbeatScheduler {
  start(callback: () => Promise<void>, intervalMs: number): () => void;
}

const defaultExportBundleHeartbeatScheduler: ExportBundleHeartbeatScheduler = {
  start(callback, intervalMs) {
    const timer = setInterval(() => void callback(), intervalMs);
    return () => clearInterval(timer);
  },
};

const EXPORT_BUNDLE_CLEANUP_HEARTBEAT_MS =
  EXPORT_BUNDLE_CLEANUP_HOLD_MS / 3;

export async function createExportBundleArchive(input: {
  outputPath: string;
  manifest: ExportBundleManifest;
  files: Array<{ path: string; name: string }>;
  signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  const output = createWriteStream(input.outputPath, { flags: "wx" });
  const archive = archiver("zip", { zlib: { level: 6 } });
  const completion = pipeline(archive, output, { signal: input.signal });
  archive.append(`${JSON.stringify(input.manifest, null, 2)}\n`, { name: "manifest.json" });
  for (const file of input.files) {
    input.signal?.throwIfAborted();
    archive.append(createReadStream(file.path), { name: file.name });
  }
  await archive.finalize();
  await completion;
  input.signal?.throwIfAborted();
  return stat(input.outputPath);
}

async function hashFile(path: string, signal?: AbortSignal) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    signal?.throwIfAborted();
    digest.update(chunk);
  }
  signal?.throwIfAborted();
  return digest.digest("hex");
}

export async function runExportBundlePipeline<TArchive>(input: {
  entries: ReadonlyArray<{ variantId: string; name: string; sizeBytes: number }>;
  signal?: AbortSignal;
  heartbeatMs?: number;
  heartbeatScheduler?: ExportBundleHeartbeatScheduler;
  renewCleanup(): Promise<void>;
  download(
    entry: { variantId: string; name: string; sizeBytes: number },
    index: number,
    signal: AbortSignal,
  ): Promise<{ path: string; sizeBytes: number }>;
  archive(
    files: Array<{ path: string; name: string }>,
    signal: AbortSignal,
  ): Promise<TArchive>;
  upload(archive: TArchive, signal: AbortSignal): Promise<void>;
  assertOwnership(): Promise<void>;
  publish(signal: AbortSignal): Promise<void>;
  settle(archive: TArchive, signal: AbortSignal): Promise<void>;
}) {
  const operationController = new AbortController();
  const abortFromCaller = () => operationController.abort(input.signal?.reason);
  if (input.signal?.aborted) abortFromCaller();
  else input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const operationSignal = operationController.signal;
  let renewalFailure: unknown;
  let renewalInFlight: Promise<void> | null = null;
  const renewCleanup = async () => {
    while (renewalInFlight) {
      await renewalInFlight.catch(() => undefined);
    }
    if (renewalFailure) throw renewalFailure;
    operationSignal.throwIfAborted();
    const renewal = input.renewCleanup().catch((error) => {
      renewalFailure ??= error;
      operationController.abort(error);
      throw error;
    });
    renewalInFlight = renewal;
    try {
      await renewal;
    } finally {
      if (renewalInFlight === renewal) renewalInFlight = null;
    }
  };
  const heartbeatScheduler =
    input.heartbeatScheduler ?? defaultExportBundleHeartbeatScheduler;
  const stopHeartbeat = heartbeatScheduler.start(async () => {
    if (renewalInFlight || renewalFailure) return;
    await renewCleanup().catch(() => undefined);
  }, input.heartbeatMs ?? EXPORT_BUNDLE_CLEANUP_HEARTBEAT_MS);
  try {
    const files: Array<{ path: string; name: string }> = [];
    for (const [index, entry] of input.entries.entries()) {
      operationSignal.throwIfAborted();
      const downloaded = await input.download(entry, index, operationSignal);
      if (downloaded.sizeBytes !== entry.sizeBytes) {
        throw new Error("export_bundle_variant_size_mismatch");
      }
      files.push({ path: downloaded.path, name: entry.name });
    }
    operationSignal.throwIfAborted();
    const archive = await input.archive(files, operationSignal);
    operationSignal.throwIfAborted();
    await renewCleanup();
    operationSignal.throwIfAborted();
    await input.upload(archive, operationSignal);
    await input.assertOwnership();
    await renewCleanup();
    operationSignal.throwIfAborted();
    await input.publish(operationSignal);
    await input.assertOwnership();
    await renewCleanup();
    operationSignal.throwIfAborted();
    await input.settle(archive, operationSignal);
    return archive;
  } finally {
    stopHeartbeat();
    const activeRenewal = renewalInFlight as Promise<void> | null;
    await activeRenewal?.catch(() => undefined);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function processExportBundleRun(run: { id: string; projectId: string; attemptId: string | null }, signal?: AbortSignal) {
  if (!run.attemptId) throw new Error("export_bundle_attempt_missing");
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  const bundle = await prisma.exportBundle.findUnique({ where: { workflowRunId: run.id }, include: { operation: { include: { items: true } } } });
  if (!bundle || bundle.operation.projectId !== run.projectId) throw new Error("export_bundle_not_found");
  const attempt = currentWorkflowAttempt(run.id);
  if (!attempt) throw new Error("export_bundle_attempt_context_missing");
  const lifecycle = getWorkflowRunLifecycle();
  if (bundle.status === "completed") {
    await lifecycle.completeStage(attempt);
    return;
  }
  const manifest = exportBundleManifestSchema.parse(bundle.manifest);
  const variantIds = manifest.included.flatMap((item) => item.files.map((file) => file.variantId));
  const variants = await prisma.clipExportVariant.findMany({
    where: { id: { in: variantIds }, status: "completed", storageKey: { not: null }, export: { campaignOperationItems: { some: { operationId: bundle.operationId } } } },
    select: { id: true, storageKey: true },
  });
  const byId = new Map(variants.map((variant) => [variant.id, variant.storageKey!]));
  if (byId.size !== variantIds.length) throw new Error("export_bundle_variant_missing");
  const directory = await mkdtemp(join(tmpdir(), "narriflow-export-bundle-"));
  const archivePath = join(directory, "bundle.zip");
  // Publication keys remain attempt-scoped. A stale worker that loses its
  // lease after copying can then remove only its own object, never the object
  // published by a winning takeover attempt.
  const { attemptKey, finalKey } = exportBundleStorageKeys(run.projectId, bundle.operationId, run.attemptId);
  const cleanupPlan = planExportBundleCleanup(
    run.projectId,
    bundle.operationId,
    run.attemptId,
    new Date(),
  );
  let finalPublished = false;
  let bundleSettled = false;
  try {
    await lifecycle.mutateOwnedAttempt(attempt, async (tx) => {
      await admitExportBundleCleanup(
        tx.mediaCleanupObligation,
        cleanupPlan,
      );
      await tx.exportBundle.update({ where: { id: bundle.id }, data: { status: "building", attemptStorageKey: attemptKey, errorCode: null } });
      await tx.campaignOperationItem.updateMany({ where: { operationId: bundle.operationId, status: "failed", errorCode: "export_bundle_build_failed" }, data: { status: "pending", errorCode: null, settledAt: null } });
      await tx.campaignOperation.update({ where: { id: bundle.operationId }, data: { status: "running", succeededCount: 0, failedCount: 0, completedAt: null } });
    });
    const entries = manifest.included.flatMap((item) => item.files);
    await runExportBundlePipeline({
      entries,
      signal,
      renewCleanup: async () => {
        await renewExportBundleCleanup(
          prisma.mediaCleanupObligation,
          cleanupPlan,
          new Date(),
        );
      },
      download: async (entry, _index, operationSignal) => {
        const path = join(directory, `${entry.variantId}.mp4`);
        await downloadObjectToFile({
          key: byId.get(entry.variantId)!,
          filePath: path,
          signal: operationSignal,
        });
        const downloaded = await stat(path);
        return { path, sizeBytes: downloaded.size };
      },
      archive: async (files, operationSignal) => {
        const archiveInfo = await createExportBundleArchive({
          outputPath: archivePath,
          manifest,
          files,
          signal: operationSignal,
        });
        return {
          archiveInfo,
          checksumSha256: await hashFile(archivePath, operationSignal),
        };
      },
      upload: async (_archive, operationSignal) => {
        await putFileFromPath({ key: attemptKey, filePath: archivePath, contentType: "application/zip", metadata: { operation_id: bundle.operationId, workflow_attempt_id: run.attemptId! }, signal: operationSignal });
      },
      assertOwnership: () => lifecycle.assertOwnership(attempt),
      publish: async (operationSignal) => {
        await copyObject({
          sourceKey: attemptKey,
          destinationKey: finalKey,
          signal: operationSignal,
        });
        finalPublished = true;
      },
      settle: async ({ archiveInfo, checksumSha256 }, operationSignal) => {
        operationSignal.throwIfAborted();
        await lifecycle.mutateOwnedAttempt(attempt, async (tx) => {
          const adoptionNow = new Date();
          await adoptExportBundlePublication(
            tx.mediaCleanupObligation,
            cleanupPlan,
            adoptionNow,
          );
          await tx.campaignOperationItem.updateMany({ where: { operationId: bundle.operationId, status: "pending" }, data: { status: "succeeded", settledAt: new Date(), errorCode: null } });
          await tx.exportBundle.update({ where: { id: bundle.id }, data: { status: "completed", attemptStorageKey: null, storageKey: finalKey, sizeBytes: BigInt(archiveInfo.size), checksumSha256, completedAt: new Date(), errorCode: null } });
					await tx.campaignOperation.update({ where: { id: bundle.operationId }, data: { status: manifest.excluded.length ? "partial" : "completed", succeededCount: manifest.included.length, failedCount: 0, completedAt: new Date() } });
        });
        bundleSettled = true;
      },
    });
    await lifecycle.completeStage(attempt);
    await releaseExportBundleCleanup(
      prisma.mediaCleanupObligation,
      cleanupPlan,
      [cleanupPlan.obligations[0]],
      new Date(),
    ).catch(() => undefined);
  } catch (error) {
    if (finalPublished && !bundleSettled) {
      await releaseExportBundleCleanup(
        prisma.mediaCleanupObligation,
        cleanupPlan,
        [cleanupPlan.obligations[1]],
        new Date(),
      ).catch(() => undefined);
    }
    await releaseExportBundleCleanup(
      prisma.mediaCleanupObligation,
      cleanupPlan,
      [cleanupPlan.obligations[0]],
      new Date(),
    ).catch(() => undefined);
    rethrowWorkflowAttemptLost(error);
    if (!bundleSettled) {
      await lifecycle.mutateOwnedAttempt(attempt, async (tx) => {
        await tx.exportBundle.update({ where: { id: bundle.id }, data: { status: "failed", attemptStorageKey: null, errorCode: "export_bundle_build_failed" } });
        await tx.campaignOperationItem.updateMany({ where: { operationId: bundle.operationId, status: "pending" }, data: { status: "failed", errorCode: "export_bundle_build_failed", settledAt: new Date() } });
        await tx.campaignOperation.update({ where: { id: bundle.operationId }, data: { status: "failed", succeededCount: 0, failedCount: manifest.included.length, completedAt: new Date() } });
      });
    }
    await lifecycle.failAttempt(attempt, workflowFailureFromUnknown(error));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type ExportBundleExpiryDependencies = {
	findExpired(now: Date, take: number): Promise<
		Array<{ id: string; projectId: string; storageKey: string }>
	>;
	retire(
		bundle: { id: string; projectId: string; storageKey: string },
		now: Date,
	): Promise<number>;
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
			select: { id: true, storageKey: true, operation: { select: { projectId: true } } },
			orderBy: { expiresAt: "asc" },
			take,
		})).map((bundle) => ({
			id: bundle.id,
			projectId: bundle.operation.projectId,
			storageKey: bundle.storageKey!,
		})),
		retire: async (bundle, retiredAt) => prisma!.$transaction((tx) =>
			retireExpiredExportBundle(tx, bundle, retiredAt),
		),
	};
	const expired = await runtime.findExpired(now, Math.max(1, Math.min(batchSize, 500)));
  let removed = 0;
  for (const bundle of expired) {
    try {
			removed += await runtime.retire(bundle, now);
    } catch (error) {
      console.warn(JSON.stringify({ level: "warn", message: "export_bundle_expiry_retirement_failed", bundleId: bundle.id, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  return removed;
}
