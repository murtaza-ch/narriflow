import { downloadObjectToFile } from "../r2-file-transfer";
import { analyzeClipAutoLayout, log } from "../../../media/src/tasks/auto-layout-analysis";
export { analyzeClipAutoLayout } from "../../../media/src/tasks/auto-layout-analysis";
import { join } from "node:path";
import { getLayoutEvidenceLifecycle, LayoutEvidenceClaimLost, WorkflowFailure, presignDownloadUrl, type LayoutEvidenceLifecycle, } from "@narriflow/services";
import { parseWorkerRenderConfig, type RenderConfig } from "../../../media/src/render-config";
import { productionWorkerProcessModule, WorkerProcessFailure, type WorkerProcessModule } from "../../../media/src/worker-process";

type AutomaticLayoutLifecycle = Pick<LayoutEvidenceLifecycle, "claimAutomatic" | "runAutomaticClaim" | "completeAutomatic" | "deferAutomatic">;

export async function processPendingAutoLayoutAnalyses(options: {
  limit?: number;
  signal?: AbortSignal;
  workerProcess?: WorkerProcessModule;
  config?: Readonly<RenderConfig>;
  lifecycle?: AutomaticLayoutLifecycle;
  storage?: { presignDownloadUrl: typeof presignDownloadUrl; downloadObjectToFile: typeof downloadObjectToFile };
} = {}): Promise<number> {
  const config = options.config ?? parseWorkerRenderConfig();
  const limit = options.limit ?? config.autoLayoutBatchSize;
  const signal = options.signal ?? new AbortController().signal;
  const workerProcess = options.workerProcess ?? productionWorkerProcessModule;
  const lifecycle = options.lifecycle ?? getLayoutEvidenceLifecycle();
  const storage = options.storage ?? { presignDownloadUrl, downloadObjectToFile };
  let completed = 0;
  // Sequential just-in-time claims keep later leases from expiring in a batch.
  for (let attempt = 0; attempt < limit; attempt += 1) {
    signal.throwIfAborted();
    const clip = await lifecycle.claimAutomatic(config.autoLayoutLeaseMs);
    if (!clip) break;
    await lifecycle.runAutomaticClaim(clip, async ({ signal: claimSignal }) => workerProcess.withScratchDirectory("narriflow-auto-layout-", async (tempDir) => {
      try {
        claimSignal.throwIfAborted();
        const originalSourcePath = await storage.presignDownloadUrl({ key: clip.sourceStorageKey });
        claimSignal.throwIfAborted();
        const previewPath = join(tempDir, "preview.mp4");
        await storage.downloadObjectToFile({ key: clip.previewStorageKey, filePath: previewPath, signal: claimSignal });
        let persisted = false;
        const analysis = await analyzeClipAutoLayout({ clip, previewPath, originalSourcePath, signal: claimSignal, workerProcess, config,
          persist: async (write) => {
            if (write.kind !== "automatic") throw new Error("unexpected background layout evidence");
            // Detectors read the preview proxy here, unlike a render's source extraction.
            persisted = await lifecycle.completeAutomatic(clip.id, { ...write.value, analysisPath: "proxy" }, { editorRevision: clip.editorRevision, previewStorageKey: clip.previewStorageKey, claimToken: clip.autoLayoutClaimToken });
            return persisted;
          },
        });
        if (persisted) {
          completed += 1;
          log("info", "clip_auto_layout_analysis_completed", { clipId: clip.id, projectId: clip.projectId, segmentCount: analysis.segments.length, twoUpSegmentCount: analysis.twoUpSegmentCount });
        } else await lifecycle.deferAutomatic(clip.id, clip.autoLayoutClaimToken, new Date());
      } catch (error) {
        // The service claim runner owns immediate release on cancellation or
        // claim loss. Ordinary failures use the configured durable backoff.
        claimSignal.throwIfAborted();
        await lifecycle.deferAutomatic(clip.id, clip.autoLayoutClaimToken, new Date(Date.now() + config.autoLayoutFailureBackoffMs)).catch((deferError: unknown) => {
          log("error", "clip_auto_layout_analysis_defer_failed", { clipId: clip.id, failureCode: deferError instanceof WorkflowFailure ? deferError.code : "analysis_defer_failed" });
        });
        claimSignal.throwIfAborted();
        if (error instanceof WorkerProcessFailure && error.failureScope) throw error;
        log("error", "clip_auto_layout_analysis_failed", { clipId: clip.id, projectId: clip.projectId, failureCode: error instanceof WorkflowFailure ? error.code : "analysis_unavailable" });
      }
    }), { signal }).catch((error: unknown) => {
      if (error instanceof LayoutEvidenceClaimLost) {
        log("info", "clip_auto_layout_claim_lost", { clipId: clip.id, projectId: clip.projectId });
        return;
      }
      throw error;
    });
  }
  return completed;
}
