import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import { admitRenderCapacityWithinTransaction, orderRenderWaiters, renderCapacityRetryAt, type RenderWaiter } from "./render-capacity";

const now = new Date("2026-11-06T12:00:00.000Z");
function waiter(id: string, workspaceId: string, tier: string, minutesWaiting = 0): RenderWaiter {
  return { id, workspaceId, tier, waitingSince: new Date(now.getTime() - minutesWaiting * 60_000) };
}
const ids = (waiters: readonly RenderWaiter[]) => waiters.map(entry => entry.id);

describe("orderRenderWaiters", () => {
  test("a Workspace with a long queue cannot hold everyone else behind it", () => {
    const large = Array.from({ length: 20 }, (_, index) => waiter(`large-${index}`, "large", "business", 1));
    const ordered = ids(orderRenderWaiters([...large, waiter("small", "small", "free")], new Map(), now));
    expect(ordered.indexOf("small")).toBeLessThan(5);
  });

  test("the same queue position favours the higher plan", () => {
    const ordered = ids(orderRenderWaiters([waiter("free", "a", "free"), waiter("business", "b", "business")], new Map(), now));
    expect(ordered).toEqual(["business", "free"]);
  });

  test("work already running counts against the Workspace", () => {
    const ordered = ids(orderRenderWaiters([waiter("busy", "a", "pro"), waiter("idle", "b", "pro")], new Map([["a", 10]]), now));
    expect(ordered).toEqual(["idle", "busy"]);
  });

  test("a long wait overtakes a higher plan, so nobody starves", () => {
    const ordered = ids(orderRenderWaiters([waiter("new-business", "a", "business"), waiter("old-free", "b", "free", 60)], new Map(), now));
    expect(ordered).toEqual(["old-free", "new-business"]);
  });

  test("the order inside one Workspace is first come, first served", () => {
    const ordered = ids(orderRenderWaiters([waiter("second", "a", "pro", 1), waiter("first", "a", "pro", 2)], new Map(), now));
    expect(ordered).toEqual(["first", "second"]);
  });

  test("an unknown tier falls back to the free weight instead of failing", () => {
    expect(ids(orderRenderWaiters([waiter("only", "a", "retired-plan")], new Map(), now))).toEqual(["only"]);
  });
});

describe("renderCapacityRetryAt", () => {
  test("stays between five and six minutes, and differs by group", () => {
    const first = renderCapacityRetryAt("00000000-0000-4000-8000-000000000000", now).getTime() - now.getTime();
    const second = renderCapacityRetryAt("7fffffff-0000-4000-8000-000000000000", now).getTime() - now.getTime();
    for (const delay of [first, second]) {
      expect(delay).toBeGreaterThanOrEqual(300_000);
      expect(delay).toBeLessThan(360_000);
    }
    expect(first).not.toBe(second);
  });
});

describe("admitRenderCapacityWithinTransaction", () => {
  const groupId = "11111111-1111-4111-8111-111111111111";
  function transaction(input: { active?: Array<{ workspaceId: string; active: number }>; waiters?: Array<RenderWaiter & { generation: number }> }) {
    const writes: Array<Record<string, unknown>> = [], statements: string[] = [];
    const tx = {
      $queryRaw: async (parts: TemplateStringsArray) => {
        const sql = parts.join("?");
        statements.push(sql);
        if (sql.includes("pg_advisory_xact_lock")) return [{ locked: false }];
        if (sql.includes("clock_timestamp")) return [{ now }];
        if (sql.includes("COUNT(*)")) return input.active ?? [];
        return input.waiters ?? [];
      },
      renderGroup: { update: async (call: { data: Record<string, unknown> }) => { writes.push(call.data); return call.data; } },
    } as unknown as Prisma.TransactionClient;
    return { tx, writes, statements };
  }
  const request = (overrides: { capacityWaitSince?: Date | null; maxAdmittedGroups?: number } = {}) => ({
    group: { id: groupId, deploymentEpoch: 1, capacityWaitSince: overrides.capacityWaitSince ?? null },
    workspaceId: "w", tier: "pro", maxAdmittedGroups: overrides.maxAdmittedGroups ?? 2,
  });

  test("a free slot and an empty queue admit at once, with nothing to clear", async () => {
    const { tx, writes } = transaction({ active: [{ workspaceId: "other", active: 1 }] });
    expect(await admitRenderCapacityWithinTransaction(tx, request())).toEqual({ admitted: true, waitedMs: 0 });
    expect(writes).toEqual([]);
  });

  test("a full system never reads the queue, and parks the group with a timer", async () => {
    const { tx, writes, statements } = transaction({ active: [{ workspaceId: "a", active: 1 }, { workspaceId: "b", active: 1 }] });
    const outcome = await admitRenderCapacityWithinTransaction(tx, request());
    expect(outcome.admitted).toBe(false);
    expect(writes).toEqual([{ capacityWaitSince: now, nextAttemptAt: renderCapacityRetryAt(groupId, now) }]);
    expect(statements.some(sql => sql.includes('AS "waitingSince"'))).toBe(false);
  });

  test("the capacity lock is taken before anything is counted", async () => {
    const { tx, statements } = transaction({});
    await admitRenderCapacityWithinTransaction(tx, request());
    expect(statements[0]).toContain("pg_advisory_xact_lock");
  });

  test("a free slot goes to whoever is ahead in line, not to whoever woke first", async () => {
    const ahead = { ...waiter("22222222-2222-4222-8222-222222222222", "other", "business", 30), generation: 1 };
    const { tx, writes } = transaction({ active: [{ workspaceId: "w", active: 1 }], waiters: [ahead] });
    const outcome = await admitRenderCapacityWithinTransaction(tx, request());
    expect(outcome.admitted).toBe(false);
    expect(writes).toHaveLength(1);
  });

  test("waiting again keeps the original place in line", async () => {
    const since = new Date(now.getTime() - 20 * 60_000);
    const { tx, writes } = transaction({ active: [{ workspaceId: "a", active: 2 }] });
    await admitRenderCapacityWithinTransaction(tx, request({ capacityWaitSince: since }));
    expect(writes[0]?.capacityWaitSince).toEqual(since);
  });

  test("admission clears the wait, including the timer that would block acquisition", async () => {
    const since = new Date(now.getTime() - 20 * 60_000);
    const { tx, writes } = transaction({});
    expect(await admitRenderCapacityWithinTransaction(tx, request({ capacityWaitSince: since }))).toEqual({ admitted: true, waitedMs: 20 * 60_000 });
    expect(writes).toEqual([{ capacityWaitSince: null, nextAttemptAt: null }]);
  });

  test("a group already in the queue is not counted against itself", async () => {
    const since = new Date(now.getTime() - 20 * 60_000);
    const self = { id: groupId, workspaceId: "w", tier: "pro", waitingSince: since, generation: 1 };
    const { tx } = transaction({ waiters: [self] });
    const outcome = await admitRenderCapacityWithinTransaction(tx, request({ capacityWaitSince: since, maxAdmittedGroups: 1 }));
    expect(outcome.admitted).toBe(true);
  });
});

test("the immutability trigger lets a capacity wait change", () => {
  // A BEFORE UPDATE trigger compares the whole row, so a new mutable column must join its allowlist.
  const root = join(import.meta.dir, "../../db/prisma/migrations");
  const latest = readdirSync(root).sort().reverse().map(name => { try { return readFileSync(join(root, name, "migration.sql"), "utf8"); } catch { return ""; } })
    .find(sql => sql.includes("FUNCTION render_group_identity_immutable"));
  expect(latest?.match(/'capacityWaitSince'/g)).toHaveLength(2);
});
