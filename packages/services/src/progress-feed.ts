import type { PrismaClient, WorkflowEvent } from "@prisma/client";
import { PROGRESS_REPLAY_LIMIT, type WorkflowStageUpdatedEvent, workflowStageUpdatedEventSchema } from "@narriflow/validators/api/progress";
import { accessibleProjectWhere } from "./project-access";

/** Progress transport carries no captions, artifacts or frozen work-set payload. */
export function progressEvent(row: Pick<WorkflowEvent, "projectId" | "workflowRunId" | "ingestJobId" | "seq" | "stage" | "status" | "progress" | "errorCode" | "emittedAt">): WorkflowStageUpdatedEvent {
  return workflowStageUpdatedEventSchema.parse({ event: "workflow.stage.updated", projectId: row.projectId,
    workflowRunId: row.workflowRunId, ...(row.ingestJobId ? { ingestJobId: row.ingestJobId } : {}),
    seq: row.seq, stage: row.stage, status: row.status, progress: row.progress, errorCode: row.errorCode, emittedAt: row.emittedAt.toISOString() });
}

export interface ProgressReplay {
  events: WorkflowStageUpdatedEvent[];
  highWater: number;
  reset: boolean;
}

/** Called once after the DO has subscribed and begun buffering. The Project
 * counter and event append commit atomically; newer events merge in the DO. */
export async function readProgressReplay(prisma: PrismaClient, scope: { projectId: string; workspaceId: string }, cursor: number): Promise<ProgressReplay | null> {
  const project = await prisma.project.findFirst({ where: { id: scope.projectId, workspaceId: scope.workspaceId, ...accessibleProjectWhere() }, select: { workflowEventSeq: true } });
  if (!project) return null;
  const highWater = project.workflowEventSeq;
  const rows = await prisma.workflowEvent.findMany({
    where: { projectId: scope.projectId, seq: { gt: cursor, lte: highWater } }, orderBy: { seq: "asc" }, take: PROGRESS_REPLAY_LIMIT + 1,
  });
  let expected = cursor;
  const reset = cursor > highWater || rows.length > PROGRESS_REPLAY_LIMIT || rows.some((row) => row.seq !== ++expected) || expected !== highWater;
  return { events: reset ? [] : rows.map(progressEvent), highWater, reset };
}

export interface ProgressRevocation { projectId: string; workspaceId: string; actorUserId?: string; authorizedBefore: number; error: "workspace_membership_required" | "workspace_restricted" | "project_inaccessible" }

/** Structural HTTP binding contract. Browser RPC types never load Workers globals. */
export interface ProgressConnection {
  fetch(request: Request): Promise<Response>;
  replay(nonce: string, replay: ProgressReplay): Promise<void>;
  abortReplay(nonce: string): Promise<void>;
  revoke(input: ProgressRevocation): Promise<void>;
  publish(scope: { projectId: string; workspaceId: string }, event: WorkflowStageUpdatedEvent): Promise<void>;
}
