import { bindServiceTestEnvironment } from "./runtime-test-support";
import { describe, expect, spyOn, test } from "bun:test";
import type { Prisma, PrismaClient } from "@prisma/client";
import { captionPresetSchema, editorDocumentSchema, studioEditsSchema, type PricingTier } from "@narriflow/validators";
import { encodeClipEditorDocumentForStorage } from "./clip-editor-document-persistence";
import { buildClipExportFingerprint } from "./clip-export.service";
import { renderGroupExportIdentity } from "./render-group-contract";
import { RenderGroupLifecycle } from "./render-group-lifecycle";
import { clearProjectWatermarksWithinTransaction, planExportReissues, type WatermarkExportCandidate } from "./watermark-clearance";
import { clearWatermarksAfterBillingCommit, watermarkClearanceDue } from "./watermark-clearance-trigger";
import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";

const NOW = new Date("2026-11-27T12:00:00.000Z");
const PROJECT = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";
const CLIP = "00000000-0000-4000-8000-000000000003";
const OTHER_CLIP = "00000000-0000-4000-8000-000000000004";
const SETTLED_RUN = "00000000-0000-4000-8000-000000000005";
const LIVE_RUN = "00000000-0000-4000-8000-000000000006";
const DRAIN_PARENT = "00000000-0000-4000-8000-000000000007";

const snapshot = {
  ...encodeClipEditorDocumentForStorage(editorDocumentSchema.parse({
    version: 1, clipStartSec: 0, clipEndSec: 12, captionPreset: captionPresetSchema.parse({ textTransform: "none" }),
    transcriptSlice: [{ index: 0, speaker: 0, speakerLabel: "Speaker 1", confidence: 0.9, startSec: 1, endSec: 2, text: "Hello there",
      words: [{ word: "Hello", startSec: 1, endSec: 1.4, confidence: 0.9 }, { word: "there", startSec: 1.5, endSec: 2, confidence: 0.9 }] }],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }), brollUrl: null, deletedRanges: [],
  }), { durationSec: 600, wholeSource: false }),
  llmModel: "test",
  editorRevision: 3,
};

describe("watermark clearance trigger", () => {
  test("is due for every committed plan with clean exports, never for Free", bindServiceTestEnvironment(() => {
    for (const paid of ["creator", "pro", "business"] as const) expect(watermarkClearanceDue(paid)).toBe(true);
    expect(watermarkClearanceDue("free")).toBe(false);
  }));

  test("calls the clearance only when due and never rethrows its failure", bindServiceTestEnvironment(async () => {
    const cleared: string[] = [];
    const clear = async (workspaceId: string) => { cleared.push(workspaceId); };
    const cases: [PricingTier, boolean][] = [["creator", true], ["pro", true], ["business", true], ["free", false]];
    for (const [tier, due] of cases) {
      cleared.length = 0;
      await clearWatermarksAfterBillingCommit({ workspaceId: WORKSPACE, tier }, clear);
      expect(cleared).toEqual(due ? [WORKSPACE] : []);
    }
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const billingResult = { pricingTier: "pro" };
      const commit = async () => {
        await clearWatermarksAfterBillingCommit({ workspaceId: WORKSPACE, tier: "pro" },
          async () => { throw new Error("database unavailable"); });
        return billingResult;
      };
      expect(await commit()).toBe(billingResult);
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ level: "warn", message: "watermark_clearance_failed", workspaceId: WORKSPACE });
    } finally {
      warn.mockRestore();
    }
  }));
});

// In-memory rows for the clearance's handful of queries.
interface RenderRow {
  id: string; clipId: string; projectId: string; exportVariantId: string | null; status: string; watermark: boolean;
  workflowRunId: string | null; resolution: string; storageKey: string | null; clipSnapshot: unknown;
}
interface ExportRow {
  id: string; projectId: string; clipId: string; editorRevision: number; resolution: string; dubId: string | null;
  watermark: boolean; fingerprint: string; retryCount: number; workflowRunId: string | null; createdAt: Date;
}
interface VariantRow { id: string; exportId: string; aspectRatio: "ratio_9_16" | "ratio_1_1"; status: string; watermark: boolean; storageKey: string | null }
interface World {
  admissionOpen: boolean;
  project: { id: string; workspaceId: string; accessible: boolean; workspaceActive: boolean; sourceRetained: boolean; tier: PricingTier };
  runs: Record<string, string>;
  renders: RenderRow[];
  exports: ExportRow[];
  variants: VariantRow[];
}

