import { describe, expect, test } from "bun:test";
import type { RenderGroupStatus } from "@prisma/client";
import {
  deriveRenderGroupSettlement,
  deriveRenderParentSettlement,
  renderGroupChargeTransition,
  renderGroupExportIdentity,
  renderGroupOwnsMember,
  type RenderGroupMemberOutcome,
  type SettlingRenderGroup,
} from "./render-group-contract";

const now = new Date("2026-10-29T12:00:00.000Z");
const unstarted = { startedAt: null, finishedAt: null, charged: false };
const started = { startedAt: now, finishedAt: null, charged: true };
const member = (id: string, status: RenderGroupMemberOutcome["status"],
  failureDisposition: RenderGroupMemberOutcome["failureDisposition"] = null): RenderGroupMemberOutcome =>
  ({ clipRenderId: id, status, failureDisposition });
const settle = (members: RenderGroupMemberOutcome[], chargedAttemptCount = 1) =>
  deriveRenderGroupSettlement({ members, chargedAttemptCount, databaseNow: now });

const attempt = { workflowRunId: "run", workSetGeneration: "generation", groupId: "group", token: "token", owner: "replica-a" };
function ownership() {
  return {
    attempt,
    parent: { workflowRunId: "run", stage: "clip_rendering", status: "running", workSetGeneration: "generation" },
    group: { ...attempt, status: "running" as RenderGroupStatus, attemptToken: "token", leaseOwner: "replica-a", leaseExpiresAt: new Date(now.getTime() + 1) },
    clipRenderId: "variant",
    member: { ...attempt, clipRenderId: "variant", invalidatedAt: null as Date | null },
    databaseNow: now,
  };
}

function terminal(overrides: Partial<SettlingRenderGroup> = {}): SettlingRenderGroup {
  return { requested: 1, succeeded: 1, failed: 0, superseded: 0, status: "completed", leaseExpiresAt: null, nextAttemptAt: null, ...overrides };
}
function parent(groups: SettlingRenderGroup[], requestedCount = groups.reduce((n, g) => n + g.requested, 0)) {
  return deriveRenderParentSettlement({ frozen: true, requestedCount, groups, databaseNow: now });
}

describe("Render Group identity and fencing", () => {
  test("aspects share configuration identity, while frozen revisions and exports stay separate", () => {
    const config = { clipId: "clip", exportId: "export-a", editorRevision: 7, resolution: "1080p", watermark: false };
    const identity = renderGroupExportIdentity(config);
    expect(renderGroupExportIdentity({ ...config })).toBe(identity);
    for (const changed of [
      { ...config, exportId: "export-b" }, { ...config, exportId: null },
      { ...config, editorRevision: 8 }, { ...config, resolution: "720p" }, { ...config, watermark: true },
    ]) expect(renderGroupExportIdentity(changed)).not.toBe(identity);
  });

  test("coordinator reclaim leaves the same generation and healthy child valid", () => {
    const input = ownership();
    expect(renderGroupOwnsMember(input)).toBe(true);
    // The coordinator may be queued between claims. Its lease/attempt is not
    // in this contract, so reclaim cannot revoke this child.
    input.parent.status = "queued";
    expect(renderGroupOwnsMember(input)).toBe(true);
  });

  test.each(["token", "owner", "generation", "member", "cancelled", "expired", "wrong_run", "group", "stage", "wrong_variant"])("refuses invalid %s ownership", (change) => {
    const input = ownership();
    if (change === "token") input.attempt = { ...attempt, token: "stale" };
    if (change === "owner") input.attempt = { ...attempt, owner: "replica-b" };
    if (change === "generation") input.parent.workSetGeneration = "superseding-generation";
    if (change === "member") input.member.invalidatedAt = now;
    if (change === "cancelled") input.parent.status = "cancelled";
    if (change === "expired") input.group.leaseExpiresAt = now;
    if (change === "wrong_run") input.member.workflowRunId = "other-run";
    if (change === "group") input.group.groupId = "other-group";
    if (change === "stage") input.parent.stage = "dubbing";
    if (change === "wrong_variant") input.member.clipRenderId = "other-variant";
    expect(renderGroupOwnsMember(input)).toBe(false);
  });
});

