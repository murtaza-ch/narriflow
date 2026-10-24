import type { Prisma } from "@prisma/client";
import { workflowStageUpdatedEventSchema } from "@narriflow/validators";
import { deriveExportStatus, deriveGenerationStatus, encodeOperationId, readCaptionedPackFacts, readGenerationLineage, type OperationKind, type OperationState } from "./operation-status";
import { transitionGenerationFinishing } from "./generation-finishing";
import { appendWorkflowEvent } from "./workflow-event-append";
import { flushWorkspaceEvents, queueWorkspaceEvent } from "./workspace-event";

/** `operation.finished` Workspace Events: one per terminal transition of an
 * Operation Status lineage, with the state Operation Status reports for it.
 *
 * The `queue…` functions only read and remember: a lifecycle transaction calls
 * them from wherever the transition happens and flushes once at its end, so
 * the Workspace counter is the last lock it takes. Replays and later
 * settlements of the same lineage are absorbed by the durable dedupe keys. */

type Tx = Prisma.TransactionClient;
type FinishedState = Exclude<OperationState, "working">;

function queueOperationFinished(tx: Tx, input: { workspaceId: string; projectId: string | null; operation: { kind: OperationKind; id: string }; state: FinishedState; transition?: number }) {
  queueWorkspaceEvent(tx, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    type: "operation.finished",
    subject: { operation: { kind: input.operation.kind, id: encodeOperationId(input.operation) }, projectId: input.projectId, state: input.state },
    dedupeKey: `operation.finished:${input.operation.kind}:${input.operation.id}${input.transition === undefined ? "" : `:${input.transition}`}`,
  });
}

const generationKey = (originId: string) => `operation.finished:generation:${originId}`;

/** An intake is named by its Upload Session when it has one, else by its Ingest Job. */
function intakeOperationId(job: { id: string; uploadSessionId: string | null }) {
  return job.uploadSessionId ?? job.id;
}

/** An Ingest Job that ended before it handed off to generation ends its intake.
 * Writes at once: call it as the last act of the settling transaction. */
export async function emitIntakeFinished(tx: Tx, ingestJobId: string, state: "failed" | "cancelled"): Promise<void> {
  await queueIngestJobFinished(tx, ingestJobId, state);
  await flushWorkspaceEvents(tx);
}

async function queueIngestJobFinished(tx: Tx, ingestJobId: string, state: FinishedState) {
  const job = await tx.ingestJob.findUnique({ where: { id: ingestJobId }, select: { id: true, projectId: true, uploadSessionId: true, project: { select: { workspaceId: true } } } });
  if (!job) return;
  queueOperationFinished(tx, { workspaceId: job.project.workspaceId, projectId: job.projectId, operation: { kind: "intake", id: intakeOperationId(job) }, state });
}

/** An Upload Session that ended before its import started. Operation Status
 * reports it as the intake: `aborted` is cancelled, the rest failed. It has no
 * Project to name. Writes at once: call it as the last act of the transaction. */
export async function emitUploadIntakeFinished(tx: Tx, input: { workspaceId: string; sessionId: string; status: "expired" | "aborted" | "failed" }): Promise<void> {
  queueOperationFinished(tx, { workspaceId: input.workspaceId, projectId: null, operation: { kind: "intake", id: input.sessionId }, state: input.status === "aborted" ? "cancelled" : "failed" });
  await flushWorkspaceEvents(tx);
}

const DETECTION_SUFFIX = "__moment_detection";
const DRAIN_PREFIX = /^drain-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The speech-to-text runs whose generation lineage includes this run. A
 * generation's lineage is its stt run, its detection run, and the render run
 * its handoff named together with that run's drain follow-ups. */
async function originsOfRun(tx: Tx, run: { id: string; projectId: string }): Promise<string[]> {
  const row = await tx.workflowRun.findUnique({ where: { id: run.id }, select: { stage: true, idempotencyKey: true } });
  if (!row) return [];
  const originOfDetection = async (key: string) => key.endsWith(DETECTION_SUFFIX)
    ? (await tx.workflowRun.findFirst({ where: { projectId: run.projectId, stage: "stt", idempotencyKey: key.slice(0, -DETECTION_SUFFIX.length) }, select: { id: true } }))?.id ?? null
    : null;
  if (row.stage === "stt") return [run.id];
  if (row.stage === "moment_detection") return [await originOfDetection(row.idempotencyKey)].flatMap((id) => (id ? [id] : []));
  if (row.stage !== "clip_rendering") return [];
  // Walk from the settling run to the run a handoff could have named.
  const chain = [run.id];
  let key = row.idempotencyKey;
  for (let depth = 0; depth < 25; depth += 1) {
    const parentId = DRAIN_PREFIX.exec(key)?.[1];
    if (!parentId) break;
    const parent = await tx.workflowRun.findFirst({ where: { id: parentId, projectId: run.projectId }, select: { id: true, idempotencyKey: true } });
    if (!parent) break;
    chain.push(parent.id);
    key = parent.idempotencyKey;
  }
  const handoffs = await tx.$queryRaw<Array<{ workflowRunId: string }>>`
    SELECT DISTINCT "workflowRunId" FROM "WorkflowEvent"
    WHERE "projectId" = ${run.projectId}::uuid AND "stage" = 'moment_detection' AND "workflowRunId" IS NOT NULL
      AND "payload"->>'followUpWorkflowRunId' = ANY(${chain}::text[])
  `;
  if (handoffs.length === 0) return [];
  const detections = await tx.workflowRun.findMany({ where: { id: { in: handoffs.map((handoff) => handoff.workflowRunId) }, stage: "moment_detection" }, select: { idempotencyKey: true } });
  return (await Promise.all(detections.map((detection) => originOfDetection(detection.idempotencyKey)))).flatMap((id) => (id ? [id] : []));
}

