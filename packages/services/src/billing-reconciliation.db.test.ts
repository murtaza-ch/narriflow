import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { createBillingReconciliation, queueBillingReconciliation, recoverBillingReconciliation } from "./billing-reconciliation";
import { readExecutionDispatch } from "./execution-dispatch";
import { withExecutionDispatches, takeExecutionDispatchIds } from "./execution-dispatch-runtime";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { createBillingCatalog, createPrismaWorkspaceBillingStore, createWorkspaceBillingModule } from "./workspace-billing.service";

const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite = process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url ? describe : describe.skip;
suite("Targeted billing reconciliation", () => {
  let db: PrismaClient;
  const users: string[] = [], workspaces: string[] = [];
  beforeAll(() => {
    const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
    assertExecutionDatabaseTestTarget(url, schema);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 5 }, { schema }), transactionOptions: { timeout: 30_000, maxWait: 10_000 } });
  });
  afterEach(async () => {
    await db.executionDispatch.deleteMany({ where: { subjectKind: "workspace_billing", subjectId: { in: workspaces } } });
    await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    users.length = workspaces.length = 0;
  });
  afterAll(async () => { await db.$disconnect(); });
  async function fixture(dueAt = new Date(0)) {
    const user = await db.user.create({ data: { clerkId: `billing-dispatch:${crypto.randomUUID()}` } }); users.push(user.id);
    const workspace = await db.workspace.create({ data: { name: "Billing dispatch gate", ownerUserId: user.id,
      billingAccount: { create: { nextReconcileAt: dueAt } } } }); workspaces.push(workspace.id);
    return workspace;
  }
  test("billing changes and their next wake commit or roll back together", async () => {
    const workspace = await fixture();
    const delivered: string[][] = [];
    const options = { database: db, deliver: async (ids: readonly string[]) => { delivered.push([...ids]); } };
    const reference = await withExecutionDispatches(() => db.$transaction(tx => queueBillingReconciliation(tx, workspace.id)), options);
    expect(delivered).toEqual([[reference.dispatchId]]);
    expect(await readExecutionDispatch(db, reference.dispatchId)).toMatchObject({ reference, dueAt: new Date(0) });
    const before = await db.workspaceBillingAccount.findUniqueOrThrow({ where: { workspaceId: workspace.id } });
    await expect(withExecutionDispatches(() => db.$transaction(async tx => {
      await tx.workspaceBillingAccount.update({ where: { workspaceId: workspace.id }, data: { nextReconcileAt: new Date(1000) } });
      await queueBillingReconciliation(tx, workspace.id);
      throw new Error("injected_billing_rollback");
    }), options)).rejects.toThrow("injected_billing_rollback");
    expect(await db.workspaceBillingAccount.findUniqueOrThrow({ where: { workspaceId: workspace.id } })).toMatchObject({ reconciliationGeneration: before.reconciliationGeneration, nextReconcileAt: before.nextReconcileAt });
    expect(await db.executionDispatch.count({ where: { subjectId: workspace.id } })).toBe(1);
    expect(delivered).toHaveLength(1);
  });
  test("a lost next-due registration is repaired by replay without another provider reconciliation", async () => {
    const workspace = await fixture();
    const reference = await db.$transaction(tx => queueBillingReconciliation(tx,workspace.id));
    const registrations: string[][] = []; let calls = 0;
    const driver = createBillingReconciliation({ database: db, leaseMs: 60_000,
      register: async ids => { registrations.push([...ids]); if (registrations.length === 2) throw Error("lost_billing_next_ack"); },
      reconcile: async () => {
        calls++;
        await db.$transaction(async tx => {
          await tx.workspaceBillingAccount.update({ where: { workspaceId: workspace.id }, data: { nextReconcileAt: new Date(Date.now()+86_400_000) } });
          await queueBillingReconciliation(tx,workspace.id);
        });
      },
    });
    await expect(driver.run(reference)).rejects.toThrow("lost_billing_next_ack");
    const current = await db.executionDispatch.findFirstOrThrow({ where: { subjectKind: "workspace_billing", subjectId: workspace.id, wakeKind: null, deadlineKind: null }, orderBy: { generation: "desc" } });
    expect((await driver.run(reference)).kind).toBe("superseded");
    expect(calls).toBe(1); expect(registrations).toHaveLength(3); expect(registrations.at(-1)).toEqual([current.id]);
  });
  test("one exact due account owns provider work and registers expiry before calling it", async () => {
    const workspace = await fixture(new Date(Date.now() + 60_000));
    let reference = await db.$transaction(tx => queueBillingReconciliation(tx, workspace.id));
    let providerCalls = 0, registrations = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const driver = createBillingReconciliation({ database: db, leaseMs: 60_000,
      register: async ids => { expect(ids.length).toBeGreaterThan(0); registrations++; },
      reconcile: async claim => {
        expect(registrations).toBeGreaterThan(0); providerCalls++; started(); await barrier;
        await db.$transaction(async tx => {
          const row = await tx.workspaceBillingAccount.updateMany({ where: { workspaceId: claim.workspaceId, reconcileAttemptId: claim.attemptId },
            data: { reconcileAttemptId: null, leaseExpiresAt: null, nextReconcileAt: new Date(Date.now() + 86_400_000) } });
          expect(row.count).toBe(1);
          await queueBillingReconciliation(tx, claim.workspaceId);
        });
      },
    });
    expect((await driver.run(reference)).kind).toBe("sleep");
    expect(providerCalls).toBe(0);
    expect((await driver.run({ ...reference, generation: reference.generation + 1 })).kind).toBe("superseded");
    reference = await db.$transaction(async tx => {
      await tx.workspaceBillingAccount.update({ where: { workspaceId: workspace.id }, data: { nextReconcileAt: new Date(0) } });
      return queueBillingReconciliation(tx, workspace.id);
    });
    const first = driver.run(reference);
    await entered;
    expect((await driver.run(reference)).kind).toBe("wait");
    expect(providerCalls).toBe(1);
    release();
    expect((await first).kind).toBe("complete");
    expect((await driver.run(reference)).kind).toBe("superseded");
    expect(providerCalls).toBe(1);
    expect(await db.workspaceBillingAccount.findUniqueOrThrow({ where: { workspaceId: workspace.id } })).toMatchObject({ reconcileAttemptId: null, leaseExpiresAt: null, attemptCount: 1 });
  });
  test("registration failure releases an unstarted account before the same dispatch retries", async () => {
    const workspace = await fixture();
    const reference = await db.$transaction(tx => queueBillingReconciliation(tx, workspace.id));
    let refuse = true, calls = 0;
    const driver = createBillingReconciliation({ database: db, leaseMs: 60_000,
      register: async () => { if (refuse) throw new Error("scheduler_unconfirmed"); },
      reconcile: async claim => { calls++; await db.$transaction(async tx => {
        await tx.workspaceBillingAccount.update({ where: { workspaceId: claim.workspaceId }, data: { nextReconcileAt: new Date(Date.now() + 60_000) } });
        await queueBillingReconciliation(tx, claim.workspaceId);
      }); },
    });
    await expect(driver.run(reference)).rejects.toThrow("scheduler_unconfirmed");
    expect(calls).toBe(0);
    expect(await db.workspaceBillingAccount.findUniqueOrThrow({ where: { workspaceId: workspace.id } })).toMatchObject({ reconcileAttemptId: null, leaseExpiresAt: null, attemptCount: 0 });
    refuse = false;
    expect((await driver.run(reference)).kind).toBe("complete");
    expect(calls).toBe(1);
  });
  test("the real billing store verifies provider state and commits its next reconciliation wake", async () => {
    const workspace = await fixture();
    await db.workspaceBillingAccount.update({ where: { workspaceId: workspace.id }, data: { providerCustomerId: `cus_${workspace.id}` } });
    const reference = await db.$transaction(tx => queueBillingReconciliation(tx, workspace.id));
    const context = createDatabaseTestContext(); context.client = db;
    let calls = 0;
    let targetWorkspaceId = workspace.id, fenceOnReply = false;
    const catalog = createBillingCatalog({
      basePrices: (["creator", "pro", "business"] as const).flatMap(tier => (["monthly", "annual"] as const).map(interval => ({ priceId: `price_${tier}_${interval}`, tier, interval }))),
      seatPrices: [{ priceId: "price_seat_monthly", interval: "monthly" }, { priceId: "price_seat_annual", interval: "annual" }],
      worker: { leaseMs: 60_000, providerDeadlineMs: 10_000, providerCallBudget: 4 },
    });
    const run = context.bind(async () => {
      const module = createWorkspaceBillingModule({ catalog, store: createPrismaWorkspaceBillingStore(), clock: { now: () => new Date() }, diagnostics: { record() {} },
        provider: { verifyDelivery() { throw new Error("unused"); }, retrieveCurrentState: async customerId => {
          calls++;
          if (fenceOnReply) await db.executionEpoch.update({ where: { id: 1 }, data: { epoch: { increment: 1 } } });
          return { customerId, ownership: { kind: "verified", workspaceId: targetWorkspaceId }, subscriptions: [] };
        } } });
      return createBillingReconciliation({ database: db, leaseMs: 60_000, register: async () => {}, reconcile: claim => module.reconcileClaim(claim) });
    });
    const driver = await run();
    const invoke = context.bind(() => driver.run(reference));
    expect((await invoke()).kind).toBe("complete");
    expect(calls).toBe(1);
    const account = await db.workspaceBillingAccount.findUniqueOrThrow({ where: { workspaceId: workspace.id } });
    expect(account).toMatchObject({ reconciliationGeneration: 2, health: "current", reconcileAttemptId: null, leaseExpiresAt: null });
    expect(account.nextReconcileAt.getTime()).toBeGreaterThan(Date.now());
    expect(await db.executionDispatch.findFirst({ where: { subjectId: workspace.id, generation: 2 } })).not.toBeNull();

    const stale = await fixture();
    await db.workspace.update({ where: { id: stale.id }, data: { pricingTier: "creator" } });
    await db.workspaceBillingAccount.update({ where: { workspaceId: stale.id }, data: { providerCustomerId: `cus_${stale.id}` } });
    const staleReference = await db.$transaction(tx => queueBillingReconciliation(tx, stale.id));
    targetWorkspaceId = stale.id; fenceOnReply = true;
    await context.bind(() => driver.run(staleReference))();
    expect((await db.workspace.findUniqueOrThrow({ where: { id: stale.id } })).pricingTier).toBe("creator");
    expect((await db.workspaceBillingAccount.findUniqueOrThrow({ where: { workspaceId: stale.id } })).reconciliationGeneration).toBe(1);
    expect((await driver.run(staleReference)).kind).toBe("superseded");
  });

  test("interactive and plan-change claims confirm a watchdog before returning provider authority", async () => {
    const workspace = await fixture();
    const context = createDatabaseTestContext(); context.client = db;
    let rejectRegistration = true;
    const invoke = context.bind(async () => {
      const store = createPrismaWorkspaceBillingStore({ register: async ids => {
        expect(ids).toHaveLength(2);
        const record = await readExecutionDispatch(db, ids[0]!);
        expect(record).toMatchObject({ deadlineKind: "lease", reference: { subject: { kind: "workspace_billing", id: workspace.id } } });
        if (rejectRegistration) throw new Error("interactive_watchdog_unconfirmed");
      } });
      return store.claimAccount({ workspaceId: workspace.id, now: new Date(0), leaseMs: 60_000 });
    });
    await expect(invoke()).rejects.toThrow("interactive_watchdog_unconfirmed");
    expect(await db.workspaceBillingAccount.findUniqueOrThrow({ where: { workspaceId: workspace.id } })).toMatchObject({ reconcileAttemptId: null, leaseExpiresAt: null, attemptCount: 0 });
    rejectRegistration = false;
    const claim = await invoke();
    expect(claim?.attemptCount).toBe(1);
    const row = await db.workspaceBillingAccount.findUniqueOrThrow({ where: { workspaceId: workspace.id } });
    expect(row.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(row.reconcileAttemptId).toBe(claim!.attemptId);
  });
  test("a lost scheduling acknowledgement replays the same durable Checkout and due obligation", async () => {
    const workspace = await fixture();
    const context = createDatabaseTestContext(); context.client = db;
    const registrations: string[][] = [];
    let loseAck = true;
    const input = { workspaceId: workspace.id, actorUserId: workspace.ownerUserId, clientIdempotencyKey: crypto.randomUUID(),
      targetTier: "pro" as const, interval: "monthly" as const, catalogVersion: "gate-v1", returnDestination: "/settings/billing", now: new Date() };
    const invoke = context.bind(async () => createPrismaWorkspaceBillingStore({ register: async ids => {
      registrations.push([...ids]); if (loseAck) throw new Error("checkout_schedule_unconfirmed");
    } }).prepareCheckoutAttempt(input));
    await expect(invoke()).rejects.toThrow("checkout_schedule_unconfirmed");
    const accepted = await db.workspaceCheckoutAttempt.findUniqueOrThrow({ where: { clientIdempotencyKey: input.clientIdempotencyKey } });
    loseAck = false;
    const replay = await invoke();
    expect(replay).toMatchObject({ kind: "existing", attempt: { id: accepted.id } });
    expect(registrations).toHaveLength(2);
    expect(registrations[1]).toEqual(registrations[0]);
    expect(await db.workspaceCheckoutAttempt.count({ where: { billingAccount: { workspaceId: workspace.id } } })).toBe(1);
    expect((await db.workspaceBillingAccount.findUniqueOrThrow({ where: { workspaceId: workspace.id } })).reconciliationGeneration).toBe(1);
  });
  test("restore revokes the old billing claim without product dispatch or a fresh provider budget",async()=>{
    const workspace=await fixture(new Date(Date.now()+60_000));
    await db.$transaction(tx=>queueBillingReconciliation(tx,workspace.id));
    await db.workspaceBillingAccount.update({where:{workspaceId:workspace.id},data:{attemptCount:3,reconcileAttemptId:crypto.randomUUID(),leaseExpiresAt:new Date(Date.now()+30_000),providerCustomerId:"cus_preserved",canonicalSubscriptionId:"sub_preserved"}});
    const before=await db.workspaceBillingAccount.findUniqueOrThrow({where:{workspaceId:workspace.id}}),count=await db.executionDispatch.count({where:{subjectId:workspace.id}});
    await expect(db.$transaction(tx=>recoverBillingReconciliation(tx,workspace.id,{deferDispatch:true}))).rejects.toThrow("billing_restore_requires_closed_admission");
    await expect(db.$transaction(async tx=>{
      const epoch=await tx.executionEpoch.update({where:{id:1},data:{epoch:{increment:1},admissionOpen:false}});
      expect(await recoverBillingReconciliation(tx,workspace.id,{deferDispatch:true})).toBeNull();
      expect(takeExecutionDispatchIds(tx)).toEqual([]);
      expect(await tx.executionDispatch.count({where:{subjectId:workspace.id}})).toBe(count);
      expect(await tx.workspaceBillingAccount.findUniqueOrThrow({where:{workspaceId:workspace.id}})).toMatchObject({reconciliationEpoch:epoch.epoch,reconciliationGeneration:before.reconciliationGeneration+1,
        attemptCount:3,reconcileAttemptId:null,leaseExpiresAt:null,providerCustomerId:"cus_preserved",canonicalSubscriptionId:"sub_preserved",nextReconcileAt:before.nextReconcileAt});
      throw Error("restore_test_rollback");
    })).rejects.toThrow("restore_test_rollback");
    expect(await db.workspaceBillingAccount.findUniqueOrThrow({where:{workspaceId:workspace.id}})).toEqual(before);
  });
});
