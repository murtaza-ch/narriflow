import { join } from "node:path";
import { compositionAssetRef } from "@narriflow/composition-plan";
import { getLayoutEvidenceLifecycle, LayoutEvidenceClaimLost, downloadObjectToFile, presignDownloadUrl, type LayoutEvidenceLifecycle, type ClipPendingAutoLayoutAnalysis } from "@narriflow/services";
import { CLIP_AUTO_LAYOUT_ENGINE, type ClipAutoLayoutAnalysis } from "@narriflow/validators";
import { LayoutEvidence, type LayoutEvidenceDependencies } from "../layout-evidence";
import { createLayoutEvidenceDetectors } from "../layout-evidence-runtime";
import { parseWorkerRenderConfig, type RenderConfig } from "../render-config";
import { productionWorkerProcessModule, type WorkerProcessModule } from "../worker-process";

function log(level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>): void {
  console.warn(JSON.stringify({ level, message, ...context }));
}

/** Background and export use original source dimensions with normalized proxy
 * detector coordinates. A bounded source probe avoids storing proxy zoom policy. */
export async function analyzeClipAutoLayout(params: {
  clip: ClipPendingAutoLayoutAnalysis;
  previewPath: string;
  originalSourcePath: string;
  signal?: AbortSignal;
  workerProcess?: WorkerProcessModule;
  config?: Readonly<RenderConfig>;
  persist?: LayoutEvidenceDependencies["persist"];
}): Promise<ClipAutoLayoutAnalysis> {
  const { clip } = params;
  const signal = params.signal ?? new AbortController().signal;
  const workerProcess = params.workerProcess ?? productionWorkerProcessModule;
  const config = params.config ?? parseWorkerRenderConfig();
  signal.throwIfAborted();
  const original = await workerProcess.inspectMedia({ sourcePath: params.originalSourcePath, signal, deadlineMs: config.probeCommandTimeoutMs });
  signal.throwIfAborted();
  if (original.hasVideo && (original.width <= 0 || original.height <= 0)) throw new Error("original source dimensions unavailable");
  const sourceIdentity = compositionAssetRef("source", clip.projectId);
  const owner = new LayoutEvidence({
    source: { identity: sourceIdentity, hasVideo: original.hasVideo, width: original.width || 1, height: original.height || 1 },
    clip: { id: clip.id, startSec: clip.startSec, endSec: clip.endSec, deletedRanges: clip.deletedRanges, utterances: clip.transcriptSlice, editorRevision: clip.editorRevision, previewStorageKey: clip.previewStorageKey },
    durable: {}, enabled: { automatic: config.layoutEngineEnabled, screen: false, split: false }, hasBroll: false, pipMotionThreshold: config.pipMotionThreshold, signal,
    getSegment: async () => {
      const offset = clip.startSec - clip.previewStartSec;
      if (offset < -0.05) return null;
      return { path: params.previewPath, startSec: Math.max(0, offset), durationSec: Math.max(0, clip.previewDurationSec - Math.max(0, offset)) };
    },
  }, {
    detectors: createLayoutEvidenceDetectors({ workerProcess, config, signal }),
    persist: params.persist ?? (async () => true), now: Date.now,
    rethrowControl: () => signal.throwIfAborted(),
    diagnose: (message, context) => log("warn", message, context),
  });
  await owner.fulfill([{ key: `automatic-speaker-layout:${sourceIdentity}`, kind: "automatic-speaker-layout", engineVersion: CLIP_AUTO_LAYOUT_ENGINE }]);
  if (owner.resources.persistenceFailures > 0) throw new Error("automatic_layout_evidence_persist_failed");
  const result = owner.availability.automaticLayout;
  if (result.state !== "available") throw new Error(`automatic layout evidence ${result.state}`);
  return result.value.analysis;
}

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
  if (!config.autoLayoutAnalysisEnabled || !config.layoutEngineEnabled) return 0;
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
            persisted = await lifecycle.completeAutomatic(clip.id, write.value, { editorRevision: clip.editorRevision, previewStorageKey: clip.previewStorageKey, claimToken: clip.autoLayoutClaimToken });
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
          log("error", "clip_auto_layout_analysis_defer_failed", { clipId: clip.id, message: deferError instanceof Error ? deferError.message : "unknown" });
        });
        claimSignal.throwIfAborted();
        log("error", "clip_auto_layout_analysis_failed", { clipId: clip.id, projectId: clip.projectId, message: error instanceof Error ? error.message : "unknown" });
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
