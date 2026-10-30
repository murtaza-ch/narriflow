/** Test-only convenience for fixtures that need settled media. All writes use
 * the real group admission, token, start, outcome and settlement protocol. */
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { RenderGroupLifecycle } from "./render-group-lifecycle";
import type { ClaimedRenderGroupAttempt } from "./render-group-contract";
import { WorkflowRunLifecycle, type WorkflowAttemptRef, WorkflowAttemptLost } from "./workflow-run-lifecycle";

export class RenderFixtureLifecycle extends WorkflowRunLifecycle {
  readonly fixturePrisma: PrismaClient;
  readonly fixtureGroups: RenderGroupLifecycle;
  private readonly claims = new Map<string, Promise<ClaimedRenderGroupAttempt>>();
  constructor(deps: ConstructorParameters<typeof WorkflowRunLifecycle>[0] & { prisma: PrismaClient }) {
    super(deps);
    this.fixturePrisma = deps.prisma;
    this.fixtureGroups = new RenderGroupLifecycle({ prisma: deps.prisma, leaseOwner: randomUUID() });
  }
  override async beginRenderWorkSet(attempt: WorkflowAttemptRef) {
    const workSet = await super.beginRenderWorkSet(attempt);
    await this.prepareGroups(attempt);
    return workSet;
  }
  async prepareGroups(attempt: WorkflowAttemptRef) {
    await this.assertOwnership(attempt);
    const parent = await this.fixturePrisma.workflowRun.findUniqueOrThrow({ where: { id: attempt.workflowRunId } });
    if (parent.renderWorkSetGeneration) return [];
    const rows = await this.fixturePrisma.clipRender.findMany({ where: { workflowRunId: attempt.workflowRunId }, include: { clip: true, exportVariant: { include: { export: true } } } });
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.clipId}:${row.exportVariant?.exportId ?? "auto"}:${row.resolution}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return this.admitRenderGroups(attempt, [...groups.values()].map((members) => {
      const row = members[0]!;
      return { configuration: { clipId: row.clipId, exportId: row.exportVariant?.exportId ?? null,
        editorRevision: row.editorRevision ?? row.clip.editorRevision, resolution: row.resolution as "720p" | "1080p",
        watermark: row.exportVariant?.watermark ?? false }, variantIds: members.map((m) => m.id) };
    }));
  }
  async groupFor(attempt: WorkflowAttemptRef, id: string) {
    await this.assertOwnership(attempt);
    if (attempt.stage !== "clip_rendering") throw new WorkflowAttemptLost(attempt);
    await this.prepareGroups(attempt);
    const member = await this.fixturePrisma.renderGroupMember.findFirst({ where: { workflowRunId: attempt.workflowRunId, clipRenderId: id } });
    if (!member) throw new WorkflowAttemptLost(attempt);
    let pending = this.claims.get(member.groupId);
    if (!pending) {
      pending = (async () => {
        const group = await this.fixtureGroups.claim({ groupId: member.groupId });
        if (!group) throw new WorkflowAttemptLost(attempt);
        await this.fixtureGroups.start({ ...group, sourceFingerprint: "fixture-source", analysisFingerprint: null, toolchainFingerprint: "fixture-toolchain" });
        return group;
      })();
      this.claims.set(member.groupId, pending);
    }
    return pending;
  }
  async markClipRenderVariantRendering(attempt: WorkflowAttemptRef, id: string) {
    return this.fixtureGroups.markClipRenderVariantRendering(await this.groupFor(attempt, id), id);
  }
  async completeClipRenderVariant(attempt: WorkflowAttemptRef, id: string, input: { storageKey: string; sizeBytes: number; durationSec: number }) {
    return this.fixtureGroups.completeClipRenderVariant(await this.groupFor(attempt, id), id, input);
  }
  async failClipRenderVariant(attempt: WorkflowAttemptRef, id: string, code: string, disposition: "retryable" | "permanent") {
    return this.fixtureGroups.failClipRenderVariant(await this.groupFor(attempt, id), id, code, disposition);
  }
  async completeClipAutoLayoutAnalysis(attempt: WorkflowAttemptRef, input: Evidence) { return this.writeEvidence(attempt, input, "automatic"); }
  async completeClipSplitLayoutAnalysis(attempt: WorkflowAttemptRef, input: Evidence) { return this.writeEvidence(attempt, input, "split"); }
  async completeClipSplitLayoutFailure(attempt: WorkflowAttemptRef, input: Evidence) { return this.writeEvidence(attempt, input, "split"); }
  async setClipLayoutAnalysis(attempt: WorkflowAttemptRef, input: Evidence) { return this.writeEvidence(attempt, input, "screen"); }
  async setClipLayoutAnalysisFailure(attempt: WorkflowAttemptRef, input: Evidence) { return this.writeEvidence(attempt, input, "screen"); }
  private async writeEvidence(attempt: WorkflowAttemptRef, input: Evidence, field: "automatic" | "split" | "screen") {
    const variant = await this.fixturePrisma.clipRender.findFirst({ where: { workflowRunId: attempt.workflowRunId, clipId: input.clipId, status: "rendering" } });
    if (!variant) throw new WorkflowAttemptLost(attempt);
    return this.fixtureGroups.writeLayoutEvidence(await this.groupFor(attempt, variant.id), { ...input, evidence: (input.analysis ?? input.failure)!, field });
  }
  async finishGroups() {
    for (const [id, pending] of this.claims) {
      const group = await pending;
      await this.fixtureGroups.finish({ ...group, result: "completed", errorCode: null, failureDisposition: null });
      this.claims.delete(id);
    }
  }
  async retryGroups(workflowRunId: string) {
    await this.finishGroups();
    await this.fixturePrisma.renderGroup.updateMany({ where: { workflowRunId, status: "queued" }, data: { nextAttemptAt: new Date(0) } });
  }
  override async settleRenderWorkSet(attempt: WorkflowAttemptRef) {
    await this.finishGroups();
    return super.settleRenderWorkSet(attempt);
  }
}
type Evidence = { clipId: string; editorRevision: number; previewStorageKey: string; analysis?: Prisma.InputJsonValue; failure?: Prisma.InputJsonValue };
