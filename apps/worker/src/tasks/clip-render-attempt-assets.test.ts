import { describe, expect, test } from "bun:test";
import { WorkflowFailure, type WorkflowAttemptContext } from "@narriflow/services";
import { sceneBlockSchema, type SceneBlock } from "@narriflow/validators";
import { parseRenderConfig } from "../render-config";
import type { ClipRenderAttemptAdapters, ClipRenderingWorkflowAttempt } from "./clip-render-attempt";
import { createClipRenderAttempt } from "./clip-render-attempt-runtime";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const VISUAL_ID = "10000000-0000-4000-8000-000000000002";
const FONT_ID = "10000000-0000-4000-8000-000000000003";
const FINGERPRINT = "a".repeat(64);
const VISUAL = { id: VISUAL_ID, kind: "image" as const, fingerprint: FINGERPRINT, storageKey: "visuals/scene.png" };
const FONT = { id: FONT_ID, family: "Custom Scene Font", fingerprint: FINGERPRINT, storageKey: "fonts/scene.ttf", format: "TTF" };

function scene(id: number, content: SceneBlock["content"], anchorSec: number) {
  return sceneBlockSchema.parse({
    schemaVersion: 1,
    id: `20000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    anchorSec,
    durationSec: 1,
    content,
    motion: { entrance: "none", exit: "none", durationSec: 0.5 },
    templateSnapshot: null,
  });
}

const imageContent: SceneBlock["content"] = {
  kind: "image", asset: { kind: "visual_asset", id: VISUAL_ID, fingerprint: FINGERPRINT },
  fit: "contain", backgroundColor: "#000000",
};
const textContent: SceneBlock["content"] = {
  kind: "text", text: "Scene asset verification", fontFamily: FONT.family,
  fontAsset: { kind: "brand_font", id: FONT_ID, fingerprint: FINGERPRINT },
  color: "#FFFFFF", backgroundColor: "#000000",
};

type SceneSources = Awaited<ReturnType<ClipRenderAttemptAdapters["assets"]["loadSceneSources"]>>;
type PendingRender = NonNullable<Awaited<ReturnType<ClipRenderAttemptAdapters["state"]["getFrozenRenderingStateForWorkSet"]>>>["pendingRenders"][number];

function fixture(input: {
  sources?: SceneSources;
  loadFailure?: Error;
  duplicates?: boolean;
  imageDecodable?: boolean;
  completionAccepted?: boolean;
  cancelAssetDownload?: boolean;
  runtimeValidation?: boolean;
} = {}) {
  const attempt: ClipRenderingWorkflowAttempt = {
    workflowRunId: "30000000-0000-4000-8000-000000000001",
    projectId: "30000000-0000-4000-8000-000000000002",
    stage: "clip_rendering",
    attemptId: "30000000-0000-4000-8000-000000000003",
    attemptCount: 1,
  };
  const pendingRender = {
    id: "variant-scenes", clipId: "clip-scenes", aspectRatio: "ratio_9_16", resolution: "1080p",
    exportVariantId: null, exportVariant: null, clipSnapshot: null,
    clip: {
      id: "clip-scenes", index: 0, startSec: 0, endSec: 10, llmModel: "caption-only",
      transcriptSlice: [], deletedRanges: null, captionPreset: null, studioEdits: null,
      editorDocumentVersion: 2,
      sceneBlocks: [scene(1, imageContent, 1), scene(2, textContent, 4),
        ...(input.duplicates ? [scene(3, imageContent, 7), scene(4, textContent, 9)] : [])],
      censorSegments: [], mediaMotions: [], brollCues: null, brollUrl: null, category: "other",
    },
  } as unknown as PendingRender;
  const controller = new AbortController();
  const cancellation = new DOMException("Scene download cancelled", "AbortError");
  const loaded: Array<Parameters<ClipRenderAttemptAdapters["assets"]["loadSceneSources"]>[0]> = [];
  const downloads: Array<{ key: string; path: string; signal: AbortSignal | undefined }> = [];
  const validations: Array<{ path: string; kind: string }> = [];
  const commands: string[][] = [];
  const diagnostics: Array<Parameters<ClipRenderAttemptAdapters["diagnose"]>[0]> = [];
  const uploads: string[] = [];
  const deleted: string[] = [];
  const failures: Array<{ code: string; disposition: string | undefined }> = [];
  const completions: Array<{ storageKey: string; durationSec: number }> = [];
  let state: "pending" | "rendering" | "completed" | "failed" | "retryable" | "superseded" = "pending";
  let settlements = 0;
  let cleanups = 0;
  const clipRenderAttempt = createClipRenderAttempt({
    run: { id: attempt.workflowRunId, projectId: attempt.projectId, project: {
      title: "Scene assets", sourceStorageKey: "source/input.mp4", sourceDurationSeconds: 10,
      workspaceId: WORKSPACE_ID,
    } },
    config: parseRenderConfig({ WORKER_CLIP_RENDER_ATTEMPT_ENABLED: "1", WORKER_RENDER_SOURCE_MODE: "download",
      WORKER_LAYOUT_ENGINE: "0", WORKER_SCREEN_LAYOUT: "0", WORKER_SPLIT: "0", WORKER_BROLL: "0" }),
    lifecycle: {
      beginRenderWorkSet: async (owned) => { expect(owned).toEqual(attempt); return { variantIds: [pendingRender.id] }; },
      settleRenderWorkSet: async (owned) => {
        expect(owned).toEqual(attempt);
        settlements += 1;
        return { status: state === "retryable" ? "requeued" : state === "failed" ? "failed" : "completed",
          requested: 1, succeeded: state === "completed" ? 1 : 0, failed: state === "failed" ? 1 : 0,
          superseded: state === "superseded" ? 1 : 0, followUpWorkflowRunId: null };
      },
    },
    adapters: {
      state: { getFrozenRenderingStateForWorkSet: async () => ({
        sourceStorageKey: "source/input.mp4", sourceDurationSeconds: 10,
        workspaceId: WORKSPACE_ID, workspaceOwnerUserId: "asset-owner", pricingTier: "creator",
        brandSnapshot: { status: "available", value: null }, pendingRenders: [pendingRender],
      }) },
      assets: { loadSceneSources: async (request) => {
        loaded.push(request);
        if (input.loadFailure) throw input.loadFailure;
        return input.sources ?? { visuals: [VISUAL], fonts: [FONT] };
      } },
      workerProcess: {
        inspectMedia: async ({ sourcePath, diagnose }) => {
          diagnose?.({ operation: "exit", status: "completed", elapsedMs: sourcePath.endsWith(".png") ? 77 : 5 });
          return { durationSec: 10, width: 1920, height: 1080,
            hasVideo: true, hasVisualStream: true, hasAudio: true, fps: 30 };
        },
        execute: async ({ command, args, signal, diagnose }) => {
          signal.throwIfAborted();
          expect(command).toBe("ffmpeg");
          commands.push([...args]);
          diagnose?.({ operation: "exit", status: "completed", elapsedMs: args.includes("null") ? 88 : 6 });
          return { exitCode: 0, stdout: Buffer.alloc(0) };
        },
        withScratchDirectory: async (_prefix, work) => {
          try { return await work("/tmp/narriflow-scene-assets"); } finally { cleanups += 1; }
        },
      },
      clip: {
        markClipRenderVariantRendering: async (owned, id) => {
          expect(owned).toEqual(attempt); expect(id).toBe(pendingRender.id); state = "rendering"; return true;
        },
        completeClipRenderVariant: async (owned, id, completion) => {
          expect(owned).toEqual(attempt); expect(id).toBe(pendingRender.id);
          completions.push(completion);
          state = input.completionAccepted === false ? "superseded" : "completed";
          return { persisted: input.completionAccepted !== false };
        },
        failClipRenderVariant: async (owned, id, code, disposition) => {
          expect(owned).toEqual(attempt); expect(id).toBe(pendingRender.id);
          failures.push({ code, disposition }); state = disposition === "retryable" ? "retryable" : "failed";
        },
      },
      project: { reportProgress: async () => {} },
      optionalAssets: input.runtimeValidation ? {} : { validateOptionalMedia: async (path, kind) => {
        validations.push({ path, kind }); return input.imageDecodable !== false;
      } },
      storage: {
        downloadObjectToFile: async ({ key, filePath, signal }) => {
          downloads.push({ key, path: filePath, signal });
          signal?.throwIfAborted();
          if (input.cancelAssetDownload && key === VISUAL.storageKey) {
            controller.abort(cancellation); signal?.throwIfAborted();
          }
        },
        putFileFromPath: async ({ key, signal }) => { signal?.throwIfAborted(); uploads.push(key); return { key }; },
        deleteObject: async (key) => { deleted.push(key); return { key }; },
      },
      workspace: { stat: async () => ({ size: 256 }) as never, writeFile: async () => {} },
      resource: { measure: () => ({ rssBytes: 1_024, scope: "worker_only" }) },
      diagnose: (event) => diagnostics.push(event),
    },
  });
  const context: WorkflowAttemptContext = { signal: controller.signal, reportProgress: async () => {} };
  return { execute: () => clipRenderAttempt.execute(attempt, context), loaded, downloads, validations,
    commands, uploads, deleted, failures, completions, diagnostics, attempt, cancellation, settlements: () => settlements, cleanups: () => cleanups };
}

describe("Clip Render Attempt Scene assets", () => {
  test("runtime validation probe and decode logs share the domain's owned attempt identity", async () => {
    const tracer = fixture({ runtimeValidation: true });
    expect((await tracer.execute()).status).toBe("completed");
    const probe = tracer.diagnostics.find((event) => event.message === "clip_render_command_operation" && event.context?.elapsedMs === 77);
    const decode = tracer.diagnostics.find((event) => event.message === "clip_render_command_operation" && event.context?.elapsedMs === 88);
    const settlement = tracer.diagnostics.find((event) => event.message === "clip_render_attempt_settled");
    expect(probe).toBeDefined();
    expect(decode).toBeDefined();
    expect(settlement).toBeDefined();
    for (const event of [probe, decode, settlement]) {
      expect(event!.context).toMatchObject({ workflowRunId: tracer.attempt.workflowRunId,
        workflowAttemptId: tracer.attempt.attemptId, projectId: tracer.attempt.projectId,
        stage: tracer.attempt.stage, attemptCount: tracer.attempt.attemptCount });
    }
    expect(tracer.commands[0]).toEqual(["-v", "error", "-i", tracer.downloads.find((download) => download.key === VISUAL.storageKey)!.path, "-map", "0:v:0", "-f", "null", "-"]);
    expect(tracer.completions[0]!.durationSec).toBe(12);
  });

  test("resolves current Workspace image and custom font into the encoder before guarded completion", async () => {
    const tracer = fixture();
    expect((await tracer.execute()).status).toBe("completed");
    expect(tracer.loaded).toEqual([{ workspaceId: WORKSPACE_ID, visualIds: [VISUAL_ID], fontIds: [FONT_ID] }]);
    const image = tracer.downloads.find((download) => download.key === VISUAL.storageKey)!;
    const font = tracer.downloads.find((download) => download.key === FONT.storageKey)!;
    expect(image.signal).toBeInstanceOf(AbortSignal);
    expect(font.signal).toBeInstanceOf(AbortSignal);
    expect(tracer.validations).toContainEqual({ path: image.path, kind: "image" });
    expect(tracer.commands).toHaveLength(1);
    expect(tracer.commands[0]).toContain(image.path);
    expect(tracer.commands[0]!.join(" ")).toContain(font.path);
    const durationIndex = tracer.commands[0]!.lastIndexOf("-t");
    expect(Number(tracer.commands[0]![durationIndex + 1])).toBe(12);
    expect(tracer.completions).toHaveLength(1);
    expect(tracer.completions[0]!.storageKey).toBe(tracer.uploads[0]!);
    expect(tracer.completions[0]!.durationSec).toBe(12);
    expect(tracer.failures).toEqual([]);
    expect(tracer.settlements()).toBe(1);
    expect(tracer.cleanups()).toBe(1);
  });

  for (const [name, sources, code] of [
    ["missing visual", { visuals: [], fonts: [FONT] }, "scene_asset_unavailable"],
    ["changed visual fingerprint", { visuals: [{ ...VISUAL, fingerprint: "b".repeat(64) }], fonts: [FONT] }, "scene_asset_unavailable"],
    ["changed visual kind", { visuals: [{ ...VISUAL, kind: "video" }], fonts: [FONT] }, "scene_asset_unavailable"],
    ["missing font", { visuals: [VISUAL], fonts: [] }, "scene_font_unavailable"],
    ["changed font fingerprint", { visuals: [VISUAL], fonts: [{ ...FONT, fingerprint: "b".repeat(64) }] }, "scene_font_unavailable"],
    ["changed font family", { visuals: [VISUAL], fonts: [{ ...FONT, family: "Different Family" }] }, "scene_font_unavailable"],
  ] as const) {
    test(`${name} permanently fails the variant without encoding`, async () => {
      const tracer = fixture({ sources: { visuals: [...sources.visuals], fonts: [...sources.fonts] } });
      expect((await tracer.execute()).status).toBe("failed");
      expect(tracer.failures).toEqual([{ code, disposition: "permanent" }]);
      expect(tracer.commands).toEqual([]);
      expect(tracer.uploads).toEqual([]);
      expect(tracer.completions).toEqual([]);
      expect(tracer.settlements()).toBe(1);
      expect(tracer.cleanups()).toBe(1);
    });
  }

  for (const code of ["scene_asset_workspace_unavailable", "scene_asset_database_unavailable"]) {
    test(`${code} requeues through ordinary variant settlement`, async () => {
      const tracer = fixture({ loadFailure: new WorkflowFailure(code, "retryable", "Scene persistence unavailable") });
      expect((await tracer.execute()).status).toBe("requeued");
      expect(tracer.loaded).toHaveLength(1);
      expect(tracer.failures).toEqual([{ code, disposition: "retryable" }]);
      expect(tracer.commands).toEqual([]);
      expect(tracer.uploads).toEqual([]);
      expect(tracer.settlements()).toBe(1);
      expect(tracer.cleanups()).toBe(1);
    });
  }

  test("repeated Scene references resolve and download once within the current Workspace", async () => {
    const tracer = fixture({ duplicates: true });
    expect((await tracer.execute()).status).toBe("completed");
    expect(tracer.loaded).toEqual([{ workspaceId: WORKSPACE_ID, visualIds: [VISUAL_ID], fontIds: [FONT_ID] }]);
    expect(tracer.downloads.filter((download) => download.key === VISUAL.storageKey)).toHaveLength(1);
    expect(tracer.downloads.filter((download) => download.key === FONT.storageKey)).toHaveLength(1);
    const durationIndex = tracer.commands[0]!.lastIndexOf("-t");
    expect(Number(tracer.commands[0]![durationIndex + 1])).toBe(14);
    expect(tracer.completions[0]!.durationSec).toBe(14);
  });

  test("a downloaded image must pass media validation before encoding", async () => {
    const tracer = fixture({ imageDecodable: false });
    expect((await tracer.execute()).status).toBe("failed");
    expect(tracer.validations).toHaveLength(1);
    expect(tracer.failures).toEqual([{ code: "scene_asset_invalid", disposition: "permanent" }]);
    expect(tracer.commands).toEqual([]);
    expect(tracer.uploads).toEqual([]);
  });

  test("cancellation during a Scene download retains control flow and skips settlement writes", async () => {
    const tracer = fixture({ cancelAssetDownload: true });
    await expect(tracer.execute()).rejects.toBe(tracer.cancellation);
    expect(tracer.commands).toEqual([]);
    expect(tracer.failures).toEqual([]);
    expect(tracer.completions).toEqual([]);
    expect(tracer.settlements()).toBe(0);
    expect(tracer.cleanups()).toBe(1);
  });

  test("a rejected guarded completion discards its provisional object after Scene encoding", async () => {
    const tracer = fixture({ completionAccepted: false });
    const outcome = await tracer.execute();
    expect(outcome).toMatchObject({ status: "completed", succeeded: 0, superseded: 1 });
    expect(tracer.commands).toHaveLength(1);
    expect(tracer.completions).toHaveLength(1);
    expect(tracer.deleted).toEqual(tracer.uploads);
    expect(tracer.failures).toEqual([]);
    expect(tracer.settlements()).toBe(1);
  });
});
