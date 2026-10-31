import { bindServiceTestEnvironment } from "./runtime-test-support";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { acquireFixtureRenderGroup, fixtureExecutionRequest, prepareFixtureSource } from "./render-execution-test-fixture";
import { readExecutionDispatch } from "./execution-dispatch";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";

const url = process.env.WORKFLOW_TEST_DATABASE_URL, schema = process.env.WORKFLOW_TEST_DATABASE_SCHEMA;
const suite = process.env.ALLOW_WORKFLOW_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Render Group independent native invocations", () => {
  let db: PrismaClient;
  beforeAll(() => {
    if (!url || !schema?.startsWith("workflow_lifecycle_test_") || new URL(url).hostname !== "localhost") throw Error("Use a disposable Workflow test schema");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 12 }, { schema }), transactionOptions: { timeout: 30_000, maxWait: 30_000 } });
  });
  afterAll(async () => { await db?.$disconnect(); });
  async function fixture(clipCount = 1, aspectCount = 2) {
    const user = await db.user.create({ data: { clerkId: `native-replica-test:${randomUUID()}` } });
    const workspace = await db.workspace.create({ data: { ownerUserId: user.id, name: "Independent invocations" } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, title: "Independent invocations", sourceMediaUrl: "r2://fixture/source", sourceDurationSeconds: 100 } });
    const run = await db.workflowRun.create({ data: { projectId: project.id, stage: "clip_rendering", status: "queued", idempotencyKey: randomUUID() } });
    const variants: string[][] = [];
    for (let index = 0; index < clipCount; index++) {
      const clip = await db.clip.create({ data: { projectId: project.id, workflowRunId: run.id, index, startSec: index * 10, endSec: index * 10 + 10,
        hookText: "Hook", reasoning: "Fixture", category: "hook", transcriptSlice: [], viralityScore: 50, hookStrengthScore: 50, emotionalIntensityScore: 50,
        pacingScore: 50, durationOptimalityScore: 50, tiktokScore: 50, youtubeScore: 50, instagramScore: 50, llmProvider: "fixture", llmModel: "fixture" } });
      variants.push(await Promise.all((["ratio_9_16", "ratio_1_1", "ratio_16_9"] as const).slice(0, aspectCount).map(async aspectRatio => (await db.clipRender.create({ data: { clipId: clip.id, aspectRatio } })).id)));
    }
    await prepareFixtureSource(db, project.id);
    const workflow = new WorkflowRunLifecycle({ prisma: db }), reference = (await db.$transaction(tx => workflow.dispatchRunWithinTransaction(tx, run.id))).reference;
    const prepared = await workflow.prepareRenderRun(reference);if (prepared.kind !== "prepared") throw Error("Missing registered groups");
    const groups = await db.renderGroup.findMany({ where: { workflowRunId: run.id }, orderBy: { clipId: "asc" } });
    const refs = await Promise.all(groups.map(group => groupReference(group.id)));
    return { user, workspace, project, run, variants: variants.flat(), workflow, reference, groups, refs };
  }
  async function groupReference(id: string): Promise<ExecutionDispatchReference> {
    const group = await db.renderGroup.findUniqueOrThrow({ where: { id } });
    const row = await db.executionDispatch.findFirstOrThrow({ where: { kind: "operation_driver", subjectKind: "render_group", subjectId: id, generation: group.generation, wakeKind: null, deadlineKind: null } });
    return (await readExecutionDispatch(db, row.id))!.reference;
  }
  async function assertUnleased(runId: string) {
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ attemptId: null, attemptCount: 0, leaseOwner: null, leaseExpiresAt: null });
  }
  const completed = { sizeBytes: 1024, durationSec: 10 };

  test("four registered groups finish independently with one committed output per member and no parent owner", bindServiceTestEnvironment(async () => {
    const f = await fixture(4);
    const invocations = await Promise.all(f.refs.map(ref => acquireFixtureRenderGroup(db, ref)));
    await assertUnleased(f.run.id);
    await Promise.all(invocations.map(async invocation => { for (const id of invocation.attempt.memberIds) await invocation.complete(id, completed); }));
    const settled = await f.workflow.settleRenderRun(f.reference);
    expect(settled).toMatchObject({ kind: "settled", outcome: { status: "completed", requested: 8, succeeded: 8, failed: 0 } });
    const outputs = await db.renderGroupVariantOutcome.findMany({ where: { clipRenderId: { in: f.variants }, result: "completed" } });
    expect(outputs).toHaveLength(8);expect(new Set(outputs.map(row => row.clipRenderId)).size).toBe(8);
    expect(await db.renderGroup.findMany({ where: { workflowRunId: f.run.id }, select: { chargedAttemptCount: true } })).toEqual(Array.from({ length: 4 }, () => ({ chargedAttemptCount: 1 })));
    await assertUnleased(f.run.id);
  }), 60_000);

  test("duplicate invocations cannot replace a live native owner or charge another start", bindServiceTestEnvironment(async () => {
    const f = await fixture(), owner = await acquireFixtureRenderGroup(db, f.refs[0]!);
    const replies = await Promise.all(Array.from({ length: 20 }, () => owner.control.execute({ command: { action: "acquire", reference: owner.fence.reference, attemptToken: owner.fence.attemptToken, owner: randomUUID(), leaseSeconds: 120 }, verifiedRequest: fixtureExecutionRequest() })));
    expect(replies.every(reply => reply.disposition === "busy")).toBe(true);
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: f.groups[0]!.id } })).toMatchObject({ attemptToken: owner.fence.attemptToken, leaseOwner: owner.fence.owner, chargedAttemptCount: 1 });
    expect(await db.renderGroupExecution.count({ where: { groupId: f.groups[0]!.id } })).toBe(1);
    await assertUnleased(f.run.id);
    for (const id of owner.attempt.memberIds) await owner.complete(id, completed);
    await f.workflow.settleRenderRun(f.reference);
  }));

  test("a retry receives only unsettled outputs while completed and permanent sibling facts survive", bindServiceTestEnvironment(async () => {
    const f = await fixture(1, 3), first = await acquireFixtureRenderGroup(db, f.refs[0]!);
    const [success, transient, permanent] = first.attempt.memberIds;
    await first.complete(success!, completed);await first.fail(permanent!, "source_media_invalid", "permanent");
    const preserved = await db.clipRender.findMany({ where: { id: { in: [success!, permanent!] } }, orderBy: { id: "asc" } });
    await first.fail(transient!, "storage_unavailable", "retryable");
    expect(await f.workflow.settleRenderRun(f.reference)).toMatchObject({ kind: "settled", outcome: { status: "pending", succeeded: 1, failed: 1 } });
    await db.renderGroup.update({ where: { id: f.groups[0]!.id }, data: { nextAttemptAt: new Date(0) } });
    const next = await acquireFixtureRenderGroup(db, await groupReference(f.groups[0]!.id));
    const assignments = await db.executionArtifact.findMany({ where: { attemptToken: next.fence.attemptToken, role: "render_variant" } });
    expect(assignments).toHaveLength(1);
    await next.complete(transient!, completed);
    expect(await f.workflow.settleRenderRun(f.reference)).toMatchObject({ kind: "settled", outcome: { status: "partial", requested: 3, succeeded: 2, failed: 1 } });
    expect(await db.clipRender.findMany({ where: { id: { in: [success!, permanent!] } }, orderBy: { id: "asc" } })).toEqual(preserved);
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: f.groups[0]!.id } })).toMatchObject({ chargedAttemptCount: 2 });
  }));

  test("an exact lease watchdog fences an interrupted owner and a fresh metadata parent preserves its completed object", bindServiceTestEnvironment(async () => {
    const f = await fixture(), first = await acquireFixtureRenderGroup(db, f.refs[0]!);
    const [success, pending] = first.attempt.memberIds;await first.complete(success!, completed);
    const preserved = await db.clipRender.findUniqueOrThrow({ where: { id: success! } });
    expect((await first.expire()).kind).toBe("expired");
    await db.renderGroup.update({ where: { id: f.groups[0]!.id }, data: { nextAttemptAt: new Date(0) } });
    const freshParent = new WorkflowRunLifecycle({ prisma: db });await freshParent.prepareRenderRun(f.reference);
    const next = await acquireFixtureRenderGroup(db, await groupReference(f.groups[0]!.id));await next.complete(pending!, completed);
    expect(await freshParent.settleRenderRun(f.reference)).toMatchObject({ kind: "settled", outcome: { status: "completed", succeeded: 2 } });
    expect(await db.clipRender.findUniqueOrThrow({ where: { id: success! } })).toEqual(preserved);
    expect((await first.send({ action: "renew", fence: first.fence, leaseSeconds: 120 })).disposition).not.toBe("renewed");
    await assertUnleased(f.run.id);
  }));

  test("a native release before process start consumes no media attempt and a successor starts exactly once", bindServiceTestEnvironment(async () => {
    const f = await fixture(), unstarted = await acquireFixtureRenderGroup(db, f.refs[0]!, { start: false });
    await unstarted.send({ action: "release", fence: unstarted.fence, reason: "shutdown" });
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: f.groups[0]!.id } })).toMatchObject({ status: "queued", chargedAttemptCount: 0 });
    expect(await db.renderGroupExecution.findFirstOrThrow({ where: { groupId: f.groups[0]!.id } })).toMatchObject({ charged: false, result: "released" });
    await db.renderGroup.update({ where: { id: f.groups[0]!.id }, data: { nextAttemptAt: new Date(0) } });
    const next = await acquireFixtureRenderGroup(db, await groupReference(f.groups[0]!.id));for (const id of next.attempt.memberIds) await next.complete(id, completed);
    expect(await f.workflow.settleRenderRun(f.reference)).toMatchObject({ kind: "settled", outcome: { status: "completed", succeeded: 2 } });
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: f.groups[0]!.id } })).toMatchObject({ chargedAttemptCount: 1 });
  }));
  test("replaying parent preparation preserves frozen groups and a changed ledger tuple cannot repartition them", bindServiceTestEnvironment(async () => {
    const f = await fixture(2), before = await db.renderGroupMember.findMany({ where: { workflowRunId: f.run.id }, orderBy: { clipRenderId: "asc" } });
    expect(await f.workflow.prepareRenderRun(f.reference)).toMatchObject({ kind: "prepared" });
    expect(await f.workflow.prepareRenderRun({ ...f.reference, inputHash: "f".repeat(64) })).toEqual({ kind: "superseded", dispatchIds: [] });
    expect(await db.renderGroupMember.findMany({ where: { workflowRunId: f.run.id }, orderBy: { clipRenderId: "asc" } })).toEqual(before);
    expect(await db.renderGroup.count({ where: { workflowRunId: f.run.id } })).toBe(2);
    expect(await db.executionAttempt.count({ where: { dispatch: { subjectId: f.run.id } } })).toBe(0);
    await assertUnleased(f.run.id);
    for (const ref of f.refs) { const owner = await acquireFixtureRenderGroup(db, ref);for (const id of owner.attempt.memberIds) await owner.complete(id, completed); }
    await f.workflow.settleRenderRun(f.reference);
  }));

  test("committed caption diagnostics follow their exact output and clean siblings retain no diagnostics", bindServiceTestEnvironment(async () => {
    const f = await fixture(), owner = await acquireFixtureRenderGroup(db, f.refs[0]!), [omitted, clean] = owner.attempt.memberIds;
    const captionDiagnostics = { omittedCodePoints: ["U+2605"], skippedEmoji: [] as string[] };
    await owner.complete(omitted!, { ...completed, captionDiagnostics });await owner.complete(clean!, completed);
    await f.workflow.settleRenderRun(f.reference);
    expect((await db.clipRender.findUniqueOrThrow({ where: { id: omitted! } })).captionDiagnostics).toEqual(captionDiagnostics);
    expect((await db.clipRender.findUniqueOrThrow({ where: { id: clean! } })).captionDiagnostics).toBeNull();
  }));

  test("a lost native commit acknowledgement replays the same receipt after terminal settlement without replacing bytes", bindServiceTestEnvironment(async () => {
    const f = await fixture(1, 1), owner = await acquireFixtureRenderGroup(db, f.refs[0]!), id = owner.attempt.memberIds[0]!;
    owner.loseNextWakeAcknowledgement();await expect(owner.complete(id, completed)).rejects.toThrow("fixture_render_wake_ack_lost");
    const preserved = await db.clipRender.findUniqueOrThrow({ where: { id } });expect(preserved.status).toBe("completed");
    await f.workflow.settleRenderRun(f.reference);
    expect(await owner.complete(id, completed)).toBe(true);
    expect(await db.clipRender.findUniqueOrThrow({ where: { id } })).toEqual(preserved);
    expect(await db.renderGroupVariantOutcome.count({ where: { clipRenderId: id, result: "completed" } })).toBe(1);
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: f.groups[0]!.id } })).toMatchObject({ chargedAttemptCount: 1 });
  }));

  test("a deleted Clip revokes only its native owner before any new work-package grant", bindServiceTestEnvironment(async () => {
    const f = await fixture(2), [retired, healthy] = await Promise.all(f.refs.map(ref => acquireFixtureRenderGroup(db, ref)));
    const retiredGroup = await db.renderGroup.findUniqueOrThrow({ where: { id: retired!.attempt.groupId } });
    const before = await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: retired!.fence.attemptToken } });
    await db.clip.delete({ where: { id: retiredGroup.clipId } });
    await expect(retired!.transfer.execute({ command: { action: "work-package", fence: retired!.fence }, verifiedRequest: fixtureExecutionRequest() })).rejects.toThrow("authority_lost");
    expect(await retired!.send({ action: "renew", fence: retired!.fence, leaseSeconds: 120 })).toEqual({ disposition: "superseded" });
    expect(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: retired!.fence.attemptToken } })).toMatchObject({ status: "superseded", revokedAt: expect.any(Date), processStartedAt: before.processStartedAt });
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: retiredGroup.id } })).toMatchObject({ status: "superseded", chargedAttemptCount: 1, attemptToken: null, leaseOwner: null });
    expect(await db.clipPreparation.findUniqueOrThrow({ where: { id: retiredGroup.preparationId! } })).toMatchObject({ status: "completed", chargedAttempts: 1, clipId: retiredGroup.clipId });
    expect((await healthy!.send({ action: "renew", fence: healthy!.fence, leaseSeconds: 120 })).disposition).toBe("renewed");
    for (const id of healthy!.attempt.memberIds) await healthy!.complete(id, completed);
    expect(await f.workflow.settleRenderRun(f.reference)).toMatchObject({ kind: "settled", outcome: { status: "completed", requested: 4, succeeded: 2, superseded: 2 } });
  }));

  test("Clip deletion before process-start spends no native budget", bindServiceTestEnvironment(async () => {
    const f = await fixture(), owner = await acquireFixtureRenderGroup(db, f.refs[0]!, { start: false });
    await db.clip.delete({ where: { id: f.groups[0]!.clipId } });
    await expect(owner.transfer.execute({ command: { action: "work-package", fence: owner.fence }, verifiedRequest: fixtureExecutionRequest() })).rejects.toThrow("authority_lost");
    expect(await owner.send({ action: "process-start", fence: owner.fence })).toEqual({ disposition: "superseded" });
    expect(await db.renderGroup.findUniqueOrThrow({ where: { id: f.groups[0]!.id } })).toMatchObject({ status: "superseded", chargedAttemptCount: 0, attemptToken: null, leaseOwner: null });
    expect(await db.renderGroupExecution.findUniqueOrThrow({ where: { token: owner.fence.attemptToken } })).toMatchObject({ startedAt: null, charged: false, result: "interrupted" });
    expect(await db.executionAttempt.findUniqueOrThrow({ where: { attemptToken: owner.fence.attemptToken } })).toMatchObject({ status: "superseded", revokedAt: expect.any(Date), processStartedAt: null });
  }));

});
