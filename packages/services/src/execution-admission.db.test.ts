import { AutopilotExecution,queueAutopilotRule } from "./autopilot-execution";
import { OutboundProbeService } from "./outbound-probe";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { readExecutionAdmission, assertExecutionAdmissionOpen } from "./execution-admission";
import { ProcessingUsage } from "./processing-usage";
import { NativeValidationService } from "./native-validation";
import { readExecutionDispatch } from "./execution-dispatch";
import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { prismaUploadSessionPersistence, type UploadSessionRecord } from "./upload-session.service";
import { AutopilotService } from "./autopilot.service";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Execution admission authority", () => {
  let db: PrismaClient;
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
    assertExecutionDatabaseTestTarget(url, schema);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 5 }, { schema }), transactionOptions: { timeout: 10_000, maxWait: 10_000 } });
  });
  afterAll(async () => { await db?.$disconnect(); });
  test("closing admission rolls back a new usage reservation, while its existing reservation remains replayable", async () => {
    const user = await db.user.create({ data: { clerkId: `admission:${crypto.randomUUID()}` } });
    const workspace = await db.workspace.create({ data: { name: "Admission", ownerUserId: user.id } });
    const usage = new ProcessingUsage({ prisma: db, log: () => {} });
    const input = { projectId: crypto.randomUUID(), workspaceId: workspace.id, actorUserId: user.id, intakeKind: "link" as const, declaredSeconds: 10 };
    await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: true } });
    const first = await db.$transaction(tx => usage.reserve(tx, input));
    await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: false } });
    try {
      const next = { ...input, projectId: crypto.randomUUID() };
      await expect(db.$transaction(tx => usage.reserve(tx, next))).rejects.toMatchObject({ code: "execution_admission_closed", kind: "unavailable" });
      expect(await db.processingUsageReservation.findUnique({ where: { projectId: next.projectId } })).toBeNull();
      expect(await db.$transaction(tx => usage.reserve(tx, input))).toMatchObject({ projectId: first.projectId, reservedSeconds: first.reservedSeconds, replayed: true });
    } finally { await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: true } }); }
  });
  test("the close transaction waits for an admitted transaction and every later admission sees closed", async () => {
    await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: true } });
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const inFlight = db.$transaction(async tx => { const state = await readExecutionAdmission(tx); assertExecutionAdmissionOpen(state); enter(); await finished; });
    await entered;
    let closed = false;
    const close = db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: false } }).then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(closed).toBe(false);
    finish(); await inFlight; await close;
    try {
      await expect(db.$transaction(async tx => { assertExecutionAdmissionOpen(await readExecutionAdmission(tx)); })).rejects.toMatchObject({ code: "execution_admission_closed" });
    } finally { await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: true } }); }
  });
  test("closed admission refuses a new native job but replays and prepares a previously admitted job", async () => {
    const user = await db.user.create({ data: { clerkId: `native-admission:${crypto.randomUUID()}` } });
    const workspace = await db.workspace.create({ data: { name: "Admission", ownerUserId: user.id, personalOwnerUserId: user.id, pricingTier: "business" } });
    const scope = { actorUserId: user.id, workspaceId: workspace.id, workspaceOwnerUserId: user.id, isPersonalWorkspace: true, role: "owner" as const, status: "active" as const, pricingTier: "business" };
    const ids: string[] = [];
    const service = new NativeValidationService(db, { head: async () => ({ contentType: "font/ttf", sizeBytes: 170812, etag: '"font"' }), register: async values => { ids.push(...values); } });
    const input = { kind: "font" as const, key: `brand-fonts/${user.id}/first.ttf`, contentType: "font/ttf" as const, sizeBytes: 170812, fingerprint: "a".repeat(64), licenseConfirmed: true as const };
    const first = await service.admit(scope, input);
    await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: false } });
    try {
      await expect(service.admit(scope, { ...input, key: `brand-fonts/${user.id}/second.ttf` })).rejects.toMatchObject({ code: "execution_admission_closed" });
      expect(await db.nativeValidationJob.count({ where: { createdByUserId: user.id } })).toBe(1);
      expect(await service.admit(scope, input)).toMatchObject({ jobId: first.jobId, replayed: true });
      expect(await service.prepareExecution((await readExecutionDispatch(db, ids[0]!))!.reference)).toMatchObject({ kind: "waiting" });
    } finally { await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: true } }); }
  });
  test("a root Workflow admission remains closed even without a fresh processing reservation, while exact run replay succeeds", async () => {
    const user = await db.user.create({ data: { clerkId: `workflow-admission:${crypto.randomUUID()}` } });
    const workspace = await db.workspace.create({ data: { name: "Admission", ownerUserId: user.id } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, title: "Admission", sourceMediaUrl: "r2://fixture" } });
    const workflow = new WorkflowRunLifecycle({ prisma: db });
    const input = { projectId: project.id, idempotencyKey: crypto.randomUUID(), stage: "export_bundle" as const };
    await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: false } });
    try {
      await expect(workflow.admit(input)).rejects.toMatchObject({ code: "execution_admission_closed" });
      expect(await db.workflowRun.count({ where: { projectId: project.id } })).toBe(0);
      await expect(workflow.admitClipRendering({ projectId: project.id, idempotencyKey: crypto.randomUUID(), variants: [{ clipId: crypto.randomUUID(), aspectRatio: "ratio_9_16", resolution: "1080p" }] })).rejects.toMatchObject({ code: "execution_admission_closed" });
      expect(await db.clipRender.count({ where: { clip: { projectId: project.id } } })).toBe(0);
      const existing = await db.workflowRun.create({ data: { ...input, status: "completed" } });
      expect(await workflow.admit(input)).toEqual({ id: existing.id, created: false });
    } finally { await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: true } }); }
  });
  test("upload reservation enforces closure without an optional quota request and replays an existing session", async () => {
    const user = await db.user.create({ data: { clerkId: `upload-admission:${crypto.randomUUID()}` } });
    const workspace = await db.workspace.create({ data: { name: "Admission", ownerUserId: user.id } });
    const clock = new Date();
    const record: UploadSessionRecord = { id: crypto.randomUUID(), workspaceId: workspace.id, actorUserId: user.id, clientIdempotencyKey: crypto.randomUUID(), immutableInputFingerprint: "a".repeat(64),
      preallocatedProjectId: crypto.randomUUID(), title: "Admission", fileName: "fixture.mp4", fileSizeBytes: 1000, contentType: "video/mp4", browserFingerprint: "fixture",
      brandTemplateId: null, brandSnapshot: null, brandProfileId: null, brandProfileSnapshot: null, generation: {}, transferKind: "single", partSizeBytes: null, partCount: 1,
      storageKey: `projects/${crypto.randomUUID()}/source.mp4`, providerUploadId: null, admissionAttemptId: null, admissionClaimExpiresAt: null, admissionPreparedAt: null,
      completionParts: null, completionIntentMalformed: false, queuedJobId: null, failureCode: null, cleanupRetryAt: null, reconcileAt: null, reconciliationAttemptId: null,
      reconciliationLeaseExpiresAt: null, reconciliationAttemptCount: 0, status: "initiating", expiresAt: new Date(clock.getTime() + 60000), hardExpiresAt: new Date(clock.getTime() + 120000), createdAt: clock, updatedAt: clock };
    const scope = createDatabaseTestContext(); scope.client = db;
    const reserve = scope.bind((value: UploadSessionRecord) => prismaUploadSessionPersistence.reserve(value));
    const first = await reserve(record);
    await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: false } });
    try {
      await expect(reserve({ ...record, id: crypto.randomUUID(), clientIdempotencyKey: crypto.randomUUID(), preallocatedProjectId: crypto.randomUUID(), storageKey: `projects/${crypto.randomUUID()}/source.mp4` })).rejects.toMatchObject({ code: "execution_admission_closed" });
      expect(await db.uploadSession.count({ where: { workspaceId: workspace.id } })).toBe(1);
      expect(await reserve({ ...record, id: crypto.randomUUID() })).toMatchObject({ created: false, session: { id: first.session.id } });
    } finally { await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: true } }); }
  });
  test("Autopilot cannot admit or claim another occurrence while closed, and pausing remains allowed", async () => {
    const user = await db.user.create({ data: { clerkId: `autopilot-admission:${crypto.randomUUID()}` } });
    const workspace = await db.workspace.create({ data: { name: "Admission", ownerUserId: user.id, personalOwnerUserId: user.id, pricingTier: "business" } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "owner" } });
    const recipe = await db.recipe.create({ data: { workspaceId: workspace.id, name: "Admission", createdByUserId: user.id, contentPack: {} } });
    const rule = await db.autopilotRule.create({ data: { workspaceId: workspace.id, createdByUserId: user.id, name: "Admission", recipeId: recipe.id, rssUrl: "https://feeds.example.test/show.xml", nextRunAt: new Date(0) } });
    let fetches = 0;
    const service = new AutopilotService({ fetchFeed: async () => { fetches++; throw new Error("No admission"); } });
    const context = createDatabaseTestContext(); context.client = db;
    const scope = { actorUserId: user.id, workspaceId: workspace.id };
    await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: false } });
    try {
      await context.bind(async () => {
        await expect(service.triggerRuleNow(scope, rule.id)).rejects.toMatchObject({ code: "execution_admission_closed" });
        await expect(service.takeOver(scope, rule.id)).rejects.toMatchObject({ code: "execution_admission_closed" });
        const probe=new OutboundProbeService(db,{register:async()=>{},readResult:async()=>{throw Error("Closed cycle cannot read source");}});
        const driver=new AutopilotExecution({database:db,probe,register:async()=>{},importEpisode:async()=>{throw Error("Closed cycle cannot admit intake");}});
        const reference=(await db.$transaction(tx=>queueAutopilotRule(tx,rule.id)))!;
        await expect(driver.run(reference)).rejects.toMatchObject({code:"execution_admission_closed"});
        expect(fetches).toBe(0);
        expect((await service.updateRule(scope, rule.id, { status: "paused" })).status).toBe("paused");
        expect((await db.autopilotRule.findUniqueOrThrow({ where: { id: rule.id } })).claimToken).toBeNull();
      })();
    } finally { await db.executionEpoch.update({ where: { id: 1 }, data: { admissionOpen: true } }); }
  });
});
