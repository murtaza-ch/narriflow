import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { projectService } from "./project.service";
import { getIngestJobLifecycle } from "./ingest-job-lifecycle-runtime";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { withExecutionDispatches } from "./execution-dispatch-runtime";
import { readServiceEnvironment, withServiceEnvironment } from "./runtime-environment";
import { withLocalFetchPresence } from "./source-fetch-capability";
import { ingestExecutionInputHash } from "./ingest-source-execution";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Ingest initial scheduler handoff", () => {
  let db: PrismaClient;
  const users: string[] = [];
  const context = createDatabaseTestContext();
  const scoped = <T>(run: () => Promise<T>) => context.bind(() => withServiceEnvironment({
    ...process.env, APP_ENV: "development", YOUTUBE_FETCH_MODE: "local",
    MEDIA_LOCAL_FETCH_TOOLCHAIN_FINGERPRINT: "f".repeat(64),
    LOCAL_FETCH_WORKSPACE_IDS_JSON: JSON.stringify(workspaces),
  }, () => withLocalFetchPresence(async () => ({ available: true }), run)))();
  const workspaces: string[] = [];
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
    assertExecutionDatabaseTestTarget(url, schema);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 5 }, { schema }), transactionOptions: { timeout: 30_000, maxWait: 10_000 } });
    context.client = db;
  });
  afterEach(async () => {
    const projects = await db.project.findMany({ where: { workspaceId: { in: workspaces } }, select: { id: true } });
    const ids = projects.map(project => project.id);
    const jobs = await db.ingestJob.findMany({ where: { projectId: { in: ids } }, select: { id: true } });
    const events = await db.workflowEvent.findMany({ where: { projectId: { in: ids } }, select: { id: true } });
    await db.executionDispatch.deleteMany({ where: { subjectId: { in: [...ids, ...jobs.map(job => job.id), ...events.map(event => event.id)] } } });
    await db.processingUsageReservation.deleteMany({ where: { projectId: { in: ids } } });
    await db.workspace.deleteMany({ where: { id: { in: workspaces.splice(0) } } });
    await db.user.deleteMany({ where: { id: { in: users.splice(0) } } });
  });
  afterAll(async () => { await db?.$disconnect(); });
  async function fixture() {
    const user = await db.user.create({ data: { clerkId: `ingest-handoff:${crypto.randomUUID()}` } });
    users.push(user.id);
    const workspace = await db.workspace.create({ data: { name: "Ingest handoff", ownerUserId: user.id, personalOwnerUserId: user.id, pricingTier: "business", members: { create: { userId: user.id, role: "owner" } } } });
    workspaces.push(workspace.id);
    const scope = { actorUserId: user.id, workspaceId: workspace.id };
    const input = { title: "Atomic local fetch", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", commitToken: crypto.randomUUID() };
    return { user, workspace, scope, input, accept: () => withServiceEnvironment({
      ...readServiceEnvironment(), LOCAL_FETCH_WORKSPACE_IDS_JSON: JSON.stringify([workspace.id]),
    }, () => projectService.queueLinkIngest(scope, input)) };
  }
  test("actual local-link acceptance commits and collects its initial import dispatch", () => scoped(async () => {
    const f = await fixture(), delivered: string[] = [];
    const accepted = await withExecutionDispatches(f.accept, { database: db, deliver: async ids => { delivered.push(...ids); } });
    const job = await db.ingestJob.findUniqueOrThrow({ where: { id: accepted.queuedJobId! } });
    const dispatches = await db.executionDispatch.findMany({ where: { kind: "import_pipeline", subjectKind: "ingest_job", subjectId: job.id, wakeKind: null, deadlineKind: null } });
    expect(dispatches).toHaveLength(1);
    expect(delivered.filter(id => id === dispatches[0]!.id)).toHaveLength(1);
    expect(dispatches[0]!.inputHash).toBe(await ingestExecutionInputHash(job, "f".repeat(64)));
    expect(job).toMatchObject({ generation: 1, attemptCount: 0, operationDeadlineAt: null, status: "queued" });
    expect(await db.executionAttempt.count({ where: { dispatch: { subjectId: job.id } } })).toBe(0);
  }));
  test("native commit-token replay recollects the existing job without new admission or domain changes", () => scoped(async () => {
    const f = await fixture(), accepted = await f.accept();
    const job = await db.ingestJob.findUniqueOrThrow({ where: { id: accepted.queuedJobId! } });
    const reference = await db.$transaction(tx => getIngestJobLifecycle().queueExecutionWithinTransaction(tx, job.id));
    const reservation = await db.processingUsageReservation.findUniqueOrThrow({ where: { projectId: accepted.project.id } });
    const project = await db.project.findUniqueOrThrow({ where: { id: accepted.project.id } });
    const events = await db.workflowEvent.count({ where: { projectId: project.id } });
    let deliveries = 0;
    const replay = await withExecutionDispatches(f.accept, { database: db, deliver: async ids => { expect(ids).toContain(reference!.dispatchId); deliveries++; } });
    expect(deliveries).toBe(1);
    expect(replay).toEqual(accepted);
    expect(await db.ingestJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(job);
    expect(await db.project.findUniqueOrThrow({ where: { id: project.id } })).toEqual(project);
    expect(await db.processingUsageReservation.findUniqueOrThrow({ where: { projectId: project.id } })).toEqual(reservation);
    expect(await db.ingestJob.count({ where: { projectId: project.id } })).toBe(1);
    expect(await db.workflowEvent.count({ where: { projectId: project.id } })).toBe(events);
  }));
  test("lost registration replay retains the same integration receipt, job and reservation", () => scoped(async () => {
    const f = await fixture();
    const mutation = { clientIdempotencyKey: crypto.randomUUID() };
    const accept = () => projectService.queueLinkIngest(f.scope, { title: "Receipt intake", url: "https://www.dropbox.com/s/fixture/video.mp4" }, { mutation });
    let calls = 0;
    const deliver = async (ids: readonly string[]) => {
      const job = await db.ingestJob.findFirstOrThrow({ where: { project: { workspaceId: f.workspace.id } } });
      const dispatch = await db.executionDispatch.findFirstOrThrow({ where: { subjectId: job.id, kind: "import_pipeline", wakeKind: null } });
      expect(ids).toContain(dispatch.id);
      calls++;
      if (calls === 1) throw Error("lost_registration_acknowledgement");
    };
    await expect(withExecutionDispatches(accept, { database: db, deliver })).rejects.toThrow("lost_registration_acknowledgement");
    const receipt = await db.operationReceipt.findFirstOrThrow({ where: { clientIdempotencyKey: mutation.clientIdempotencyKey } });
    const job = await db.ingestJob.findUniqueOrThrow({ where: { id: receipt.resourceId } });
    const reservation = await db.processingUsageReservation.findUniqueOrThrow({ where: { projectId: job.projectId } });
    const replay = await withExecutionDispatches(accept, { database: db, deliver });
    expect(replay).toMatchObject({ replayed: true, receiptId: receipt.id, queuedJobId: job.id });
    expect(calls).toBe(2);
    expect(await db.operationReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(receipt);
    expect(await db.ingestJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(job);
    expect(await db.processingUsageReservation.findUniqueOrThrow({ where: { projectId: job.projectId } })).toEqual(reservation);
  }));
  test("missing job and tampered initial identity cannot be accepted as scheduled replays", () => scoped(async () => {
    const f = await fixture(), accepted = await f.accept();
    const dispatch = await db.executionDispatch.findFirstOrThrow({ where: { subjectId: accepted.queuedJobId!, kind: "import_pipeline" } });
    await db.executionDispatch.update({ where: { id: dispatch.id }, data: { inputHash: "0".repeat(64) } });
    let delivered = 0;
    await expect(withExecutionDispatches(f.accept, { database: db, deliver: async () => { delivered++; } })).rejects.toThrow("ingest_initial_dispatch_invalid");
    expect(delivered).toBe(0);
    await db.executionDispatch.delete({ where: { id: dispatch.id } });
    await db.ingestJob.delete({ where: { id: accepted.queuedJobId! } });
    await expect(f.accept()).rejects.toMatchObject({ code: "ingest_job_missing" });
    expect(await db.ingestJob.count({ where: { projectId: accepted.project.id } })).toBe(0);
  }));
  test.each(["completed", "stale-source", "other-epoch"] as const)("replay cannot dispatch a %s source", condition => scoped(async () => {
    const f = await fixture(), accepted = await f.accept();
    const job = await db.ingestJob.findUniqueOrThrow({ where: { id: accepted.queuedJobId! } });
    if (condition === "completed") await db.ingestJob.update({ where: { id: job.id }, data: { status: "completed" } });
    if (condition === "stale-source") await db.project.update({ where: { id: job.projectId }, data: { sourceRevision: { increment: 1 } } });
    if (condition === "other-epoch") await db.ingestJob.update({ where: { id: job.id }, data: { deploymentEpoch: job.deploymentEpoch + 1 } });
    let delivered = 0;
    await withExecutionDispatches(f.accept, { database: db, deliver: async () => { delivered++; } });
    expect(delivered).toBe(0);
    expect(await db.ingestJob.count({ where: { projectId: job.projectId } })).toBe(1);
  }));
  test("a commit token from another Workspace cannot expose or collect its job", () => scoped(async () => {
    const f = await fixture(), accepted = await f.accept(), other = await fixture();
    let delivered = 0;
    await expect(withExecutionDispatches(() => projectService.queueLinkIngest(other.scope, f.input), { database: db, deliver: async () => { delivered++; } })).rejects.toMatchObject({ code: "project_not_found" });
    expect(delivered).toBe(0);
    expect(await db.ingestJob.count({ where: { projectId: accepted.project.id } })).toBe(1);
  }));
  test("initial job, progress and dispatch all roll back before any delivery", () => scoped(async () => {
    const f = await fixture();
    const project = await db.project.create({ data: { workspaceId: f.workspace.id, title: "Rollback source", sourceMediaUrl: "https://example.invalid/source" } });
    let delivered = 0;
    await expect(withExecutionDispatches(() => db.$transaction(async tx => {
      await getIngestJobLifecycle().enqueue(tx, { projectId: project.id, jobType: "link_import", payload: { url: project.sourceMediaUrl }, acquisition: { audioPolicy: "pending_pack" } });
      throw Error("rollback_intake");
    }), { database: db, deliver: async () => { delivered++; } })).rejects.toThrow("rollback_intake");
    expect(delivered).toBe(0);
    expect(await db.ingestJob.count({ where: { projectId: project.id } })).toBe(0);
    expect(await db.workflowEvent.count({ where: { projectId: project.id } })).toBe(0);
  }));
  test.each(["link_import", "drive_import", "rss_import", "zoom_import", "upload_finalize"] as const)("shared %s admission collects exactly one committed initial obligation", jobType => scoped(async () => {
    const f = await fixture();
    const project = await db.project.create({ data: { workspaceId: f.workspace.id, title: "Shared intake", sourceMediaUrl: "https://example.invalid/source" } });
    const delivered: string[] = [];
    const job = await withExecutionDispatches(() => db.$transaction(tx => getIngestJobLifecycle().enqueue(tx, {
      projectId: project.id, jobType, payload: { source: "fixture" }, acquisition: { audioPolicy: "pending_pack" },
    })), { database: db, deliver: async ids => { delivered.push(...ids); } });
    const dispatch = await db.executionDispatch.findUniqueOrThrow({ where: { id: job.dispatchId } });
    expect(dispatch).toMatchObject({ kind: "import_pipeline", subjectKind: "ingest_job", subjectId: job.id, generation: 1, wakeKind: null, deadlineKind: null });
    expect(delivered.filter(id => id === dispatch.id)).toHaveLength(1);
    expect(await db.executionDispatch.count({ where: { kind: "import_pipeline", subjectId: job.id } })).toBe(1);
  }));
});
