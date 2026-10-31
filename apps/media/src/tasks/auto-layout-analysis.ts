
import { compositionAssetRef } from "@narriflow/composition-plan";
import { type ClipPendingAutoLayoutAnalysis } from "@narriflow/services";
import { CLIP_AUTO_LAYOUT_ENGINE, type ClipAutoLayoutAnalysis } from "@narriflow/validators";
import { LayoutEvidence, type LayoutEvidenceDependencies } from "../layout-evidence";
import { createLayoutEvidenceDetectors } from "../layout-evidence-runtime";
import { parseWorkerRenderConfig, type RenderConfig } from "../render-config";
import { productionWorkerProcessModule, resolveDisplayGeometry, type WorkerProcessModule } from "../worker-process";


export function log(level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>): void {
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
  const sourceIdentity = compositionAssetRef("source", clip.projectId);
  // Detector coordinates come from the autorotated proxy, so the analysis is
  // recorded against display-oriented, square-pixel source dimensions.
  const display = original.hasVideo ? resolveDisplayGeometry(original) : { width: 0, height: 0 };
  if (original.hasVideo && (display.width <= 0 || display.height <= 0)) throw new Error("original source dimensions unavailable");
  const owner = new LayoutEvidence({
    source: { identity: sourceIdentity, hasVideo: original.hasVideo, width: display.width || 1, height: display.height || 1 },
    clip: { id: clip.id, startSec: clip.startSec, endSec: clip.endSec, deletedRanges: clip.deletedRanges, utterances: clip.transcriptSlice, editorRevision: clip.editorRevision, previewStorageKey: clip.previewStorageKey },
    durable: {}, enabled: { automatic: true, screen: false, split: false }, hasBroll: false, retryPolicy: "background", pipMotionThreshold: config.pipMotionThreshold, signal,
    sceneSource: { path: params.originalSourcePath, startSec: clip.startSec },
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
