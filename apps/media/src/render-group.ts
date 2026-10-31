import { isDeepStrictEqual } from "node:util";
import { basename } from "node:path";
import { renderFfmpegArgs } from "./ffmpeg-thread-policy";
import { clipAspectRatioFromDb, clipAspectRatioOptions, sourceProbeSchema } from "@narriflow/validators";
import { renderExecutionInputSchema, renderGroupOutcomeSchema, type RenderExecutionInput } from "@narriflow/validators/render-execution";
import { encodeRenderExecutionInput } from "@narriflow/services/render-execution-input";
import { WorkflowAttemptLost, WorkflowFailure } from "@narriflow/services/workflow-attempt-contract";
import { assertPublicHttpUrl } from "@narriflow/services/url-policy";
import { clipExportAttemptStorageKey, clipRenderAttemptStorageKey } from "./render-object-key";
import { parseRenderConfig } from "./render-config";
import { createWorkerProcessModule } from "./worker-process";
import { createClipRenderAttempt, type ClipRenderControlPorts } from "./tasks/clip-render-attempt-runtime";
import type { ClipRenderAttemptAdapters, ClipRenderingWorkflowAttempt } from "./tasks/clip-render-attempt";

export interface RenderInvocationPorts {
  request(command: Record<string, unknown>): Promise<Record<string, unknown>>;
  sourceUrl(name: string): string;
  /** Only pairs assigned to this current attempt are eligible to render. */
  renderIds: readonly string[];
}

