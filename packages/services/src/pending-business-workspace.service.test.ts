import { describe, expect, test } from "bun:test";
import { Prisma, type PrismaClient } from "@prisma/client";
import { createPendingBusinessWorkspaceService, canRemovePendingBusinessWorkspace, pendingBusinessWorkspaceDueAt, pendingBusinessWorkspaceSelection } from "./pending-business-workspace.service";

type Row = Parameters<typeof canRemovePendingBusinessWorkspace>[0];
const now = new Date("2026-10-30T00:00:00Z");
function empty(): Row {
  return {
    status: "pending_payment", pricingTier: "free", ownerUserId: "creator", personalOwnerUserId: null,
    avatarStorageKey: null, defaultBrandProfileId: null, defaultBrandTemplateId: null,
    members: [{ userId: "creator", role: "owner" }], _count: Object.fromEntries(Object.keys(pendingBusinessWorkspaceSelection._count.select).map((key) => [key, 0])), createdAt: now,
    performanceGuidance: null, workspaceEventCounter: null,
    billingAccount: { canonicalSubscriptionId: null, providerStatus: null,
      _count: { transitions: 0, deliveries: 0, planChangeAttempts: 0 }, checkoutAttempts: [] },
  } as unknown as Row;
}

describe("pending Business workspace removal policy", () => {
  test("every generated Workspace relation has a removal policy", () => {
    // These relations have explicit identity, membership, or billing checks in
    // canRemovePendingBusinessWorkspace rather than an empty-content count.
    const explicitlyChecked = {
      owner: "Owner is a parent User; deletion must preserve that User.",
      personalOwner: "personalOwnerUserId must be null.",
      defaultBrandTemplate: "defaultBrandTemplateId must be null.",
      defaultBrandProfile: "defaultBrandProfileId must be null.",
      members: "Exactly the creator with the owner role is required.",
      billingAccount: "Unpaid account, attempts and all billing history are checked separately.",
    };
    const relations = Prisma.dmmf.datamodel.models.find((model) => model.name === "Workspace")!
      .fields.filter((field) => field.kind === "object").map((field) => field.name).sort();
    expect(relations).toEqual([
      ...Object.keys(pendingBusinessWorkspaceSelection._count.select),
      "performanceGuidance", "workspaceEventCounter",
      ...Object.keys(explicitlyChecked),
    ].sort());
    expect(Object.values(explicitlyChecked).every((reason) => reason.length > 20)).toBe(true);
  });

  test("every counted relation and optional content row prevents removal", () => {
    for (const relation of Object.keys(pendingBusinessWorkspaceSelection._count.select)) {
      const row = empty();
      Object.assign(row._count, { [relation]: 1 });
      expect(canRemovePendingBusinessWorkspace(row)).toBe(false);
    }
    for (const relation of ["performanceGuidance", "workspaceEventCounter"] as const) {
      const row = empty();
      row[relation] = { workspaceId: "workspace" };
      expect(canRemovePendingBusinessWorkspace(row)).toBe(false);
    }
  });

  test("only an empty creator-only unpaid workspace qualifies", () => {
    expect(canRemovePendingBusinessWorkspace(empty())).toBe(true);
    for (const change of [
      { status: "active" }, { pricingTier: "business" }, { personalOwnerUserId: "creator" },
      { avatarStorageKey: "brand-logo" }, { defaultBrandProfileId: "brand" },
      { members: [{ userId: "someone-else", role: "owner" }] }, { members: [] },
      { _count: { brandProfiles: 1 } }, { _count: { projects: 1 } },
      { billingAccount: null },
    ]) expect(canRemovePendingBusinessWorkspace({ ...empty(), ...change } as Row)).toBe(false);
  });

  test("all subscription history and completed payments protect the workspace", () => {
    for (const change of [
      { canonicalSubscriptionId: "sub_old" }, { providerStatus: "canceled" },
      { _count: { transitions: 1 } }, { _count: { deliveries: 1 } },
      { checkoutAttempts: [{ sessionStatus: "complete" }] }, { checkoutAttempts: [{ paymentStatus: "paid" }] },
      { checkoutAttempts: Array.from({ length: 101 }, () => ({})) },
    ]) {
      const row = empty();
      Object.assign(row.billingAccount!, change);
      expect(canRemovePendingBusinessWorkspace(row)).toBe(false);
    }
  });

  test("TTL includes a full extra day after the latest session expiry, even without a session response", () => {
    const row = empty();
    expect(pendingBusinessWorkspaceDueAt(row)).toBe(now.getTime() + 2 * 86400_000);
    row.billingAccount!.checkoutAttempts = [{ expiresAt: new Date(now.getTime() + 3 * 86400_000), createdAt: now }] as NonNullable<Row["billingAccount"]>["checkoutAttempts"];
    expect(pendingBusinessWorkspaceDueAt(row)).toBe(now.getTime() + 4 * 86400_000);
  });
});

describe("pending cleanup failure isolation", () => {
  test("a failed candidate rotation does not skip the next candidate", async () => {
    const checked: string[] = [];
    const rotated: string[] = [];
    const prisma = { workspace: {
      findMany: async () => [{ id: "first" }, { id: "second" }],
      findUnique: async ({ where }: { where: { id: string } }) => { checked.push(where.id); throw new Error("Read unavailable"); },
      updateMany: async ({ where }: { where: { id: string } }) => { rotated.push(where.id); throw new Error("Rotation unavailable"); },
    } } as unknown as PrismaClient;
    const service = createPendingBusinessWorkspaceService({ prisma, provider: { retrieveCurrentState: async () => { throw new Error("unused"); } }, expireSession: async () => {} });
    expect(await service.sweep()).toEqual({ checked: 2, removed: 0 });
    expect(checked).toEqual(["first", "second"]);
    expect(rotated).toEqual(checked);
  });

  test("a failed whole-tick candidate read is deferred", async () => {
    const prisma = { workspace: { findMany: async () => { throw new Error("Database unavailable"); } } } as unknown as PrismaClient;
    const service = createPendingBusinessWorkspaceService({ prisma, provider: { retrieveCurrentState: async () => { throw new Error("unused"); } }, expireSession: async () => {} });
    expect(await service.sweep()).toEqual({ checked: 0, removed: 0 });
  });
});