type Where = Record<string, unknown>;
const ids = (where: Where) => new Set(((where.id as { in?: string[] } | undefined)?.in) ?? []);
function apply<T extends object>(row: T, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    const increment = (value as { increment?: number } | null)?.increment;
    (row as Record<string, unknown>)[key] = typeof increment === "number" ? (row as Record<string, number>)[key]! + increment : value;
  }
}

function fakeTransaction(world: World) {
  const terminal = (runId: string | null) => runId === null || ["completed", "partial", "failed", "cancelled"].includes(world.runs[runId] ?? "");
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => strings.join("?").includes("ExecutionEpoch")
      ? [{ epoch: 1, admissionOpen: world.admissionOpen }] : [{ now: NOW }],
    project: {
      findFirst: async ({ where }: { where: Where }) => {
        const { project } = world;
        expect(where).toMatchObject({ purgeStartedAt: null, workspace: { status: "active" }, ingestStatus: "ready", sourceStorageKey: { not: null } });
        if (where.id !== project.id || (where.workspaceId && where.workspaceId !== project.workspaceId) || !project.accessible || !project.workspaceActive || !project.sourceRetained) return null;
        return { sourceDurationSeconds: 600, sourceProbe: null, workspace: { pricingTier: project.tier } };
      },
    },
    clipRender: {
      findMany: async ({ where }: { where: Where }) => world.renders
        .filter((row) => row.projectId === (where.clip as Where).projectId && row.exportVariantId === null && row.status === "completed" && row.watermark && terminal(row.workflowRunId))
        .map((row) => ({ id: row.id })),
      updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const matched = world.renders.filter((row) => ids(where).has(row.id) && (where.status === undefined || row.status === where.status) &&
          (where.watermark === undefined || row.watermark === where.watermark));
        for (const row of matched) apply(row, data);
        return { count: matched.length };
      },
    },
    clipExport: {
      findMany: async ({ where }: { where: Where }) => {
        if (where.watermark === true) {
          return world.exports.filter((row) => row.projectId === where.projectId && row.watermark).map((row) => ({
            ...row,
            variants: world.variants.filter((variant) => variant.exportId === row.id).map((variant) => {
              const render = world.renders.find((candidate) => candidate.exportVariantId === variant.id);
              return { id: variant.id, aspectRatio: variant.aspectRatio, status: variant.status,
                render: render ? { id: render.id, status: render.status, clipSnapshot: render.clipSnapshot,
                  workflowRun: render.workflowRunId ? { status: world.runs[render.workflowRunId]! } : null } : null };
            }),
          }));
        }
        const clipIds = new Set((where.clipId as { in: string[] }).in);
        return world.exports.filter((row) => clipIds.has(row.clipId)).map((row) => ({ clipId: row.clipId, fingerprint: row.fingerprint }));
      },
      updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const matched = world.exports.filter((row) => row.id === where.id && row.watermark === where.watermark);
        for (const row of matched) apply(row, data);
        return { count: matched.length };
      },
    },
    clipExportVariant: {
      updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const matched = world.variants.filter((row) => ids(where).has(row.id));
        for (const row of matched) apply(row, data);
        return { count: matched.length };
      },
    },
  };
  return tx as unknown as Prisma.TransactionClient;
}

const markedFingerprint = buildClipExportFingerprint({ editorRevision: 3, aspectRatios: ["9:16", "1:1"], resolution: "720p", watermark: true });
const cleanFingerprint = buildClipExportFingerprint({ editorRevision: 3, aspectRatios: ["9:16", "1:1"], resolution: "720p", watermark: false });