/** The existing renderer gets a frozen read view and real signed publication ports. */
export async function renderGroup(options: { input: RenderExecutionInput; attemptToken: string; work: string; signal: AbortSignal; ports: RenderInvocationPorts }) {
  const input = renderExecutionInputSchema.parse(options.input);
  await encodeRenderExecutionInput(input);
  const source = input.preparation.source, doc = input.preparation.document;
  const attempt: ClipRenderingWorkflowAttempt = { projectId: input.preparation.projectId, workflowRunId: input.workflowRunId,
    stage: "clip_rendering", attemptId: options.attemptToken, attemptCount: 1 };
  if (!options.ports.renderIds.length || new Set(options.ports.renderIds).size !== options.ports.renderIds.length || options.ports.renderIds.some(id => !input.variants.some(variant => variant.renderId === id))) throw new Error("render_command_invalid");
  const lost = (): never => { throw new WorkflowAttemptLost(attempt); };
  const request = async (command: Record<string, unknown>) => { options.signal.throwIfAborted(); try { return await options.ports.request(command); } catch { return lost(); } };
  const originalUrl = options.ports.sourceUrl("original");
  const assets = [...input.assets.visuals, ...input.assets.fonts, ...input.assets.audio, ...(input.assets.logo ? [input.assets.logo] : [])];
  const sources = new Map<string, { name: string; object: { storageKey: string; etag: string; byteLength: number; sha256?: string } }>([[source.storageKey, { name: "original", object: source }], ...assets.map(asset => [asset.object.storageKey, asset] as const)]);
  const urlSources = new Map([...sources.values()].map(value => [options.ports.sourceUrl(value.name), value]));
  const logicalKeys = new Map(input.variants.map(variant => {
    const aspect = clipAspectRatioFromDb[variant.aspectRatio], slug = clipAspectRatioOptions.find(option => option.value === aspect)!.slug;
    const key = variant.export ? clipExportAttemptStorageKey({ projectId: attempt.projectId, exportId: variant.export.id, variantId: variant.exportVariantId!, aspectRatioSlug: slug, attemptId: attempt.attemptId })
      : clipRenderAttemptStorageKey(attempt.projectId, input.preparation.clipId, slug, attempt.attemptId);
    return [key, variant.renderId];
  }));
  const clip = { id: input.preparation.clipId, ...input.clip, editorRevision: input.preparation.editorRevision, llmModel: input.preparation.llmModel,
    wholeSource: input.preparation.wholeSource, previewStorageKey: input.prepared.preview.storageKey,
    editorDocumentVersion: doc.version, startSec: doc.clipStartSec, endSec: doc.clipEndSec, captionPreset: doc.captionPreset,
    transcriptSlice: doc.transcriptSlice, studioEdits: doc.studioEdits, brollUrl: doc.brollUrl, deletedRanges: doc.deletedRanges,
    sceneBlocks: doc.sceneBlocks, censorSegments: doc.censorSegments, mediaMotions: doc.mediaMotions,
    autoLayoutAnalysis: input.prepared.result.layout.automatic, layoutAnalysis: input.prepared.result.layout.screen, splitLayoutAnalysis: input.prepared.result.layout.split };
  const frozen = { sourceStorageKey: source.storageKey, sourceSizeBytes: source.byteLength, sourceDurationSeconds: input.preparation.sourceProbe.durationSec,
    frozenWatermark: input.watermark,
    workspaceOwnerUserId: input.workspace.ownerUserId, workspaceId: input.workspace.id, captionLanguage: input.captionLanguage,
    pricingTier: input.workspace.pricingTier, brandSnapshot: { status: "available" as const, value: input.brandSnapshot },
    pendingRenders: input.variants.filter(variant => options.ports.renderIds.includes(variant.renderId)).map(variant => ({ id: variant.renderId,
      clipId: clip.id, aspectRatio: variant.aspectRatio, resolution: variant.resolution, editorRevision: clip.editorRevision, clip,
      clipSnapshot: variant.export ? clip : null, exportVariantId: variant.exportVariantId, exportVariant: variant.export ? { exportId: variant.export.id, watermark: variant.export.watermark } : null })) };
  const immutableLayout = async (): Promise<never> => { throw new WorkflowFailure("prepared_layout_immutable", "permanent", "Completed source observations cannot be analyzed again"); };
  const ports: ClipRenderControlPorts = {
    state: { getFrozenRenderingStateForWorkSet: async (projectId, workflowRunId, ids) => {
      if (projectId !== attempt.projectId || workflowRunId !== attempt.workflowRunId || !ids || !isDeepStrictEqual([...ids].sort(), [...options.ports.renderIds].sort())) return lost();
      return frozen as unknown as NonNullable<Awaited<ReturnType<ClipRenderAttemptAdapters["state"]["getFrozenRenderingStateForWorkSet"]>>>;
    }, getProjectRenderStorageReferences: async () => { throw new Error("render_cleanup_owned_by_api"); } },
    layoutEvidence: { completedPreparation: true, readCompatibleDurable: async (clipId, expected) => {
      if (clipId !== clip.id || expected.editorRevision !== clip.editorRevision || expected.previewStorageKey !== clip.previewStorageKey) return lost();
      return input.prepared.result.layout;
    } },
    clip: { markClipRenderVariantRendering: async (_attempt, renderId) => options.ports.renderIds.includes(renderId),
      completeClipRenderVariant: async (_attempt, renderId, facts) => {
        if (logicalKeys.get(facts.storageKey) !== renderId) return lost();
        await request({ operation: "complete", renderId, byteLength: facts.sizeBytes, durationSec: facts.durationSec, captionDiagnostics: facts.captionDiagnostics ?? null });
        return { persisted: true };
      }, failClipRenderVariant: async (_attempt, renderId, errorCode, disposition = "retryable") => { await request({ operation: "fail", renderId, errorCode, disposition }); },
      completeClipAutoLayoutAnalysis: immutableLayout, completeClipSplitLayoutAnalysis: immutableLayout,
      completeClipSplitLayoutFailure: immutableLayout, setClipLayoutAnalysis: immutableLayout, setClipLayoutAnalysisFailure: immutableLayout },
    audioAsset: { resolveRenderSource: async (ownerId, assetId, workspaceId) => {
      if (ownerId !== input.workspace.ownerUserId || workspaceId !== input.workspace.id) return lost();
      const asset = input.assets.audio.find(value => value.id === assetId);
      return asset ? { url: options.ports.sourceUrl(asset.name), title: asset.title, durationSec: asset.durationSec } : null;
    } },
    assets: { loadSceneSources: async query => {
      if (query.workspaceId !== input.workspace.id) return lost();
      return { visuals: input.assets.visuals.filter(asset => query.visualIds.includes(asset.id)).map(asset => ({ id: asset.id, kind: asset.kind, fingerprint: asset.fingerprint, storageKey: asset.object.storageKey })),
        fonts: input.assets.fonts.filter(asset => query.fontIds.includes(asset.id)).map(asset => ({ id: asset.id, family: asset.family, fingerprint: asset.fingerprint, storageKey: asset.object.storageKey, format: asset.format })) };
    } },
    storage: { deleteObject: async () => { throw new Error("render_cleanup_owned_by_api"); },
      sourceSizeBytes: async key => { const found = sources.get(key); if (!found) return lost(); return found.object.byteLength; },
      presignDownloadUrl: async ({ key }) => { const found = sources.get(key); if (!found) return lost(); return options.ports.sourceUrl(found.name); },
      downloadObjectToFile: async ({ key, filePath }) => { const found = sources.get(key); if (!found) throw new WorkflowFailure("render_asset_unavailable", "permanent", "Optional frozen asset is unavailable"); await request({ operation: "download", sourceName: found.name, path: filePath, maxBytes: found.object.byteLength }); return { key, contentType: null }; },
      putFileFromPath: async ({ key, filePath, contentType, metadata }) => {
        const renderId = logicalKeys.get(key); if (!renderId || !options.ports.renderIds.includes(renderId) || contentType !== "video/mp4") return lost();
        const credits: unknown = metadata?.broll_credits ? JSON.parse(metadata.broll_credits) : [];
        if (!Array.isArray(credits) || credits.length > 6) return lost();
        const usedStockIds = [...new Set(credits.map(credit => {
          const matched = input.autoBroll.resolved.find(slot => isDeepStrictEqual(credit, { query: slot.query, startSec: slot.startSec, endSec: slot.endSec,
            authorName: slot.attribution.authorName, authorUrl: slot.attribution.authorUrl, pageUrl: slot.attribution.pageUrl }));
          if (!matched) return lost(); return matched.attribution.pexelsId;
        }))];
        await request({ operation: "upload", renderId, path: filePath, usedStockIds });
        return { key, fileName: key.split("/").at(-1)! };
      } },
    resolveBrollCutaways: async query => {
      const { fetchImpl: _fetch, ...semantic } = query;
      if (!isDeepStrictEqual(semantic, input.autoBroll.request)) throw new WorkflowFailure("frozen_broll_plan_invalid", "permanent", "Stock media request differs from the frozen plan");
      return input.autoBroll.resolved;
    },
  };
  const worker = createWorkerProcessModule({ scratchRoot: options.work });
  const config = { ...parseRenderConfig({}), pexelsConfigured: input.autoBroll.configured };
  let errorLines = 0;
  const renderer = createClipRenderAttempt({ run: { id: attempt.workflowRunId, projectId: attempt.projectId }, config, ports,
    lifecycle: { beginRenderGroup: async () => ({ variantIds: options.ports.renderIds }), startExecution: async () => { await request({ operation: "authority" }); },
      finishRenderGroup: async () => renderGroupOutcomeSchema.parse(await request({ operation: "finish" })) },
    adapters: { diagnose: event => {
      const code = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9_]{0,99}$/.test(value) ? value : undefined;
      if (event.level === "error" && errorLines++ < 16) console.error(JSON.stringify({ level: "error", message: code(event.message), failureCode: code(event.context?.failureCode ?? event.context?.errorCode), operation: code(event.context?.operation) }));
      if (event.message === "clip_render_attempt_metrics") console.error(JSON.stringify({ level: "info", message: event.message, counts: event.context?.counts, phaseMs: event.context?.phaseMs }));
    }, workerProcess: { ...worker, execute: request => worker.execute({ ...request, args: basename(request.command) === "ffmpeg" ? renderFfmpegArgs(request.args) : request.args }), withScratchDirectory: worker.withScratchDirectory.bind(worker),
      inspectMedia: async query => { const inspected = await worker.inspectMedia(query); if (query.sourcePath === originalUrl &&
        !isDeepStrictEqual(sourceProbeSchema.parse(inspected.sourceProbe), sourceProbeSchema.parse(input.preparation.sourceProbe))) throw new WorkflowFailure("source_identity_mismatch", "permanent", "Frozen source probe changed"); return inspected; } },
      optionalAssets: { assertUrlAllowed: url => { if (!urlSources.has(url)) assertPublicHttpUrl(url); }, downloadUrlToFile: async (url, path, _code, settings) => {
        const found = urlSources.get(url);
        if (found) { await request({ operation: "download", sourceName: found.name, path, maxBytes: settings?.maxBytes ?? found.object.byteLength }); return; }
        // Only owned loopback URLs use the scoped storage port. Public media
        // keeps the existing guarded download/validation adapter below.
        await publicDownload(url, path, _code, settings);
      } },
    },
  });
  // Resolve the existing guarded public downloader once, preserving its policy.
  const { createNativeRenderAdapters } = await import("./render-media-adapters");
  const publicDownload = createNativeRenderAdapters({ config, signal: options.signal, diagnose: () => {}, resolveBrollCutaways: ports.resolveBrollCutaways }).optionalAssets.downloadUrlToFile;
  return renderer.execute(attempt, { signal: options.signal, reportProgress: async () => {} });
}
