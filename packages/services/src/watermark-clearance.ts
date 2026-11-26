import { Prisma, type ClipAspectRatio as DbClipAspectRatio, type ClipRenderStatus } from "@prisma/client";
import {
  clipAspectRatioFromDb,
  clipRenderResolutionSchema,
  clipSourceEdgeSec,
  resolvePricingTier,
  type EditorDocument,
  type PricingTier,
} from "@narriflow/validators";
import { hasFeature } from "./plan-features";
import { accessibleProjectWhere } from "./project-access";
import { readExecutionAdmission } from "./execution-admission";
import { syncClipExportAggregates } from "./clip-export-aggregates";
import { decodeFrozenClipEditorDocument } from "./clip-editor-document-codec";
import { assertClipExportDocumentAllowed, buildClipExportFingerprint, resolveClipExportOutput } from "./clip-export.service";

// When a Workspace gains `export.noWatermark`, the videos it made while on Free
// render again without the mark. The trigger is the committed tier change
// (`watermark-clearance-trigger.ts`); the work set is "rows that are marked
// now", so a second run finds nothing.

type Tx = Prisma.TransactionClient;

const TERMINAL_RUN_STATUSES = ["completed", "partial", "failed", "cancelled"];
const TERMINAL_RENDER_STATUSES: readonly ClipRenderStatus[] = ["completed", "failed"];

export interface WatermarkExportCandidate {
  id: string;
  clipId: string;
  editorRevision: number;
  resolution: string;
  dubId: string | null;
  variants: {
    id: string;
    aspectRatio: DbClipAspectRatio;
    status: ClipRenderStatus;
    render: {
      id: string;
      status: ClipRenderStatus;
      clipSnapshot: Prisma.JsonValue | null;
      workflowRun: { status: string } | null;
    } | null;
  }[];
}

export type WatermarkExportSkipReason =
  | "in_flight"
  | "snapshot_invalid"
  | "document_not_allowed"
  | "scene_assets"
  | "output_invalid"
  | "clean_twin";

export type WatermarkExportDecision =
  | { kind: "reissue"; exportId: string; fingerprint: string; variantIds: string[]; renderIds: string[] }
  | { kind: "skip"; exportId: string; reason: WatermarkExportSkipReason };

/** A Scene image, video or Brand font is only proven available by reading
 * object storage, which this transaction never does. Such an export keeps its
 * file. A Free-plan document has no Scenes, so this skips nothing in practice. */
function usesSceneAssets(document: EditorDocument): boolean {
  return document.sceneBlocks.some((scene) =>
    scene.content.kind === "image" || scene.content.kind === "video" || (scene.content.kind === "text" && Boolean(scene.content.fontAsset)));
}

function planExportReissue(
  candidate: WatermarkExportCandidate,
  input: { tier: PricingTier; sourceDurationSec: number | null },
): Exclude<WatermarkExportDecision, { reason: "clean_twin" }> {
  const skip = (reason: WatermarkExportSkipReason) => ({ kind: "skip" as const, exportId: candidate.id, reason });
  const { variants } = candidate;
  // The same condition a manual retry uses: every variant settled and no live run.
  if (!variants.length || variants.some((variant) => !TERMINAL_RENDER_STATUSES.includes(variant.status) ||
    !variant.render || !TERMINAL_RENDER_STATUSES.includes(variant.render.status) ||
    (variant.render.workflowRun !== null && !TERMINAL_RUN_STATUSES.includes(variant.render.workflowRun.status)))) return skip("in_flight");
  // The checks render preparation runs on a frozen export (clip-preparation.ts),
  // on every variant: an export that preparation would refuse keeps its file.
  const snapshots = variants.map((variant) => variant.render?.clipSnapshot ?? null);
  if (snapshots.some((snapshot) => snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot))) return skip("snapshot_invalid");
  const records = snapshots as Record<string, unknown>[];
  const { wholeSource, llmModel } = records[0]!;
  if (typeof wholeSource !== "boolean" || typeof llmModel !== "string" || !llmModel ||
    records.some((record) => record.editorRevision !== candidate.editorRevision || record.wholeSource !== wholeSource || record.llmModel !== llmModel)) {
    return skip("snapshot_invalid");
  }
  let document: EditorDocument;
  try {
    const decoded = records.map((record) => decodeFrozenClipEditorDocument(record, input.sourceDurationSec));
    document = decoded[0]!;
    const first = JSON.stringify(document);
    if (decoded.some((other) => JSON.stringify(other) !== first)) return skip("snapshot_invalid");
  } catch {
    return skip("snapshot_invalid");
  }
  try {
    assertClipExportDocumentAllowed(input.tier, document);
  } catch {
    return skip("document_not_allowed");
  }
  if (usesSceneAssets(document)) return skip("scene_assets");
  const resolution = clipRenderResolutionSchema.safeParse(candidate.resolution);
  if (!resolution.success) return skip("output_invalid");
  const fingerprint = buildClipExportFingerprint({
    editorRevision: candidate.editorRevision,
    aspectRatios: variants.map((variant) => clipAspectRatioFromDb[variant.aspectRatio]),
    resolution: resolution.data,
    watermark: false,
    ...(candidate.dubId ? { dubId: candidate.dubId } : {}),
  });
  return {
    kind: "reissue", exportId: candidate.id, fingerprint,
    variantIds: variants.map((variant) => variant.id), renderIds: variants.map((variant) => variant.render!.id),
  };
}