function world(): World {
  return {
    admissionOpen: true,
    project: { id: PROJECT, workspaceId: WORKSPACE, accessible: true, workspaceActive: true, sourceRetained: true, tier: "creator" },
    runs: { [SETTLED_RUN]: "completed", [LIVE_RUN]: "waiting" },
    renders: [
      { id: "r-marked", clipId: CLIP, projectId: PROJECT, exportVariantId: null, status: "completed", watermark: true, workflowRunId: SETTLED_RUN, resolution: "720p", storageKey: "renders/marked.mp4", clipSnapshot: null },
      { id: "r-clean", clipId: CLIP, projectId: PROJECT, exportVariantId: null, status: "completed", watermark: false, workflowRunId: SETTLED_RUN, resolution: "1080p", storageKey: "renders/clean.mp4", clipSnapshot: null },
      { id: "r-failed", clipId: CLIP, projectId: PROJECT, exportVariantId: null, status: "failed", watermark: false, workflowRunId: SETTLED_RUN, resolution: "720p", storageKey: null, clipSnapshot: null },
      { id: "r-live", clipId: OTHER_CLIP, projectId: PROJECT, exportVariantId: null, status: "completed", watermark: true, workflowRunId: LIVE_RUN, resolution: "720p", storageKey: "renders/live.mp4", clipSnapshot: null },
      { id: "r-other-project", clipId: "c-elsewhere", projectId: "elsewhere", exportVariantId: null, status: "completed", watermark: true, workflowRunId: null, resolution: "720p", storageKey: "renders/elsewhere.mp4", clipSnapshot: null },
      { id: "r-e1-a", clipId: CLIP, projectId: PROJECT, exportVariantId: "v-e1-a", status: "completed", watermark: true, workflowRunId: SETTLED_RUN, resolution: "720p", storageKey: "exports/e1-a.mp4", clipSnapshot: snapshot },
      { id: "r-e1-b", clipId: CLIP, projectId: PROJECT, exportVariantId: "v-e1-b", status: "failed", watermark: false, workflowRunId: null, resolution: "720p", storageKey: null, clipSnapshot: snapshot },
    ],
    exports: [
      { id: "e1", projectId: PROJECT, clipId: CLIP, editorRevision: 3, resolution: "720p", dubId: null, watermark: true, fingerprint: markedFingerprint, retryCount: 0, workflowRunId: SETTLED_RUN, createdAt: NOW },
    ],
    variants: [
      { id: "v-e1-a", exportId: "e1", aspectRatio: "ratio_9_16", status: "completed", watermark: true, storageKey: "exports/e1-a.mp4" },
      { id: "v-e1-b", exportId: "e1", aspectRatio: "ratio_1_1", status: "failed", watermark: true, storageKey: null },
    ],
  };
}

async function clear(state: World, lineageRunId: string | null = null) {
  const synced: string[][] = [];
  const result = await clearProjectWatermarksWithinTransaction(fakeTransaction(state), { projectId: PROJECT, workspaceId: WORKSPACE, lineageRunId },
    { syncAggregates: async (_tx, variantIds) => { synced.push(variantIds); } });
  return { result, synced };
}

