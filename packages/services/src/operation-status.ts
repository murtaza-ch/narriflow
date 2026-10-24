import type { Prisma, PrismaClient } from "@prisma/client";
import {
  captionedVideoFramingNotices,
  captionedVideoSettingsSchema,
  sourceProbeSchema,
  workflowStageUpdatedEventSchema,
  type FramingNotice,
  type WorkflowStageUpdatedEvent,
} from "@narriflow/validators";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { accessibleProjectWhere } from "./project-access";

/** Operation Status: the lineage-derived state of one accepted mutation. */
export type OperationKind = "intake" | "generation" | "export";
export type OperationState = "working" | "completed" | "partial" | "failed" | "cancelled";
export type OperationItemState = "working" | "completed" | "failed" | "cancelled";

export interface OperationItem {
  kind: "clip" | "variant";
  id: string;
  state: OperationItemState;
  failureCode: string | null;
}

export interface OperationStatus {
  kind: OperationKind;
  id: string;
  state: OperationState;
  /** Coarse phase of the work, such as uploading, transcribing, or rendering. */
  stage: string | null;
  /** Fraction of the work done, from 0 to 1. */
  progress: number;
  items: OperationItem[];
  results: { projectId: string | null; clipIds: string[]; exportId: string | null };
  /** How the work was done, when the caller may want to act on it. */
  notices: FramingNotice[];
  failureCode: string | null;
}

const OPERATION_KIND_CODES: Record<OperationKind, number> = { intake: 1, generation: 2, export: 3 };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Public operation IDs are opaque: they encode kind and domain ID, and every
 * read decodes them server-side and rechecks Workspace access. */
export function encodeOperationId(operation: { kind: OperationKind; id: string }) {
  return `op_${Buffer.concat([Buffer.from([OPERATION_KIND_CODES[operation.kind]]), Buffer.from(operation.id.replaceAll("-", ""), "hex")]).toString("base64url")}`;
}