/** Called when a transaction settles a Workflow Run, after the run's follow-up
 * work is admitted. Derives only the generation lineages that run belongs to,
 * exactly as Operation Status does, and queues the ones that are terminal. An
 * intake that handed off to a finished generation finishes with it. */
export async function queueFinishedGenerations(tx: Tx, run: { id: string; projectId: string }): Promise<void> {
  const origins = await originsOfRun(tx, run);
  if (origins.length === 0) return;
  const finished = new Set((await tx.workspaceEventKey.findMany({ where: { dedupeKey: { in: origins.map(generationKey) } }, select: { dedupeKey: true } })).map((key) => key.dedupeKey));
  const pending = origins.filter((origin) => !finished.has(generationKey(origin)));
  if (pending.length === 0) return;
  const project = await tx.project.findUnique({ where: { id: run.projectId }, select: { workspaceId: true } });
  if (!project) return;
  for (const origin of pending) {
    const lineage = await readGenerationLineage(tx, run.projectId, origin);
    if (!lineage) continue;
    const { state } = deriveGenerationStatus(lineage);
    if (state === "working") continue;
    queueOperationFinished(tx, { workspaceId: project.workspaceId, projectId: run.projectId, operation: { kind: "generation", id: origin }, state });
    // Finishing starts from this same transition: a plain update of its own row, before the flush.
    await transitionGenerationFinishing(tx, origin, state);
    await queueHandedOffIntakeFinished(tx, origin, state);
  }
}

/** An intake can acknowledge a generation that already finished. It finishes
 * with that generation, in the state Operation Status reports for it. */
export async function queueIntakeFinishedByGeneration(tx: Tx, generationRunId: string): Promise<void> {
  const located = await tx.workflowRun.findUnique({ where: { id: generationRunId }, select: { projectId: true, stage: true, idempotencyKey: true } });
  if (!located || located.stage !== "stt") return;
  // A speech-to-text or detection settlement still in flight has not yet seen
  // this acknowledgement, so it will not announce the intake. Wait for it: it
  // holds a row lock on its run, and the reads below start only after it
  // commits. If the acknowledgement commits first, the settlement finds it.
  await tx.$queryRaw`
    SELECT run."id" FROM "WorkflowRun" AS run
    WHERE run."id" = ${generationRunId}::uuid
      OR (run."projectId" = ${located.projectId}::uuid AND run."stage" = 'moment_detection' AND run."idempotencyKey" = ${`${located.idempotencyKey}${DETECTION_SUFFIX}`})
    FOR SHARE
  `;
  const origin = await tx.workflowRun.findUnique({ where: { id: generationRunId }, select: { projectId: true, status: true } });
  // A queued, running or waiting speech-to-text run can't have finished.
  if (!origin || ["queued", "running", "waiting"].includes(origin.status)) return;
  const lineage = await readGenerationLineage(tx, origin.projectId, generationRunId);
  if (!lineage) return;
  const { state } = deriveGenerationStatus(lineage);
  if (state !== "working") await queueHandedOffIntakeFinished(tx, generationRunId, state);
}

async function queueHandedOffIntakeFinished(tx: Tx, generationRunId: string, state: FinishedState): Promise<void> {
  const jobs = await tx.ingestJob.findMany({ where: { generationRunId }, select: { id: true, projectId: true, uploadSessionId: true, project: { select: { workspaceId: true } } } });
  for (const job of jobs) {
    queueOperationFinished(tx, { workspaceId: job.project.workspaceId, projectId: job.projectId, operation: { kind: "intake", id: intakeOperationId(job) }, state });
  }
}

/** Queues an export that is terminal and final. A variant that failed with a
 * retryable error is not final while its render run can still requeue it, so
 * that case waits for the run's own settlement. A retried export has a new
 * `retryCount`, so its next outcome is a new event. */