describe("watermark clearance reset", () => {
  test("resets only marked finished default renders outside live runs, at the new plan's resolution", bindServiceTestEnvironment(async () => {
    const state = world();
    const { result } = await clear(state);
    expect(result).toMatchObject({ kind: "cleared", exportIds: ["e1"] });
    const byId = new Map(state.renders.map((row) => [row.id, row]));
    expect(byId.get("r-marked")).toMatchObject({ status: "pending", watermark: false, storageKey: null, workflowRunId: null, resolution: "1080p" });
    expect(byId.get("r-clean")).toMatchObject({ status: "completed", storageKey: "renders/clean.mp4" });
    expect(byId.get("r-failed")).toMatchObject({ status: "failed" });
    // Still in a live run: its settlement clears it later.
    expect(byId.get("r-live")).toMatchObject({ status: "completed", watermark: true, storageKey: "renders/live.mp4" });
    expect(byId.get("r-other-project")).toMatchObject({ status: "completed", watermark: true });
  }));

  test("reissues a marked export in place: flags, fingerprint and retry count change together", bindServiceTestEnvironment(async () => {
    const state = world();
    const { result, synced } = await clear(state, DRAIN_PARENT);
    expect(result.kind === "cleared" && result.renderIds.sort()).toEqual(["r-e1-a", "r-e1-b", "r-marked"]);
    expect(state.exports[0]).toMatchObject({ id: "e1", watermark: false, fingerprint: cleanFingerprint, retryCount: 1, workflowRunId: DRAIN_PARENT,
      resolution: "720p", editorRevision: 3 });
    expect(state.variants.map((variant) => [variant.status, variant.watermark, variant.storageKey])).toEqual([["pending", false, null], ["pending", false, null]]);
    const renders = state.renders.filter((row) => row.exportVariantId);
    expect(renders.map((row) => [row.status, row.watermark, row.storageKey, row.workflowRunId, row.resolution])).toEqual([
      ["pending", false, null, null, "720p"], ["pending", false, null, null, "720p"],
    ]);
    expect(renders.every((row) => row.clipSnapshot === snapshot)).toBe(true);
    expect(synced).toEqual([["v-e1-a", "v-e1-b"]]);
  }));

  test("a second run changes nothing", bindServiceTestEnvironment(async () => {
    const state = world();
    await clear(state);
    const before = JSON.stringify(state);
    const { result, synced } = await clear(state);
    expect(result).toEqual({ kind: "cleared", renderIds: [], exportIds: [], skippedExports: [] });
    expect(synced).toEqual([]);
    expect(JSON.stringify(state)).toBe(before);
  }));

  test("does nothing when admission is closed, the plan lost the entitlement, or the Project is not accessible", bindServiceTestEnvironment(async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const cases: [(state: World) => void, string][] = [
        [(state) => { state.admissionOpen = false; }, "admission_closed"],
        [(state) => { state.project.tier = "free"; }, "not_entitled"],
        [(state) => { state.project.accessible = false; }, "project_unavailable"],
        [(state) => { state.project.workspaceActive = false; }, "project_unavailable"],
        // A retired source cannot render again: the marked file stays.
        [(state) => { state.project.sourceRetained = false; }, "project_unavailable"],
      ];
      for (const [change, reason] of cases) {
        const state = world();
        change(state);
        const before = structuredClone(state);
        expect((await clear(state)).result).toEqual({ kind: "skipped", reason } as never);
        expect(state).toEqual(before);
      }
    } finally {
      warn.mockRestore();
    }
  }));

  test("skips an export with a clean twin, a pending variant, or an undecodable snapshot, and keeps its file", bindServiceTestEnvironment(async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const twin = world();
      twin.exports.push({ ...twin.exports[0]!, id: "e-clean", watermark: false, fingerprint: cleanFingerprint });
      const pending = world();
      pending.variants[1]!.status = "pending";
      pending.renders.find((row) => row.id === "r-e1-b")!.status = "pending";
      const undecodable = world();
      for (const row of undecodable.renders) if (row.exportVariantId) row.clipSnapshot = { version: 1 };
      for (const [state, reason] of [[twin, "clean_twin"], [pending, "in_flight"], [undecodable, "snapshot_invalid"]] as const) {
        const { result } = await clear(state);
        expect(result).toMatchObject({ kind: "cleared", exportIds: [], skippedExports: [{ exportId: "e1", reason }] });
        expect(state.exports.find((row) => row.id === "e1")).toMatchObject({ watermark: true, fingerprint: markedFingerprint, retryCount: 0 });
        expect(state.variants[0]).toMatchObject({ status: "completed", watermark: true, storageKey: "exports/e1-a.mp4" });
        expect(state.renders.find((row) => row.id === "r-e1-a")).toMatchObject({ status: "completed", storageKey: "exports/e1-a.mp4" });
      }
    } finally {
      warn.mockRestore();
    }
  }));
});

