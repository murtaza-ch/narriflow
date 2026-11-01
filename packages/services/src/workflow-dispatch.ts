import type { Prisma, WorkflowRun } from "@prisma/client";
import { appendExecutionDispatch, executionDispatchIdentity } from "./execution-dispatch";
import { collectExecutionDispatch } from "./execution-dispatch-runtime";
import { workflowRunExecutionInputHash } from "./workflow-execution-input";

export async function readWorkflowRunInputHash(tx: Prisma.TransactionClient, run: WorkflowRun, sourceRevision: number): Promise<string> {
  const transcript = await tx.transcript.findUnique({ where: { projectId: run.projectId }, select: { id: true, selectionGeneration: true, workflowAttemptId: true, sourceAudioId: true, sourceRevision: true } });
  if (transcript && transcript.sourceRevision !== sourceRevision) throw new Error("workflow_source_revision_superseded");
  return workflowRunExecutionInputHash({ id: run.id, projectId: run.projectId, stage: run.stage, contentPackId: run.contentPackId,
    generation: run.generation, deploymentEpoch: run.deploymentEpoch, sourceAudioId: transcript?.sourceAudioId ?? null, sourceRevision: transcript?.sourceRevision ?? sourceRevision,
    sourceTranscript: transcript ? { id: transcript.id, generation: transcript.selectionGeneration, attemptId: transcript.workflowAttemptId } : null });
}

/** Domain callers hold their Workspace, Project and parent locks. */
export async function appendWorkflowRunDispatch(tx: Prisma.TransactionClient, runId: string) {
  const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: runId }, include: { project: { select: { sourceRevision: true } } } });
  const identity = { deploymentEpoch: run.deploymentEpoch, kind: run.stage === "clip_rendering" ? "render_run" as const : "operation_driver" as const,
    subject: { kind: "workflow_run" as const, id: run.id }, generation: run.generation };
  const key = await executionDispatchIdentity(identity);
  const existing = await tx.executionDispatch.findUnique({ where: { deliveryKey: key.deliveryKey }, select: { dueAt: true } });
  return appendExecutionDispatch(tx, { ...identity, inputHash: await readWorkflowRunInputHash(tx, run, run.project.sourceRevision), dueAt: existing?.dueAt ?? run.nextAttemptAt ?? run.createdAt });
}

/** Replaying accepted work only redelivers its current committed obligation.
 * It never admits a run, resets its deadline or creates another generation. */
export async function collectExistingWorkflowRunDispatch(tx: Prisma.TransactionClient, runId: string) {
  const run = await tx.workflowRun.findUniqueOrThrow({ where: { id: runId } });
  if (!["queued", "running", "waiting"].includes(run.status)) return;
  const key = await executionDispatchIdentity({ deploymentEpoch: run.deploymentEpoch,
    kind: run.stage === "clip_rendering" ? "render_run" : "operation_driver",
    subject: { kind: "workflow_run", id: run.id }, generation: run.generation });
  const dispatch = await tx.executionDispatch.findUnique({ where: { deliveryKey: key.deliveryKey }, select: { id: true } });
  if (dispatch) collectExecutionDispatch(tx, dispatch.id);
}