export function decodeOperationId(value: string): { kind: OperationKind; id: string } | null {
  if (!/^op_[A-Za-z0-9_-]{23}$/.test(value)) return null;
  const bytes = Buffer.from(value.slice(3), "base64url");
  const kind = (Object.entries(OPERATION_KIND_CODES).find(([, code]) => code === bytes[0])?.[0] ?? null) as OperationKind | null;
  if (!kind || bytes.length !== 17) return null;
  const hex = bytes.subarray(1).toString("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return UUID_PATTERN.test(id) ? { kind, id } : null;
}

/** Trusted reads report deleted, expired, or purged lineage as unavailable. */
export type TrustedOperationStatus = OperationStatus | { kind: OperationKind; id: string; state: "unavailable" };

export interface GenerationRun {
  id: string;
  stage: string;
  status: string;
  errorCode: string | null;
  idempotencyKey: string;
  contentPackId: string | null;
  progress?: number;
}

export interface GenerationRender {
  id: string;
  status: string;
  errorCode: string | null;
  failureDisposition?: string | null;
}

export interface GenerationLineage {
  origin: GenerationRun;
  detection: GenerationRun | null;
  /** Current rows of this generation's frozen renders (or of its clips when no
   * render set was frozen); rows can be reset or deleted later. */
  renders: GenerationRender[];
  renderRuns: GenerationRun[];
  /** The renders, with their clips, the detection handoff froze for this generation. */
  expectedRenders?: Array<{ renderId: string; clipId: string }>;
  /** First durable child outcomes, oldest first. */
  renderOutcomes?: GenerationRender[];
  /** Clips the detection run produced that still exist. */
  clipIds?: string[];
  /** A captioned video's generation ends with its export, not with a render. It
   * names the export its detection completion froze and keeps the first final
   * outcome that export reached, so a later retry or deletion of the export
   * does not change what the generation reported. */
  captionedVideo?: {
    exportId: string | null;
    outcome: CaptionedExportOutcome | null;
    export: ExportLineage | null;
  };
  notices?: FramingNotice[];
}

/** What a captioned video's export first ended as; see `generationExportResult`. */
export type CaptionedExportOutcome = NonNullable<WorkflowStageUpdatedEvent["generationExportResult"]>;

const TERMINAL_RUN = ["completed", "partial", "failed", "cancelled"];
const clamp = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
function runFraction(run: GenerationRun | null | undefined) {
  return clamp((run?.progress ?? 0) / 100);
}
function cancelledRun(run: GenerationRun) {
  return run.status === "cancelled" || run.errorCode === "MCP_CANCELLED";
}

/** The handoff freezes this generation's render IDs. First durable child
 * outcomes survive cache changes and exclude unrelated shared render work. */
export function deriveGenerationStatus(lineage: GenerationLineage): Omit<OperationStatus, "kind" | "id" | "results"> & { clipIds: string[]; exportId: string | null } {
  const clipIds = lineage.clipIds ?? [];
  const notices = lineage.notices ?? [];
  const exportId = lineage.captionedVideo?.exportId ?? null;
  const settle = (state: OperationState, stage: string, progress: number, failureCode: string | null = null, items: OperationItem[] = []) =>
    ({ state, stage, progress: state === "working" ? clamp(progress) : 1, items, failureCode, clipIds, exportId, notices });
  const settledRun = (run: GenerationRun, stage: string, progress: number) => {
    if (cancelledRun(run)) return settle("cancelled", stage, progress, "cancelled");
    if (run.status === "failed") return settle("failed", stage, progress, run.errorCode ?? "generation_failed");
    return settle("working", stage, progress);
  };
  const { origin, detection } = lineage;
  if (origin.status !== "completed") return settledRun(origin, "transcribing", 0.3 * runFraction(origin));
  if (!detection || detection.stage !== "moment_detection" || detection.contentPackId !== origin.contentPackId ||
    detection.idempotencyKey !== `${origin.idempotencyKey}__moment_detection`) return settle("working", "detecting", 0.3);
  if (detection.status !== "completed") return settledRun(detection, "detecting", 0.3 + 0.3 * runFraction(detection));
  if (lineage.captionedVideo) {
    const { outcome, export: exported } = lineage.captionedVideo;
    // The export's first final outcome stands: a retry that later succeeds, or
    // a deleted export, leaves what the generation reported as it was.
    if (outcome) {
      return settle(outcome.state, "rendering", 1, outcome.failureCode,
        outcome.items.map((item) => ({ kind: "variant" as const, ...item })));
    }
    // Detection admits the export in the transaction that completes it, so a
    // missing one was deleted before it ended.
    if (!exported) return settle("failed", "rendering", 1, "export_unavailable");
    const derived = deriveExportStatus(exported);
    return settle(derived.state, derived.stage ?? "rendering", 0.6 + 0.4 * derived.progress, derived.failureCode, derived.items);
  }
  if (!lineage.expectedRenders) {
    return lineage.renders.length ? settle("working", "rendering", 0.6) : settle("completed", "rendering", 1);
  }
  const settled = new Map<string, GenerationRender>();
  for (const outcome of lineage.renderOutcomes ?? []) if (!settled.has(outcome.id)) settled.set(outcome.id, outcome);
  const familyTerminal = lineage.renderRuns.length > 0 && lineage.renderRuns.every((run) => TERMINAL_RUN.includes(run.status));
  const clipOf = new Map(lineage.expectedRenders.map((render) => [render.renderId, render.clipId]));
  const results = lineage.expectedRenders.map(({ renderId: id }) => {
    const outcome = settled.get(id);
    if (outcome) return { id, render: outcome };
    const current = lineage.renders.find((render) => render.id === id);
    return { id, render: familyTerminal ? current : undefined };
  });
  const itemState = (render: GenerationRender | undefined): OperationItemState => {
    if (!render || !["completed", "failed"].includes(render.status)) return familyTerminal ? "failed" : "working";
    if (render.errorCode === "MCP_CANCELLED") return "cancelled";
    return render.status === "completed" ? "completed" : "failed";
  };
  const items: OperationItem[] = results.map(({ id, render }) => {
    const state = itemState(render);
    return { kind: "clip" as const, id: clipOf.get(id)!, state,
      failureCode: state === "failed" ? render?.errorCode ?? "render_unavailable" : state === "cancelled" ? "cancelled" : null };
  });
  const done = results.filter(({ render }) => render && ["completed", "failed"].includes(render.status)).length;
  const progress = 0.6 + 0.4 * (results.length ? done / results.length : 1);
  if (results.some(({ render }) => !render || !["completed", "failed"].includes(render.status))) {
    // Terminal work with a missing original artifact was superseded. A shared
    // run's unrelated success or failure cannot invent this generation's result.
    return familyTerminal ? settle("failed", "rendering", 1, "render_unavailable", items) : settle("working", "rendering", progress, null, items);
  }
  if (results.some(({ render }) => render?.errorCode === "MCP_CANCELLED")) return settle("cancelled", "rendering", 1, "cancelled", items);
  const failed = results.filter(({ render }) => render?.status === "failed");
  if (failed.length === 0) return settle("completed", "rendering", 1, null, items);
  const failureCode = failed[0]!.render?.errorCode ?? "render_failed";
  return settle(failed.length === results.length ? "failed" : "partial", "rendering", 1, failureCode, items);
}

export interface ExportLineage {
  status: string;
  progress: number;
  errorCode: string | null;
  variants: Array<{ id: string; status: string; hasAsset: boolean; errorCode: string | null }>;
}

export function deriveExportStatus(row: ExportLineage): Pick<OperationStatus, "state" | "stage" | "progress" | "items" | "failureCode"> {
  const cancelled = row.errorCode === "MCP_CANCELLED";
  const items: OperationItem[] = row.variants.map((variant) => {
    const state: OperationItemState = variant.status === "completed" && variant.hasAsset ? "completed"
      : variant.status === "completed" || variant.status === "failed" ? variant.errorCode === "MCP_CANCELLED" ? "cancelled" : "failed"
      : cancelled ? "cancelled" : "working";
    return { kind: "variant", id: variant.id, state,
      failureCode: state === "failed" ? variant.errorCode ?? "export_file_missing" : state === "cancelled" ? "cancelled" : null };
  });
  if (cancelled) return { state: "cancelled", stage: "rendering", progress: 1, items, failureCode: "cancelled" };
  if (!["ready", "partial_ready", "failed"].includes(row.status)) {
    return { state: "working", stage: "rendering", progress: clamp(row.progress / 100), items, failureCode: null };
  }
  const completed = items.filter((item) => item.state === "completed").length;
  const state: OperationState = completed === items.length && items.length > 0 ? "completed" : completed > 0 ? "partial" : "failed";
  return { state, stage: "rendering", progress: 1, items,
    failureCode: state === "completed" ? null : row.errorCode ?? items.find((item) => item.failureCode)?.failureCode ?? "export_failed" };
}

export type UploadSessionPhase = { status: string; failureCode: string | null };
export type IngestPhase = { status: string; lastError: string | null; generationHandoffAt: Date | null; generationRunId: string | null };

/** Intake before generation: Upload Session, then its Ingest Job and handoff.
 * Returns null once the Ingest Job has handed off; its stored generation run
 * then describes the intake. Callers treat missing accepted lineage as unavailable. */
export function deriveIntakePhase(upload: UploadSessionPhase | null, ingest: IngestPhase | null): Pick<OperationStatus, "state" | "stage" | "progress" | "failureCode"> | null {
  if (upload && upload.status !== "queued_for_ingest") {
    if (["initiating", "uploading"].includes(upload.status)) return { state: "working", stage: "uploading", progress: 0.02, failureCode: null };
    if (["finalizing", "reconciling", "compensating"].includes(upload.status)) return { state: "working", stage: "verifying", progress: 0.05, failureCode: null };
    if (upload.status === "aborted") return { state: "cancelled", stage: "uploading", progress: 1, failureCode: "cancelled" };
    if (upload.status === "expired") return { state: "failed", stage: "uploading", progress: 1, failureCode: upload.failureCode ?? "upload_session_expired" };
    return { state: "failed", stage: "verifying", progress: 1, failureCode: upload.failureCode ?? "upload_failed" };
  }
  if (!ingest) throw new Error("An accepted intake always has its Ingest Job");
  if (ingest.status === "cancelled") return { state: "cancelled", stage: "importing", progress: 1, failureCode: "cancelled" };
  if (ingest.status === "failed") {
    return { state: "failed", stage: ingest.generationHandoffAt ? "awaiting_generation" : "importing", progress: 1,
      failureCode: ingest.lastError?.match(/^([a-z0-9_]+):/)?.[1] ?? "ingest_failed" };
  }
  if (ingest.status !== "completed") return { state: "working", stage: "importing", progress: 0.1, failureCode: null };
  if (!ingest.generationHandoffAt) return { state: "working", stage: "awaiting_generation", progress: 0.2, failureCode: null };
  return null;
}

/** Intake progress reserves its first fifth for transfer and import. */
export function intakeProgress(generationProgress: number) {
  return clamp(0.2 + 0.8 * generationProgress);
}

function notFound(): never {
  throw new ExpectedDomainFailureError({ code: "operation_not_found", kind: "missing", message: "This operation is unavailable" });
}

class Unavailable extends Error {}

/** Reads one generation's lineage. Settlement transactions pass their own client. */
export async function readGenerationLineage(db: PrismaClient | Prisma.TransactionClient, projectId: string, originId: string): Promise<GenerationLineage | null> {
  const select = { id: true, stage: true, status: true, errorCode: true, idempotencyKey: true, contentPackId: true, progress: true } as const;
  const origin = await db.workflowRun.findFirst({ where: { id: originId, projectId }, select });
  if (!origin || origin.stage !== "stt") return null;
  // A captioned video froze its settings in the generation's Content Pack. Only
  // its framing and formats are read: the settings can carry up to 2 MB of
  // supplied captions that no status needs.
  const captioned = origin.contentPackId ? await readCaptionedPackFacts(db, origin.contentPackId) : null;
  const probe = captioned ? sourceProbeSchema.safeParse((await db.project.findUnique({ where: { id: projectId }, select: { sourceProbe: true } }))?.sourceProbe) : null;
  const notices = captioned ? captionedVideoFramingNotices(captioned, probe?.success ? probe.data : null) : [];
  const detection = await db.workflowRun.findFirst({
    where: { projectId, stage: "moment_detection", idempotencyKey: `${origin.idempotencyKey}__moment_detection`, contentPackId: origin.contentPackId }, select,
  });
  if (!detection) return { origin, detection: null, renders: [], renderRuns: [], notices };
  const events = await db.workflowEvent.findMany({ where: { projectId, workflowRunId: detection.id }, orderBy: { seq: "desc" }, select: { payload: true } });
  const handoff = events.map((event) => workflowStageUpdatedEventSchema.safeParse(event.payload))
    .find((event) => event.success && event.data.projectId === projectId && event.data.workflowRunId === detection.id && event.data.followUpWorkflowRunId);
  const renderId = handoff?.success ? handoff.data.followUpWorkflowRunId : undefined;
  const expectedRenders = handoff?.success ? handoff.data.generationRenders : undefined;
  const [renders, clips] = await Promise.all([
    db.clipRender.findMany({
      where: expectedRenders ? { id: { in: expectedRenders.map((render) => render.renderId) } } : { exportVariantId: null, clip: { projectId, workflowRunId: detection.id } },
      select: { id: true, status: true, errorCode: true, failureDisposition: true },
    }),
    db.clip.findMany({ where: { projectId, workflowRunId: detection.id }, orderBy: { index: "asc" }, select: { id: true } }),
  ]);
  // The mutable render cache can be reset or deleted by Studio or a later
  // generation. Its original Render Work Set and drain lineage retain history.
  const renderRuns = renderId ? await db.$queryRaw<GenerationRun[]>`
    WITH RECURSIVE family AS (
      SELECT run."id", run."stage", run."status", run."errorCode", run."idempotencyKey", run."contentPackId", ARRAY[run."id"] AS visited
      FROM "WorkflowRun" AS run
      WHERE run."id" = ${renderId}::uuid AND run."projectId" = ${projectId}::uuid AND run."stage" = 'clip_rendering'
      UNION ALL
      SELECT child."id", child."stage", child."status", child."errorCode", child."idempotencyKey", child."contentPackId", family.visited || child."id"
      FROM family INNER JOIN "WorkflowRun" AS child ON child."idempotencyKey" = 'drain-' || family."id"::text
      WHERE child."projectId" = ${projectId}::uuid AND child."stage" = 'clip_rendering' AND NOT child."id" = ANY(family.visited)
    ) SELECT "id", "stage", "status", "errorCode", "idempotencyKey", "contentPackId" FROM family
  ` : [];
  const renderEvents = renderRuns.length ? await db.workflowEvent.findMany({ where: { projectId,
    workflowRunId: { in: renderRuns.map((run) => run.id) } }, orderBy: { seq: "asc" }, select: { payload: true } }) : [];
  const renderOutcomes = [...events].reverse().concat(renderEvents).flatMap((event) => {
    const parsed = workflowStageUpdatedEventSchema.safeParse(event.payload);
    return parsed.success && parsed.data.projectId === projectId
      ? (parsed.data.generationRenderResults ?? []).map((result) => ({ id: result.renderId, status: result.status, errorCode: result.errorCode })) : [];
  });
  let captionedVideo: GenerationLineage["captionedVideo"];
  if (captioned) {
    const parsedEvents = events.flatMap((event) => {
      const parsed = workflowStageUpdatedEventSchema.safeParse(event.payload);
      return parsed.success && parsed.data.projectId === projectId && parsed.data.workflowRunId === detection.id ? [parsed.data] : [];
    });
    const frozen = parsedEvents.find((event) => event.generationExport)?.generationExport;
    // `events` is newest first; the first outcome recorded is the oldest.
    const outcome = [...parsedEvents].reverse().find((event) => event.generationExportResult)?.generationExportResult ?? null;
    const exported = frozen ? await db.clipExport.findUnique({
      where: { id: frozen.exportId },
      select: { id: true, status: true, progress: true, errorCode: true,
        variants: { orderBy: { createdAt: "asc" }, select: { id: true, status: true, storageKey: true, errorCode: true } } },
    }) : null;
    captionedVideo = {
      exportId: frozen?.exportId ?? null,
      outcome,
      export: exported && { status: exported.status, progress: exported.progress, errorCode: exported.errorCode,
        variants: exported.variants.map((variant) => ({ id: variant.id, status: variant.status, hasAsset: Boolean(variant.storageKey), errorCode: variant.errorCode })) },
    };
  }
  return { origin, detection, renders, renderRuns, renderOutcomes, expectedRenders, clipIds: clips.map((clip) => clip.id), notices,
    ...(captionedVideo ? { captionedVideo } : {}) };
}

/** A captioned video's framing and formats, or null when the pack is not one.
 * One JSON-path read: the settings blob itself is never loaded. */
export async function readCaptionedPackFacts(db: PrismaClient | Prisma.TransactionClient, contentPackId: string) {
  const rows = await db.$queryRaw<Array<{ framing: unknown; aspectRatios: unknown }>>`
    SELECT "captionedVideo"->'framing' AS "framing", "captionedVideo"->'aspectRatios' AS "aspectRatios"
    FROM "ContentPack"
    WHERE "id" = ${contentPackId}::uuid AND jsonb_typeof("captionedVideo") = 'object'
  `;
  const parsed = captionedVideoSettingsSchema.pick({ framing: true, aspectRatios: true }).safeParse(rows[0]);
  return parsed.success ? parsed.data : null;
}

export interface OperationStatusReader {
  /** Applies Project access and conceals work this actor cannot see. */
  read(scope: { workspaceId: string }, operation: { kind: OperationKind; id: string }): Promise<OperationStatus>;
  /** For trusted service callers only. Never exposes work across Workspaces. */
  readTrusted(scope: { workspaceId: string }, operation: { kind: OperationKind; id: string }): Promise<TrustedOperationStatus>;
}

export function createOperationStatusReader(prisma: PrismaClient): OperationStatusReader {
  async function accessibleProject(workspaceId: string, projectId: string) {
    return Boolean(await prisma.project.findFirst({ where: { id: projectId, workspaceId, ...accessibleProjectWhere() }, select: { id: true } }));
  }

  async function generation(workspaceId: string, id: string, projectId?: string): Promise<OperationStatus> {
    const run = await prisma.workflowRun.findFirst({ where: { id, stage: "stt", project: { workspaceId }, ...(projectId ? { projectId } : {}) }, select: { projectId: true } });
    if (!run || !await accessibleProject(workspaceId, run.projectId)) throw new Unavailable();
    const lineage = await readGenerationLineage(prisma, run.projectId, id);
    if (!lineage) throw new Unavailable();
    const derived = deriveGenerationStatus(lineage);
    return { kind: "generation", id, state: derived.state, stage: derived.stage, progress: derived.progress, items: derived.items, notices: derived.notices,
      failureCode: derived.failureCode, results: { projectId: run.projectId, clipIds: derived.clipIds, exportId: derived.exportId } };
  }

  async function intake(workspaceId: string, id: string): Promise<OperationStatus> {
    const ingestSelect = { id: true, projectId: true, status: true, lastError: true, generationHandoffAt: true, generationRunId: true } as const;
    const upload = await prisma.uploadSession.findFirst({ where: { id, workspaceId },
      select: { status: true, failureCode: true, preallocatedProjectId: true, ingestJob: { select: ingestSelect } } });
    const ingest = upload ? upload.ingestJob : await prisma.ingestJob.findFirst({ where: { id, project: { workspaceId } }, select: ingestSelect });
    // An accepted upload whose Ingest Job is gone lost its Project lineage.
    if (!upload && !ingest || upload?.status === "queued_for_ingest" && !ingest) throw new Unavailable();
    const projectId = ingest?.projectId ?? upload?.preallocatedProjectId ?? null;
    // An upload's Project row exists only once its intake is accepted.
    if (ingest && !await accessibleProject(workspaceId, ingest.projectId)) throw new Unavailable();
    const phase = deriveIntakePhase(upload ? { status: upload.status, failureCode: upload.failureCode } : null, ingest);
    const base = { kind: "intake" as const, id, items: [], notices: [], results: { projectId: ingest ? projectId : null, clipIds: [], exportId: null } };
    if (phase) return { ...base, ...phase };
    // The handed-off run was deleted (its reference is set null), so the
    // lineage is unavailable rather than failed.
    if (!ingest?.generationRunId) throw new Unavailable();
    const handedOff = await generation(workspaceId, ingest.generationRunId, ingest.projectId);
    return { ...handedOff, kind: "intake", id, progress: intakeProgress(handedOff.progress) };
  }

  async function exportOperation(workspaceId: string, id: string): Promise<OperationStatus> {
    const row = await prisma.clipExport.findFirst({ where: { id, workspaceId, project: { workspaceId, ...accessibleProjectWhere() } },
      select: { projectId: true, clipId: true, status: true, progress: true, errorCode: true,
        variants: { orderBy: { createdAt: "asc" }, select: { id: true, status: true, storageKey: true, errorCode: true } } } });
    if (!row) throw new Unavailable();
    const derived = deriveExportStatus({ status: row.status, progress: row.progress, errorCode: row.errorCode,
      variants: row.variants.map((variant) => ({ id: variant.id, status: variant.status, hasAsset: Boolean(variant.storageKey), errorCode: variant.errorCode })) });
    return { kind: "export", id, ...derived, notices: [], results: { projectId: row.projectId, clipIds: [row.clipId], exportId: id } };
  }

  async function resolve(workspaceId: string, operation: { kind: OperationKind; id: string }) {
    if (operation.kind === "intake") return intake(workspaceId, operation.id);
    if (operation.kind === "generation") return generation(workspaceId, operation.id);
    return exportOperation(workspaceId, operation.id);
  }

  return {
    async read(scope, operation) {
      try { return await resolve(scope.workspaceId, operation); }
      catch (error) { if (error instanceof Unavailable) notFound(); throw error; }
    },
    async readTrusted(scope, operation) {
      try { return await resolve(scope.workspaceId, operation); }
      catch (error) { if (error instanceof Unavailable) return { kind: operation.kind, id: operation.id, state: "unavailable" }; throw error; }
    },
  };
}