describe("watermark export reissue plan", () => {
  const candidate = (id: string, overrides: Partial<WatermarkExportCandidate> = {}): WatermarkExportCandidate => ({
    id, clipId: CLIP, editorRevision: 3, resolution: "720p", dubId: null,
    variants: [{ id: `${id}-v`, aspectRatio: "ratio_9_16", status: "completed",
      render: { id: `${id}-r`, status: "completed", clipSnapshot: snapshot as Prisma.JsonValue, workflowRun: { status: "completed" } } }],
    ...overrides,
  });

  test("two marked exports that become the same clean export: only the first is reissued", bindServiceTestEnvironment(() => {
    const decisions = planExportReissues({ tier: "pro", sourceDurationSec: 600, existingFingerprints: new Set(), candidates: [candidate("a"), candidate("b")] });
    expect(decisions.map((decision) => decision.kind === "skip" ? decision.reason : decision.kind)).toEqual(["reissue", "clean_twin"]);
  }));

  test("a variant in a live run, or a dub export's own fingerprint", bindServiceTestEnvironment(() => {
    const live = candidate("live", { variants: [{ ...candidate("x").variants[0]!, render: { ...candidate("x").variants[0]!.render!, workflowRun: { status: "running" } } }] });
    const dub = candidate("dub", { dubId: "00000000-0000-4000-8000-0000000000dd" });
    const [liveDecision, dubDecision] = planExportReissues({ tier: "pro", sourceDurationSec: 600, existingFingerprints: new Set(), candidates: [live, dub] });
    expect(liveDecision).toEqual({ kind: "skip", exportId: "live", reason: "in_flight" });
    expect(dubDecision).toMatchObject({ kind: "reissue", fingerprint: buildClipExportFingerprint({ editorRevision: 3, aspectRatios: ["9:16"], resolution: "720p", watermark: false, dubId: "00000000-0000-4000-8000-0000000000dd" }) });
  }));

  test("an export that render preparation would refuse keeps its file", bindServiceTestEnvironment(() => {
    const good = candidate("x").variants[0]!;
    const withSnapshots = (id: string, ...snapshots: unknown[]) => candidate(id, {
      variants: snapshots.map((clipSnapshot, index) => ({ ...good, id: `${id}-v${index}`, aspectRatio: index ? "ratio_1_1" : "ratio_9_16",
        render: { ...good.render!, id: `${id}-r${index}`, clipSnapshot: clipSnapshot as Prisma.JsonValue } })),
    });
    const decisions = planExportReissues({ tier: "pro", sourceDurationSec: 600, existingFingerprints: new Set(), candidates: [
      withSnapshots("second-undecodable", snapshot, { ...snapshot, startSec: "broken" }),
      withSnapshots("other-revision", snapshot, { ...snapshot, editorRevision: 4 }),
      withSnapshots("no-revision", (({ editorRevision: _, ...rest }) => rest)(snapshot)),
      withSnapshots("other-model", snapshot, { ...snapshot, llmModel: "other" }),
    ] });
    // The control: the same two-variant export with good snapshots is reissued.
    const [control] = planExportReissues({ tier: "pro", sourceDurationSec: 600, existingFingerprints: new Set(), candidates: [withSnapshots("both-good", snapshot, snapshot)] });
    decisions.push(control!);
    expect(decisions.map((decision) => decision.kind === "skip" ? decision.reason : decision.kind))
      .toEqual(["snapshot_invalid", "snapshot_invalid", "snapshot_invalid", "snapshot_invalid", "reissue"]);
  }));
});

// A transaction stand-in that answers every query with an empty default
// unless a test supplies the row. `STOP` ends a flow right after the write
// under test, before unrelated dispatch bookkeeping.
const STOP = new Error("stop_after_write");
function proxyTransaction(rows: Record<string, Record<string, (args: never) => unknown>>) {
  const writes: { model: string; method: string; args: { where?: unknown; data?: Record<string, unknown> } }[] = [];
  const defaults: Record<string, (args: never) => unknown> = {
    findUnique: () => null, findFirst: () => null, findMany: () => [], count: () => 0,
    create: (args: { data: unknown }) => args.data, createMany: () => ({ count: 0 }), update: (args: { data: unknown }) => args.data, updateMany: () => ({ count: 1 }),
  };
  const tx = new Proxy({}, {
    get(_target, model: string) {
      if (model === "then") return undefined;
      if (model === "$queryRaw") return async () => [{ now: NOW, epoch: 1, admissionOpen: true, workflowEventSeq: 1 }];
      return new Proxy({}, {
        get(_inner, method: string) {
          return async (args: never) => {
            if (["create", "createMany", "update", "updateMany", "upsert"].includes(method)) writes.push({ model, method, args });
            const handler = rows[model]?.[method] ?? defaults[method];
            if (!handler) throw new Error(`unexpected ${model}.${method}`);
            return handler(args);
          };
        },
      });
    },
  });
  return { tx: tx as Prisma.TransactionClient, writes };
}