export async function queueExportFinished(tx: Tx, exportId: string): Promise<void> {
  const row = await tx.clipExport.findUnique({
    where: { id: exportId },
    select: { projectId: true, workspaceId: true, status: true, progress: true, errorCode: true, retryCount: true,
      clip: { select: { workflowRunId: true } },
      variants: { orderBy: { createdAt: "asc" }, select: { id: true, status: true, storageKey: true, errorCode: true,
        render: { select: { failureDisposition: true, workflowRun: { select: { status: true } } } } } } },
  });
  if (!row?.workspaceId || !["ready", "partial_ready", "failed"].includes(row.status)) return;
  const mayRetry = row.variants.some((variant) => variant.status === "failed" && variant.render?.failureDisposition === "retryable"
    && variant.render.workflowRun && ["queued", "running", "waiting"].includes(variant.render.workflowRun.status));
  if (mayRetry) return;
  const derived = deriveExportStatus({ status: row.status, progress: row.progress, errorCode: row.errorCode,
    variants: row.variants.map((variant) => ({ id: variant.id, status: variant.status, hasAsset: Boolean(variant.storageKey), errorCode: variant.errorCode })) });
  if (derived.state === "working") return;
  queueOperationFinished(tx, { workspaceId: row.workspaceId, projectId: row.projectId, operation: { kind: "export", id: exportId }, state: derived.state, transition: row.retryCount });
  await queueCaptionedGenerationFinished(tx, { projectId: row.projectId, detectionRunId: row.clip.workflowRunId, exportId, derived });
}

/** A captioned video's generation ends with its single export, not with a
 * render run, so that export's first final settlement is also the generation's.
 * It records the export's outcome once on the detection run, which is what the
 * generation then reports: a retry of the export re-emits the export's own
 * event but leaves the generation as first announced, and so does deleting it.
 * The generation is derived exactly as Operation Status derives it and is
 * announced once, by whichever settlement (this one or the detection run's)
 * comes last. Only reads and appends: the caller flushes last.
 *
 * Detection admits the export in the transaction that completes it, so the run
 * is already completed here and the two settlements cannot overlap. */
async function queueCaptionedGenerationFinished(tx: Tx, input: { projectId: string; detectionRunId: string | null; exportId: string; derived: ReturnType<typeof deriveExportStatus> }): Promise<void> {
  if (!input.detectionRunId) return;
  const detection = await tx.workflowRun.findUnique({ where: { id: input.detectionRunId }, select: { id: true, status: true, attemptId: true, contentPackId: true } });
  if (!detection?.contentPackId || !(await readCaptionedPackFacts(tx, detection.contentPackId))) return;
  // Only the export that detection froze is the video's export: a clip made
  // later in the same run (in the Studio or from a search result) exports on its own.
  const history = await tx.workflowEvent.findMany({ where: { workflowRunId: detection.id, projectId: input.projectId }, select: { payload: true } });
  const frozen = history.map((event) => workflowStageUpdatedEventSchema.safeParse(event.payload)).find((event) => event.success && event.data.generationExport);
  if (!frozen?.success || frozen.data.generationExport?.exportId !== input.exportId) return;
  if (detection.status === "completed") {
    await appendWorkflowEvent(tx, {
      projectId: input.projectId, workflowRunId: detection.id, attemptId: detection.attemptId ?? detection.id,
      stage: "moment_detection", status: "completed", progress: 100, errorCode: null, transition: "captioned_export_final",
      generationExportResult: {
        exportId: input.exportId,
        state: input.derived.state as Exclude<OperationState, "working">,
        failureCode: input.derived.failureCode,
        items: input.derived.items.map((item) => ({ id: item.id, state: item.state === "working" ? "failed" : item.state, failureCode: item.failureCode })),
      },
    // A record for history: nothing is owed to Redis or analytics.
    }, { redisRequired: false, analyticsEnabled: false });
  }
  await queueFinishedGenerations(tx, { id: detection.id, projectId: input.projectId });
}

/** The exports that own a variant rendered by this Workflow Run. */
export async function queueExportsFinishedByRun(tx: Tx, workflowRunId: string): Promise<void> {
  const owners = await tx.clipExportVariant.findMany({ where: { render: { workflowRunId } }, select: { exportId: true }, distinct: ["exportId"], orderBy: { exportId: "asc" } });
  for (const { exportId } of owners) await queueExportFinished(tx, exportId);
}

/** Writes at once: call it as the last act of the transaction. */
export async function emitExportFinished(tx: Tx, exportId: string): Promise<void> {
  await queueExportFinished(tx, exportId);
  await flushWorkspaceEvents(tx);
}

/** Project expiry cancels queued intakes and fails queued exports; queue their
 * events. The caller flushes after its own writes. */
export async function queueProjectExpiryFinished(tx: Tx, projectId: string): Promise<void> {
  const jobs = await tx.ingestJob.findMany({ where: { projectId, status: "cancelled", lastError: "PROJECT_EXPIRED" }, select: { id: true } });
  for (const job of jobs) await queueIngestJobFinished(tx, job.id, "cancelled");
  const exports = await tx.clipExport.findMany({ where: { projectId, status: "failed", errorCode: "PROJECT_EXPIRED" }, select: { id: true } });
  for (const row of exports) await queueExportFinished(tx, row.id);
}