/** Pure: which marked exports are reissued in place, and why the rest are not.
 * `existingFingerprints` holds `clipId:fingerprint` for every export of the
 * candidates' clips; the `(clipId, fingerprint)` key is unique. */
export function planExportReissues(input: {
  tier: PricingTier;
  sourceDurationSec: number | null;
  candidates: readonly WatermarkExportCandidate[];
  existingFingerprints: ReadonlySet<string>;
}): WatermarkExportDecision[] {
  const taken = new Set(input.existingFingerprints);
  return input.candidates.map((candidate) => {
    let decision: Exclude<WatermarkExportDecision, { reason: "clean_twin" }>;
    try {
      decision = planExportReissue(candidate, input);
    } catch {
      decision = { kind: "skip", exportId: candidate.id, reason: "output_invalid" };
    }
    if (decision.kind === "skip") return decision;
    const key = `${candidate.clipId}:${decision.fingerprint}`;
    // A clean twin already exists (or another candidate takes the key first).
    if (taken.has(key)) return { kind: "skip", exportId: candidate.id, reason: "clean_twin" };
    taken.add(key);
    return decision;
  });
}

export type WatermarkClearanceResult =
  | { kind: "skipped"; reason: "admission_closed" | "project_unavailable" | "not_entitled" }
  | { kind: "cleared"; renderIds: string[]; exportIds: string[]; skippedExports: { exportId: string; reason: WatermarkExportSkipReason }[] };

/**
 * Resets a Project's marked finished outputs to "pending, no run" so the
 * ordinary render admission renders them again without the mark. The caller
 * holds the Project's render admission locks (`lockRenderAdmissionWithinTransaction`
 * or render settlement's `lockRenderRun`), hands the reset rows to a run, and
 * flushes Workspace Events. Every guard is re-read here; a failed guard does
 * nothing. Nothing here throws on a domain condition: queries are by row id
 * under the Project lock, and the unique export fingerprint is checked first.
 *
 * `lineageRunId` becomes the reissued exports' run, as a manual retry records
 * one; render settlement passes the settling run, whose drain renders them.
 */