describe("ClipRender.watermark is written on completion and cleared on every reset", () => {
  const RUN = "00000000-0000-4000-8000-0000000000a1", GEN = "00000000-0000-4000-8000-0000000000a2", GROUP = "00000000-0000-4000-8000-0000000000a3";
  const TOKEN = "00000000-0000-4000-8000-0000000000a4", RENDER = "00000000-0000-4000-8000-0000000000a5";
  const attempt = { workflowRunId: RUN, workSetGeneration: GEN, groupId: GROUP, token: TOKEN, owner: "owner-1" };
  const groupRows = (watermark: boolean, status: "rendering" | "failed") => {
    const exportIdentity = renderGroupExportIdentity({ clipId: CLIP, exportId: null, editorRevision: 3, resolution: "1080p", watermark });
    return {
      workflowRun: { findUnique: () => ({ id: RUN, projectId: PROJECT, stage: "clip_rendering", status: "waiting", progress: 0, renderWorkSetGeneration: GEN }) },
      renderGroup: {
        findUnique: () => ({ id: GROUP, workflowRunId: RUN, workSetGeneration: GEN, clipId: CLIP, exportIdentity, status: "running", attemptToken: TOKEN, leaseOwner: "owner-1",
          leaseExpiresAt: new Date(NOW.getTime() + 60_000), operationDeadlineAt: null, chargedAttemptCount: 1 }),
        findMany: () => [{ id: GROUP, clipId: CLIP, exportIdentity }],
      },
      renderGroupMember: { findMany: () => [{ groupId: GROUP, clipRenderId: RENDER, invalidatedAt: null }] },
      // The completion's write is recorded; the outcome ledger write ends the flow.
      renderGroupVariantOutcome: { create: () => { throw STOP; } },
      clipRender: {
        findMany: () => [{ id: RENDER, clipId: CLIP, workflowRunId: RUN, resolution: "1080p", editorRevision: null, clip: { editorRevision: 3 }, exportVariant: null,
          exportVariantId: null, status, failureDisposition: status === "failed" ? "retryable" : null, errorCode: status === "failed" ? "render_failed" : null }],
      },
      renderGroupExecution: {
        findUniqueOrThrow: () => ({ token: TOKEN, startedAt: NOW, finishedAt: null, charged: true }),
        update: () => { throw STOP; },
      },
    };
  };

  for (const watermark of [true, false]) {
    test(`completion records the sealed group configuration's watermark (${watermark})`, bindServiceTestEnvironment(async () => {
      const { tx, writes } = proxyTransaction(groupRows(watermark, "rendering"));
      await expect(new RenderGroupLifecycle({ prisma: {} as PrismaClient })
        .completeClipRenderVariantWithinTransaction(tx, attempt, RENDER, { storageKey: "renders/out.mp4", sizeBytes: 10, durationSec: 4 })).rejects.toBe(STOP);
      const update = writes.find((write) => write.model === "clipRender" && write.method === "update");
      expect(update?.args.data).toMatchObject({ status: "completed", storageKey: "renders/out.mp4", watermark });
    }));
  }

  test("a group retry resets the render and clears watermark", bindServiceTestEnvironment(async () => {
    const { tx, writes } = proxyTransaction(groupRows(true, "failed"));
    const lifecycle = new RenderGroupLifecycle({ prisma: {} as PrismaClient }) as unknown as {
      finishWithinTransaction(tx: Prisma.TransactionClient, input: unknown, expired: boolean): Promise<unknown>;
    };
    await expect(lifecycle.finishWithinTransaction(tx, { ...attempt, result: "failed", errorCode: "render_failed", failureDisposition: "retryable" }, false)).rejects.toBe(STOP);
    const reset = writes.find((write) => write.model === "clipRender" && write.method === "update" && write.args.data?.status === "pending");
    expect(reset?.args.data).toMatchObject({ storageKey: null, watermark: false });
  }));

  test("a manual Render resets a finished default render and clears watermark", bindServiceTestEnvironment(async () => {
    const { tx, writes } = proxyTransaction({
      clip: { count: () => 1 },
      clipRender: { findMany: () => [{ id: RENDER, clipId: CLIP, aspectRatio: "ratio_9_16", status: "completed" }] },
      workflowRun: { findUnique: () => null, findFirst: () => { throw STOP; } },
    });
    await expect(new WorkflowRunLifecycle({ prisma: {} as PrismaClient }).admitClipRendering({ projectId: PROJECT, idempotencyKey: "render:1",
      variants: [{ clipId: CLIP, aspectRatio: "ratio_9_16", resolution: "1080p" }] }, tx)).rejects.toBe(STOP);
    const reset = writes.find((write) => write.model === "clipRender" && write.method === "updateMany");
    expect(reset?.args.data).toMatchObject({ status: "pending", storageKey: null, resolution: "1080p", watermark: false });
  }));

  test("a failed export retry clears the render's watermark and keeps the variant's frozen flag", bindServiceTestEnvironment(async () => {
    const { tx, writes } = proxyTransaction({
      clipExportVariant: { findMany: () => [{ id: "v1" }] },
      clipExport: { update: () => { throw STOP; } },
    });
    const prisma = { $transaction: async (operation: (tx: Prisma.TransactionClient) => Promise<unknown>) => operation(tx) } as unknown as PrismaClient;
    await expect(new WorkflowRunLifecycle({ prisma }).retryFailedClipExport({ projectId: PROJECT, exportId: "e1", expectedRetryCount: 0, variantIds: ["v1"] })).rejects.toBe(STOP);
    const render = writes.find((write) => write.model === "clipRender" && write.method === "updateMany");
    const variant = writes.find((write) => write.model === "clipExportVariant" && write.method === "updateMany");
    expect(render?.args.data).toMatchObject({ status: "pending", storageKey: null, watermark: false });
    expect(variant?.args.data).toMatchObject({ status: "pending", storageKey: null });
    expect(variant?.args.data).not.toHaveProperty("watermark");
  }));
});

