import { describe, expect, test } from "bun:test";
import type { Prisma } from "@prisma/client";
import { settleDeletedOwnerWorkspaces } from "./identity";

/**
 * Decision logic only, against a recording stand-in for the transaction. The
 * SQL (row locks, the oldest-admin ordering, the personal-Workspace filter) and
 * the Prisma writes are not exercised here; no PostgreSQL gate covers them.
 */
function fakeTransaction(options: {
  owned: Array<{ id: string; workspaceId: string }>;
  successors?: Record<string, { id: string; userId: string }>;
  /** Billing accounts that have not yet recorded a cancellation request. */
  unrequested?: Set<string>;
}) {
  const writes: Array<{ op: string; data: unknown }> = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      if (sql.includes("role = 'owner'")) return options.owned;
      const successor = options.successors?.[String(values[0])];
      return successor ? [successor] : [];
    },
    workspaceMember: {
      delete: async (args: unknown) => void writes.push({ op: "member.delete", data: args }),
      update: async (args: unknown) => void writes.push({ op: "member.update", data: args }),
    },
    workspace: { update: async (args: unknown) => void writes.push({ op: "workspace.update", data: args }) },
    workspaceBillingAccount: {
      updateMany: async (args: { where: { workspaceId: string; cancelAtPeriodEndRequestedAt?: null } }) => {
        writes.push({ op: "billing.updateMany", data: args });
        if (args.where.cancelAtPeriodEndRequestedAt === null) {
          const pending = options.unrequested?.has(args.where.workspaceId) ?? false;
          options.unrequested?.delete(args.where.workspaceId);
          return { count: pending ? 1 : 0 };
        }
        return { count: 1 };
      },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, writes };
}

const now = new Date("2026-11-04T10:00:00.000Z");

describe("a deleted owner's Workspaces", () => {
  test("pass to the oldest admin, who stops being a billable seat", async () => {
    const { tx, writes } = fakeTransaction({
      owned: [{ id: "member-owner", workspaceId: "ws-1" }],
      successors: { "ws-1": { id: "member-admin", userId: "user-admin" } },
    });
    const settled = await settleDeletedOwnerWorkspaces(tx, "user-owner", now);
    expect(settled).toEqual([{ workspaceId: "ws-1", outcome: "ownership_transferred", successorUserId: "user-admin" }]);
    expect(writes.map((write) => write.op)).toEqual(["member.delete", "member.update", "workspace.update", "billing.updateMany"]);
    expect(writes[0]!.data).toEqual({ where: { id: "member-owner" } });
    expect(writes[1]!.data).toEqual({ where: { id: "member-admin" }, data: { role: "owner" } });
    expect(writes[2]!.data).toEqual({ where: { id: "ws-1" }, data: { ownerUserId: "user-admin" } });
    expect(writes[3]!.data).toMatchObject({
      data: { cancelAtPeriodEndRequestedAt: null, desiredAdditionalSeats: { decrement: 1 }, seatRevision: { increment: 1 }, nextReconcileAt: now },
    });
  });

  test("with no admin, ask billing to cancel at period end", async () => {
    const { tx, writes } = fakeTransaction({
      owned: [{ id: "member-owner", workspaceId: "ws-2" }],
      unrequested: new Set(["ws-2"]),
    });
    const settled = await settleDeletedOwnerWorkspaces(tx, "user-owner", now);
    expect(settled).toEqual([{ workspaceId: "ws-2", outcome: "cancel_at_period_end_requested" }]);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.data).toMatchObject({
      where: { workspaceId: "ws-2", cancelAtPeriodEndRequestedAt: null },
      data: { cancelAtPeriodEndRequestedAt: now, nextReconcileAt: now },
    });
  });

  test("a repeat delivery changes nothing", async () => {
    // Transferred earlier: no owner membership is left to find.
    const transferred = fakeTransaction({ owned: [] });
    expect(await settleDeletedOwnerWorkspaces(transferred.tx, "user-owner", now)).toEqual([]);
    expect(transferred.writes).toEqual([]);
    // Cancellation already requested: the guarded update matches no row.
    const requested = fakeTransaction({ owned: [{ id: "member-owner", workspaceId: "ws-2" }], unrequested: new Set() });
    expect(await settleDeletedOwnerWorkspaces(requested.tx, "user-owner", now)).toEqual([]);
  });

  test("each owned Workspace is settled on its own", async () => {
    const { tx } = fakeTransaction({
      owned: [{ id: "m1", workspaceId: "ws-a" }, { id: "m2", workspaceId: "ws-b" }],
      successors: { "ws-a": { id: "m3", userId: "user-admin" } },
      unrequested: new Set(["ws-b"]),
    });
    expect((await settleDeletedOwnerWorkspaces(tx, "user-owner", now)).map((entry) => entry.outcome)).toEqual([
      "ownership_transferred",
      "cancel_at_period_end_requested",
    ]);
  });
});