export async function clearProjectWatermarksWithinTransaction(
  tx: Tx,
  input: { projectId: string; workspaceId?: string; lineageRunId: string | null },
  dependencies: { syncAggregates?: (tx: Tx, exportVariantIds: string[]) => Promise<void> } = {},
): Promise<WatermarkClearanceResult> {
  const admission = await readExecutionAdmission(tx);
  if (!admission.admissionOpen) {
    console.warn(JSON.stringify({ level: "warn", message: "watermark_clearance_admission_closed", projectId: input.projectId }));
    return { kind: "skipped", reason: "admission_closed" };
  }
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
  if (!clock) return { kind: "skipped", reason: "project_unavailable" };
  const project = await tx.project.findFirst({
    // A Project whose source was retired cannot render again, so its marked files stay.
    where: { id: input.projectId, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), ...accessibleProjectWhere(clock.now), workspace: { status: "active" },
      ingestStatus: "ready", sourceStorageKey: { not: null } },
    select: { sourceDurationSeconds: true, sourceProbe: true, workspace: { select: { pricingTier: true } } },
  });
  if (!project) return { kind: "skipped", reason: "project_unavailable" };
  const tier = resolvePricingTier(project.workspace.pricingTier);
  if (!hasFeature(tier, "export.noWatermark")) return { kind: "skipped", reason: "not_entitled" };

  // Default renders (the Clips tab): marked, finished and out of any live run.
  const defaults = await tx.clipRender.findMany({
    where: {
      clip: { projectId: input.projectId }, exportVariantId: null, status: "completed", watermark: true,
      OR: [{ workflowRunId: null }, { workflowRun: { status: { in: TERMINAL_RUN_STATUSES } } }],
    },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  const defaultIds = defaults.map((row) => row.id);
  if (defaultIds.length) {
    await tx.clipRender.updateMany({
      where: { id: { in: defaultIds }, status: "completed", watermark: true },
      data: {
        status: "pending", storageKey: null, sizeBytes: null, durationSec: null, errorCode: null, failureDisposition: null,
        captionDiagnostics: Prisma.DbNull, workflowAttemptId: null, workflowRunId: null, startedAt: null, completedAt: null,
        resolution: resolveClipExportOutput(tier, "1080p").granted.resolution, watermark: false,
      },
    });
  }

  // Versioned exports, reissued in place: same id, variants, snapshot and resolution.
  const candidates: WatermarkExportCandidate[] = await tx.clipExport.findMany({
    where: { projectId: input.projectId, watermark: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true, clipId: true, editorRevision: true, resolution: true, dubId: true,
      variants: {
        orderBy: { id: "asc" },
        select: {
          id: true, aspectRatio: true, status: true,
          render: { select: { id: true, status: true, clipSnapshot: true, workflowRun: { select: { status: true } } } },
        },
      },
    },
  });
  const clipIds = [...new Set(candidates.map((candidate) => candidate.clipId))];
  const existing = clipIds.length ? await tx.clipExport.findMany({ where: { clipId: { in: clipIds } }, select: { clipId: true, fingerprint: true } }) : [];
  const decisions = planExportReissues({
    tier, sourceDurationSec: clipSourceEdgeSec(project), candidates,
    existingFingerprints: new Set(existing.map((row) => `${row.clipId}:${row.fingerprint}`)),
  });
  const reissues = decisions.flatMap((decision) => decision.kind === "reissue" ? [decision] : []).sort((a, b) => a.exportId < b.exportId ? -1 : 1);
  const skippedExports = decisions.flatMap((decision) => decision.kind === "skip" ? [{ exportId: decision.exportId, reason: decision.reason }] : []);
  if (skippedExports.length) console.warn(JSON.stringify({ level: "info", message: "watermark_clearance_exports_skipped", projectId: input.projectId, skippedExports }));
  if (reissues.length) {
    // Child rows before the export aggregate, as every render writer orders them.
    await tx.clipRender.updateMany({
      where: { id: { in: reissues.flatMap((reissue) => reissue.renderIds) } },
      data: {
        status: "pending", errorCode: null, startedAt: null, completedAt: null, storageKey: null, sizeBytes: null, durationSec: null,
        workflowRunId: null, workflowAttemptId: null, failureDisposition: null, captionDiagnostics: Prisma.DbNull, watermark: false,
      },
    });
    const variantIds = reissues.flatMap((reissue) => reissue.variantIds);
    await tx.clipExportVariant.updateMany({
      where: { id: { in: variantIds } },
      data: { status: "pending", errorCode: null, startedAt: null, completedAt: null, storageKey: null, sizeBytes: null, durationSec: null, watermark: false },
    });
    for (const reissue of reissues) {
      // retryCount names the next terminal outcome and lifts the original
      // 45-minute handoff deadline, exactly as a manual retry does.
      await tx.clipExport.updateMany({
        where: { id: reissue.exportId, watermark: true },
        data: { watermark: false, fingerprint: reissue.fingerprint, retryCount: { increment: 1 },
          ...(input.lineageRunId ? { workflowRunId: input.lineageRunId } : {}) },
      });
    }
    await (dependencies.syncAggregates ?? syncClipExportAggregates)(tx, variantIds);
  }
  const exportIds = reissues.map((reissue) => reissue.exportId);
  return { kind: "cleared", renderIds: [...defaultIds, ...reissues.flatMap((reissue) => reissue.renderIds)], exportIds, skippedExports };
}