describe("watermark clearance after a billing commit", () => {
  test("its render obligations never join the billing request's delivery, and a scheduler failure is swallowed", bindServiceTestEnvironment(async () => {
    const { clearWorkspaceWatermarks } = await import("./watermark-clearance-runtime");
    const { collectExecutionDispatch, withExecutionDispatches } = await import("./execution-dispatch-runtime");
    const prisma = {
      project: { findMany: async ({ where }: { where: { AND: unknown[] } }) => {
        // Expiry and purge come from the access rule, intact beside the marked-output filter.
        expect(where.AND).toContainEqual(expect.objectContaining({ purgeStartedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] }));
        return [{ id: PROJECT }];
      } },
      executionDispatch: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id })) },
    } as unknown as PrismaClient;
    const clear = spyOn(WorkflowRunLifecycle.prototype, "clearProjectWatermarks").mockImplementation(async () => {
      collectExecutionDispatch({} as Prisma.TransactionClient, "watermark-dispatch");
      return { kind: "cleared", renderIds: ["r1"], exportIds: [], skippedExports: [] };
    });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const billingDelivery: string[][] = [];
    try {
      // The billing request's own scope: whatever it delivers, it must not see the clearance's work.
      const result = await withExecutionDispatches(async () => {
        await clearWorkspaceWatermarks(WORKSPACE, prisma);
        return "billing-projection";
      }, { database: prisma, deliver: async (ids) => { billingDelivery.push([...ids]); } });
      expect(result).toBe("billing-projection");
      expect(billingDelivery).toEqual([]);
      // No scheduler is bound in this test, so delivery fails; it is logged and deferred to hourly recovery.
      const logged = warn.mock.calls.map((call) => JSON.parse(String(call[0])));
      expect(logged).toContainEqual(expect.objectContaining({ message: "watermark_clearance_dispatch_deferred", workspaceId: WORKSPACE, dispatchCount: 1 }));
    } finally {
      clear.mockRestore();
      warn.mockRestore();
    }
  }));
});
