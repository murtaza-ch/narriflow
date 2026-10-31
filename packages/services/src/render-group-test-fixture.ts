
import type { Prisma, PrismaClient } from "@prisma/client";
import { WorkflowRunLifecycle, type WorkflowAttemptRef, WorkflowAttemptLost } from "./workflow-run-lifecycle";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import { readExecutionDispatch } from "./execution-dispatch";
import { acquireFixtureRenderGroup, prepareFixtureSource } from "./render-execution-test-fixture";

export class RenderFixtureLifecycle extends WorkflowRunLifecycle {
  readonly fixturePrisma: PrismaClient;
  private readonly parents = new Map<string, ExecutionDispatchReference>();
  private readonly claims = new Map<string, Promise<Awaited<ReturnType<typeof acquireFixtureRenderGroup>>>>();
  constructor(deps: ConstructorParameters<typeof WorkflowRunLifecycle>[0] & { prisma: PrismaClient }) {
    super(deps);
    this.fixturePrisma = deps.prisma;
  }
  /** Registers the exact accepted parent without acquiring execution authority. */
  async renderParent(runId: string) {
    const run = await this.fixturePrisma.workflowRun.findUniqueOrThrow({ where: { id: runId }, include: { project: true } });
    if (run.stage !== "clip_rendering") throw Error("Not a render parent");
    const reference = (await this.fixturePrisma.$transaction(tx => this.dispatchRunWithinTransaction(tx, run.id))).reference;
    this.parents.set(reference.dispatchId, reference);
    return { workflowRunId: run.id, projectId: run.projectId, stage: "clip_rendering" as const, attemptId: reference.dispatchId, attemptCount: 0,
      contentPackId: run.contentPackId, progress: run.progress, status: run.status, leaseExpiresAt: null, project: run.project };
  }
  async assertOwnership(attempt: WorkflowAttemptRef) {
    const reference = this.parents.get(attempt.attemptId);
    if (!reference || reference.subject.id !== attempt.workflowRunId || attempt.stage !== "clip_rendering") throw new WorkflowAttemptLost(attempt);
  }
  async referenceFor(attempt: WorkflowAttemptRef) {
    await this.assertOwnership(attempt);
    return this.parents.get(attempt.attemptId)!;
  }
  async beginRenderWorkSet(attempt: WorkflowAttemptRef) {
    await this.assertOwnership(attempt);
    const prepared = await this.prepareRenderRun(this.parents.get(attempt.attemptId)!);
    if (prepared.kind === "superseded") throw new WorkflowAttemptLost(attempt);
    const run = await this.fixturePrisma.workflowRun.findUniqueOrThrow({ where: { id: attempt.workflowRunId } });
    if (!run.renderWorkSetFrozenAt) throw Error("Render work set not prepared");
    return { workflowRunId: run.id, frozenAt: run.renderWorkSetFrozenAt,
      variantIds: (await this.fixturePrisma.clipRender.findMany({ where: { workflowRunId: run.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } })).map(row => row.id) };
  }
  async prepareGroups(attempt: WorkflowAttemptRef) {
    await this.beginRenderWorkSet(attempt);
    return this.fixturePrisma.renderGroup.findMany({ where: { workflowRunId: attempt.workflowRunId } });
  }
  async groupFor(attempt: WorkflowAttemptRef, id: string) {
    await this.assertOwnership(attempt);
    if (attempt.stage !== "clip_rendering") throw new WorkflowAttemptLost(attempt);
    await prepareFixtureSource(this.fixturePrisma, attempt.projectId);
    await this.prepareGroups(attempt);
    const member = await this.fixturePrisma.renderGroupMember.findFirst({ where: { workflowRunId: attempt.workflowRunId, clipRenderId: id } });
    if (!member) throw new WorkflowAttemptLost(attempt);
    let pending = this.claims.get(member.groupId);
    if (!pending) {
      pending = (async () => {
        const group = await this.fixturePrisma.renderGroup.findUniqueOrThrow({ where: { id: member.groupId } });
        const row = await this.fixturePrisma.executionDispatch.findFirstOrThrow({ where: { kind: "operation_driver", subjectKind: "render_group", subjectId: group.id,
          generation: group.generation, deploymentEpoch: group.deploymentEpoch, wakeKind: null, deadlineKind: null } });
        return acquireFixtureRenderGroup(this.fixturePrisma, (await readExecutionDispatch(this.fixturePrisma, row.id))!.reference);
      })();
      this.claims.set(member.groupId, pending);
    }
    return pending;
  }
  async markClipRenderVariantRendering(attempt: WorkflowAttemptRef, id: string) {
    const row = await this.fixturePrisma.clipRender.findFirst({ where: { id, workflowRunId: attempt.workflowRunId } });
    if (!row || row.status === "completed" || row.status === "failed" && row.failureDisposition !== "retryable") return false;
    await this.groupFor(attempt, id);
    return true;
  }
  async completeClipRenderVariant(attempt: WorkflowAttemptRef, id: string, input: { storageKey: string; sizeBytes: number; durationSec: number; captionDiagnostics?: { omittedCodePoints: string[]; skippedEmoji: string[] } | null; brollCredits?: Prisma.InputJsonValue | null }) {
    return (await this.groupFor(attempt, id)).complete(id, input);
  }
  async failClipRenderVariant(attempt: WorkflowAttemptRef, id: string, code: string, disposition: "retryable" | "permanent") {
    return (await this.groupFor(attempt, id)).fail(id, code, disposition);
  }
  async finishGroups() {
    for (const [id, pending] of this.claims) {
      const group = await pending;
      const current = await this.fixturePrisma.renderGroup.findUnique({ where: { id } });
      if (current?.attemptToken === group.fence.attemptToken) await group.send({ action: "fail", fence: group.fence, failureCode: "fixture_interrupted", retryable: true });
      this.claims.delete(id);
    }
  }
  async retryGroups(workflowRunId: string) {
    await this.finishGroups();
    await this.fixturePrisma.renderGroup.updateMany({ where: { workflowRunId, status: "queued" }, data: { nextAttemptAt: new Date(0) } });
  }
  async settleRenderWorkSet(attempt: WorkflowAttemptRef) {
    await this.finishGroups();
    await this.assertOwnership(attempt);
    const settled = await this.settleRenderRun(this.parents.get(attempt.attemptId)!);
    if (settled.kind !== "settled") throw new WorkflowAttemptLost(attempt);
    return settled.outcome;
  }
}
