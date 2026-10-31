import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { createDatabaseScope, withDatabaseScope } from "@narriflow/db/client";
import { appendWorkflowEvent } from "./workflow-event-append";
import { appendProgressRevocation, deliverProgressAfterCommit, deliverProgressDispatch } from "./progress-outbox";
import { createExecutionDispatch } from "./execution-dispatch";
import { withProgressDelivery } from "./progress-delivery";
import { withServiceEnvironment } from "./runtime-environment";
import { readProgressReplay } from "./progress-feed";
import { WorkspaceMembershipService } from "./workspace-membership.service";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Durable progress delivery and revocation", () => {
  let database: PrismaClient;
  let ownerId: string;
  let workspaceId: string;
  let projectId: string;
  let extraUsers: string[] = [];
  beforeAll(async () => {
    assertExecutionDatabaseTestTarget(url, process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public");
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
    if (schema !== "public" && !/^serverless_execution_test_[a-z0-9]+$/.test(schema)) throw new Error("Unsafe progress gate schema");
    database = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }), transactionOptions: { timeout: 20_000 } });
  });
  beforeEach(async () => {
    const owner = await database.user.create({ data: { clerkId: `progress-gate:${crypto.randomUUID()}` } }); ownerId = owner.id;
    const workspace = await database.workspace.create({ data: { name: "Progress gate", ownerUserId: ownerId, pricingTier: "business", members: { create: { userId: ownerId, role: "owner" } } } }); workspaceId = workspace.id;
    const project = await database.project.create({ data: { workspaceId, title: "Progress gate", sourceMediaUrl: "r2://gate/source", createdByUserId: ownerId } }); projectId = project.id;
  });
  afterEach(async () => {
    const events = await database.workflowEvent.findMany({ where: { project: { workspaceId } }, select: { id: true } });
    const prefix = `pr1.${Buffer.from(workspaceId.replaceAll("-", ""), "hex").toString("base64url")}.`;
    await database.executionDispatch.deleteMany({ where: { kind: "project_progress", OR: [{ subjectId: { in: events.map((row) => row.id) } }, { subjectId: { startsWith: prefix } }] } });
    await database.workspace.delete({ where: { id: workspaceId } });
    await database.user.deleteMany({ where: { id: { in: [ownerId, ...extraUsers] } } }); extraUsers = [];
  });
  afterAll(async () => { await database?.$disconnect(); });
  const scoped = <T>(operation: () => Promise<T>) => withServiceEnvironment({}, () => withDatabaseScope(createDatabaseScope({ createClient: () => ({ client: database, dispose: async () => {} }) }), operation));
  async function event() {
    const key = crypto.randomUUID();
    await database.$transaction((tx) => appendWorkflowEvent(tx, { projectId, workflowRunId: crypto.randomUUID(), attemptId: key, stage: "stt", status: "running", progress: 10, errorCode: null, transition: "gate" }, { progressRequired: true, analyticsEnabled: false }));
    const row = await database.workflowEvent.findFirstOrThrow({ where: { projectId }, orderBy: { seq: "desc" } });
    return { row, dispatch: await database.executionDispatch.findFirstOrThrow({ where: { kind: "project_progress", subjectId: row.id } }) };
  }
  const scheduler = () => createExecutionDispatch({ database, scheduler: { deliver: ({ reference }) => deliverProgressDispatch(database, reference) }, options: { retryBaseMs: 1, retryMaxMs: 1 } });

  test("event and destination obligation commit together; rollback leaves neither", async () => {
    const initial = await event(); expect(initial.dispatch.acknowledgedAt).toBeNull();
    await expect(database.$transaction(async (tx) => { await appendWorkflowEvent(tx, { projectId, workflowRunId: crypto.randomUUID(), attemptId: crypto.randomUUID(), stage: "stt", status: "running", progress: 50, errorCode: null, transition: "rollback" }, { progressRequired: true, analyticsEnabled: false }); throw new Error("rollback gate"); })).rejects.toThrow("rollback gate");
    const replay = await readProgressReplay(database, { projectId, workspaceId }, 0); expect(replay?.events.map((row) => row.seq)).toEqual([1]); expect(replay?.reset).toBe(false);
    expect(await database.executionDispatch.count({ where: { kind: "project_progress", subjectKind: "workflow_event", subjectId: initial.row.id } })).toBe(1);
  }, 60_000);

  test("a lost DO acknowledgement keeps the same durable obligation retryable", async () => {
    const { row, dispatch } = await event(); let sends = 0; let loseAck = true;
    await withProgressDelivery({ registerContinuations: async () => {}, publish: async (_scope, payload) => { sends += 1; expect(payload).not.toHaveProperty("generationRenders"); if (loseAck) throw new Error("lost response"); }, revoke: async () => {} }, async () => {
      expect((await scheduler().deliver(dispatch.id)).status).toBe("pending"); expect((await database.workflowEvent.findUniqueOrThrow({ where: { id: row.id } })).progressPublishedAt).toBeNull();
      loseAck = false; await database.executionDispatch.update({ where: { id: dispatch.id }, data: { nextDeliveryAt: new Date(0) } });
      expect((await scheduler().deliver(dispatch.id)).status).toBe("acknowledged"); expect((await database.workflowEvent.findUniqueOrThrow({ where: { id: row.id } })).progressPublishedAt).not.toBeNull();
    }); expect(sends).toBe(2);
  }, 60_000);

  test("an uncertain postcommit push registers a bounded retry instead of waiting for the hourly scan", async () => {
    const { dispatch } = await event(); const registered: string[] = [];
    const record = await scheduler().read(dispatch.id);
    await withProgressDelivery({ publish: async () => { throw new Error("lost response"); }, revoke: async () => {}, registerContinuations: async (ids) => { registered.push(...ids); } }, () => deliverProgressAfterCommit(database, [record!]));
    expect(registered).toEqual([dispatch.id]); expect((await scheduler().read(dispatch.id))?.acknowledgedAt).toBeNull();
  }, 60_000);

  test("membership removal durably records a cutoff and pushes only after commit", async () => {
    const viewer = await database.user.create({ data: { clerkId: `progress-gate:${crypto.randomUUID()}` } }); extraUsers.push(viewer.id);
    const member = await database.workspaceMember.create({ data: { workspaceId, userId: viewer.id, role: "viewer" } });
    const revoked: Array<{ projectId: string; actorUserId?: string; authorizedBefore: number }> = [];
    await withProgressDelivery({ registerContinuations: async () => {}, publish: async () => {}, revoke: async (input) => { expect(await database.workspaceMember.findUnique({ where: { id: member.id } })).toBeNull(); revoked.push(input); } }, () => scoped(() => new WorkspaceMembershipService().removeMember(ownerId, workspaceId, member.id)));
    expect(revoked).toHaveLength(1); expect(revoked[0]).toMatchObject({ projectId, actorUserId: viewer.id }); expect(revoked[0]!.authorizedBefore).toBeGreaterThan(Date.now() - 30_000);
  }, 60_000);

  test("a rollback cannot retain a revocation, and a deleted Project can still receive its committed revocation", async () => {
    let rolledBackId = "";
    await expect(database.$transaction(async (tx) => { rolledBackId = (await appendProgressRevocation(tx, { workspaceId, projectId, error: "project_inaccessible" })).reference.dispatchId; throw new Error("rollback gate"); })).rejects.toThrow("rollback gate");
    expect(await database.executionDispatch.findUnique({ where: { id: rolledBackId } })).toBeNull();
    const record = await database.$transaction(async (tx) => { await tx.project.delete({ where: { id: projectId } }); return appendProgressRevocation(tx, { workspaceId, projectId, error: "project_inaccessible" }); });
    const revoked: string[] = [];
    await withProgressDelivery({ registerContinuations: async () => {}, publish: async () => {}, revoke: async (input) => { revoked.push(input.projectId); } }, async () => expect((await scheduler().deliver(record.reference.dispatchId)).status).toBe("acknowledged"));
    expect(revoked).toEqual([projectId]);
  }, 60_000);

  test("workspace revocation fans out in bounded pages with a durable continuation", async () => {
    await database.project.createMany({ data: Array.from({ length: 100 }, (_, index) => ({ workspaceId, title: `Progress gate${index}`, sourceMediaUrl: "r2://gate/source" })) });
    const record = await database.$transaction((tx) => appendProgressRevocation(tx, { workspaceId, error: "workspace_restricted" }));
    const revoked = new Set<string>(); let continuations: string[] = [];
    await withProgressDelivery({ registerContinuations: async () => {}, publish: async () => {}, revoke: async (input) => { revoked.add(input.projectId); } }, async () => {
      const outcome = await deliverProgressDispatch(database, record.reference); continuations = outcome.continuationDispatchIds; expect(revoked.size).toBe(100); expect(continuations).toHaveLength(1);
      expect((await scheduler().deliver(continuations[0]!)).status).toBe("acknowledged");
    }); expect(revoked.size).toBe(101);
  }, 60_000);

  test("retention gaps reset to a snapshot cursor instead of silently skipping missing events", async () => {
    await event(); await event(); const first = await database.workflowEvent.findFirstOrThrow({ where: { projectId, seq: 1 } });
    await database.workflowEvent.delete({ where: { id: first.id } });
    expect(await readProgressReplay(database, { projectId, workspaceId }, 0)).toEqual({ highWater: 2, events: [], reset: true });
    // Remove the now-orphaned event obligation as part of this fixture.
    await database.executionDispatch.deleteMany({ where: { kind: "project_progress", subjectId: first.id } });
  }, 60_000);
});