describe("Render Group charged starts", () => {
  test("claim and spawn rejection before execution consume no budget", () => {
    expect(renderGroupChargeTransition(0, unstarted, "release")).toEqual({ charged: false, delta: 0, chargedAttemptCount: 0 });
    expect(renderGroupChargeTransition(0, unstarted, "expire").chargedAttemptCount).toBe(0);
  });
  test("a durable start charges once and crash recovery retains that charge", () => {
    expect(renderGroupChargeTransition(0, unstarted, "start")).toEqual({ charged: true, delta: 1, chargedAttemptCount: 1 });
    expect(renderGroupChargeTransition(1, started, "start").delta).toBe(0);
    expect(renderGroupChargeTransition(1, started, "expire").chargedAttemptCount).toBe(1);
  });
  test("graceful shutdown refunds a started token exactly once", () => {
    expect(renderGroupChargeTransition(1, started, "release")).toEqual({ charged: false, delta: -1, chargedAttemptCount: 0 });
    const released = { ...started, charged: false, finishedAt: now };
    expect(renderGroupChargeTransition(0, released, "release").delta).toBe(0);
    expect(renderGroupChargeTransition(0, released, "start").delta).toBe(0);
  });
  test("an exhausted group cannot start a fourth charged attempt", () => {
    expect(() => renderGroupChargeTransition(3, unstarted, "start")).toThrow();
    expect(() => renderGroupChargeTransition(0, started, "release")).toThrow();
  });
});

describe("Render Group outcomes and retries", () => {
  const mixed = [member("done", "completed"), member("bad", "failed", "permanent"),
    member("transient", "failed", "retryable"), member("interrupted", "rendering"), member("old", "superseded")];
  test.each([1, 2])("preserves successful/permanent siblings through charged attempt %i", (count) => {
    const outcome = settle(mixed, count);
    expect(outcome).toEqual({ status: "queued", requested: 5, succeeded: 1, failed: 1, superseded: 1,
      retryVariantIds: ["transient", "interrupted"], nextAttemptAt: new Date(now.getTime() + count * 30_000) });
  });
  test("third charged attempt exhausts only this group's unsettled members", () => {
    expect(settle(mixed, 3)).toEqual({ status: "partial", requested: 5, succeeded: 1, failed: 3, superseded: 1, retryVariantIds: [], nextAttemptAt: null });
    expect(settle([member("healthy-other-group", "completed")], 1).status).toBe("completed");
  });
  test("pre-start release is immediately due unless shutdown drain defers it", () => {
    expect(settle([member("pending", "pending")], 0).nextAttemptAt).toEqual(now);
    const releaseNotBefore = new Date(now.getTime() + 45_000);
    expect(deriveRenderGroupSettlement({ members: [member("pending", "pending")], chargedAttemptCount: 0, databaseNow: now, releaseNotBefore }).nextAttemptAt).toEqual(releaseNotBefore);
  });
  test("content failures settle immediately; all superseded work stays distinct", () => {
    expect(settle([member("bad", "failed", "permanent")]).status).toBe("failed");
    expect(settle([member("old", "superseded")]).status).toBe("superseded");
    expect(settle([member("done", "completed"), member("old", "superseded")]).status).toBe("completed");
  });
  test("rejects duplicate/empty membership and invalid budgets", () => {
    expect(() => settle([])).toThrow();
    expect(() => settle([member("a", "completed"), member("a", "pending")])).toThrow();
    expect(() => settle(mixed, -1)).toThrow();
  });
});

describe("Render parent settlement", () => {
  test("all groups settle once, with one parent notification decision", () => {
    expect(parent([terminal(), terminal({ status: "failed", succeeded: 0, failed: 1 })])).toEqual({ eligible: true, status: "partial", notify: true, requested: 2, succeeded: 1, failed: 1, superseded: 0 });
    expect(parent([terminal({ status: "superseded", succeeded: 0, superseded: 1 })])).toEqual({ eligible: true, status: "completed", notify: false, requested: 1, succeeded: 0, failed: 0, superseded: 1 });
    expect(parent([terminal({ status: "failed", succeeded: 0, failed: 1 })])).toMatchObject({ eligible: true, status: "failed", notify: true });
  });
  test("membership must be frozen and fully partitioned before settlement", () => {
    expect(deriveRenderParentSettlement({ frozen: false, requestedCount: 0, groups: [], databaseNow: now })).toEqual({ eligible: false, reason: "not_frozen" });
    expect(parent([terminal()], 2)).toEqual({ eligible: false, reason: "membership_incomplete" });
    expect(parent([terminal({ succeeded: 0 })])).toEqual({ eligible: false, reason: "membership_incomplete" });
    expect(parent([terminal({ status: "failed" })])).toEqual({ eligible: false, reason: "membership_incomplete" });
    expect(parent([], 0)).toMatchObject({ eligible: true, status: "completed", notify: false });
  });
  test("a healthy child lease blocks coordinator settlement", () => {
    expect(parent([terminal({ leaseExpiresAt: new Date(now.getTime() + 1) })])).toEqual({ eligible: false, reason: "live_lease" });
  });
  test.each([-1, 60_000])("a retry due at offset %i must settle before the parent", (offset) => {
    expect(parent([terminal({ status: "queued", nextAttemptAt: new Date(now.getTime() + offset) })])).toEqual({ eligible: false, reason: "retry_scheduled" });
  });
  test("expired child ownership still needs reaping rather than implicit parent completion", () => {
    expect(parent([terminal({ status: "running", leaseExpiresAt: now })])).toEqual({ eligible: false, reason: "unsettled_groups" });
  });
});
