import { describe, expect, test } from "bun:test";
import {
  advanceWorkflowCursor,
  isAfterWorkflowCursor,
  normalizeWorkflowSeq,
  parseSinceSeq,
} from "@narriflow/validators/api/progress";
import {
  type ActorScope,
  type ProjectAdmissionResult,
  createAuthenticatedRequestPolicy,
} from "../../http/request-policy";
import { createConnectionRegistry } from "./connections";
import { createReauthorizationGuard, reauthorizationResult } from "./reauthorization";

const revocations = [
  "authentication_required",
  "workspace_membership_missing",
  "capability_forbidden",
  "workspace_restricted",
  "project_not_found",
  "session_expired",
  "workspace_membership_purged",
] as const;

function guardWith(overrides: Partial<Parameters<typeof createReauthorizationGuard>[0]>) {
  return createReauthorizationGuard({
    authorize: async () => ({ ok: true }),
    onAuthorized: () => {},
    onRevoked: () => {},
    cleanup: () => {},
    close: () => {},
    unexpectedControl: () => ({ error: "internal_error" }),
    ...overrides,
  });
}

describe("stream reauthorization guard", () => {
  for (const error of revocations) {
    test(`closes with one safe control event when ${error}`, async () => {
      const events: unknown[] = [];
      let cleanups = 0;
      let closes = 0;
      const guard = guardWith({
        authorize: async () => ({ ok: false, error, requestId: "request-stream-1" }),
        onAuthorized: () => events.push({ event: "ping" }),
        onRevoked: (control) => events.push(control),
        cleanup: () => cleanups++,
        close: () => closes++,
      });
      await Promise.all([guard.check(), guard.check(), guard.check()]);
      await guard.check();
      expect(events).toEqual([{ error, requestId: "request-stream-1" }]);
      expect(cleanups).toBe(1);
      expect(closes).toBe(1);
    });
  }

  test("serializes checks and pings only after fresh authorization", async () => {
    let release: (() => void) | null = null;
    let authorizations = 0;
    let pings = 0;
    const guard = guardWith({
      authorize: () => {
        authorizations++;
        return new Promise((resolve) => {
          release = () => resolve({ ok: true });
        });
      },
      onAuthorized: () => pings++,
    });
    const checks = [guard.check(), guard.check(), guard.check()];
    expect(authorizations).toBe(1);
    (release as (() => void) | null)?.();
    await Promise.all(checks);
    expect(pings).toBe(1);
  });

  test("converts an unexpected failure into one bounded control event", async () => {
    const events: unknown[] = [];
    const guard = guardWith({
      authorize: async () => {
        throw new Error("private database failure");
      },
      onRevoked: (control) => events.push(control),
      unexpectedControl: () => ({ error: "internal_error", requestId: "request-stream-2" }),
    });
    await guard.check();
    await guard.check();
    expect(events).toEqual([{ error: "internal_error", requestId: "request-stream-2" }]);
  });
});

const actor: ActorScope = {
  actorUserId: "actor-stream",
  workspaceId: "workspace-stream",
  workspaceName: "Stream Workspace",
  workspaceOwnerUserId: "owner-stream",
  role: "editor",
  status: "active",
  pricingTier: "pro",
  isPersonalWorkspace: false,
  workspaceSelectionChanged: false,
};

describe("stream access re-check through the real policy", () => {
  async function recheck(state: { actor: ActorScope | null; project: ProjectAdmissionResult }) {
    const policy = createAuthenticatedRequestPolicy({
      resolveProject: async () => state.project,
      rateLimit: async () => ({ allowed: true }),
      now: () => 1,
    });
    return reauthorizationResult(
      await policy.execute(
        {
          adapter: "stream",
          operationName: "reauthorize-workflow-progress-stream",
          admission: { kind: "project", capability: "content.view", projectId: "project-stream" },
          operation: async () => true,
        },
        { requestId: "request-stream", resolveActor: async () => state.actor },
      ),
    );
  }
  const active: ProjectAdmissionResult = { kind: "active", projectId: "project-stream" };

  test("admits an active member, and revokes on each loss of access", async () => {
    expect(await recheck({ actor, project: active })).toEqual({ ok: true });
    expect(await recheck({ actor: null, project: active })).toEqual({
      ok: false,
      error: "authentication_required",
      requestId: "request-stream",
    });
    expect(await recheck({ actor: { ...actor, status: "restricted" }, project: active })).toMatchObject({
      ok: false,
      error: "workspace_restricted",
    });
    expect(await recheck({ actor: { ...actor, role: "viewer", status: "restricted" }, project: active })).toMatchObject({
      ok: false,
      error: "workspace_restricted",
    });
    expect(await recheck({ actor, project: { kind: "missing" } })).toMatchObject({
      ok: false,
      error: "project_not_found",
    });
    expect(
      await recheck({
        actor,
        project: {
          kind: "workspace_mismatch",
          projectId: "project-stream",
          workspaceId: "workspace-other",
          workspaceName: "Other Workspace",
        },
      }),
    ).toMatchObject({ ok: false, error: "active_workspace_mismatch" });
  });
});

describe("workflow cursor", () => {
  test("advances only for a newer safe sequence", () => {
    expect(isAfterWorkflowCursor(4, 5)).toBe(true);
    expect(advanceWorkflowCursor(4, 5)).toBe(5);
    expect(advanceWorkflowCursor(5, 9)).toBe(9);
    expect(isAfterWorkflowCursor(5, 5)).toBe(false);
    expect(advanceWorkflowCursor(5, 4)).toBe(5);
  });

  test("rejects malformed, negative and unsafe sequences", () => {
    expect(normalizeWorkflowSeq("6")).toBeNull();
    expect(normalizeWorkflowSeq(-1)).toBeNull();
    expect(normalizeWorkflowSeq(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(advanceWorkflowCursor(5, { seq: 6 })).toBe(5);
  });

  test("?sinceSeq= falls back to a full replay when malformed", () => {
    expect(parseSinceSeq("12")).toBe(12);
    expect(parseSinceSeq(undefined)).toBe(0);
    expect(parseSinceSeq("")).toBe(0);
    expect(parseSinceSeq("-3")).toBe(0);
    expect(parseSinceSeq("1.5")).toBe(0);
    expect(parseSinceSeq("abc")).toBe(0);
    expect(parseSinceSeq("99999999999999999999")).toBe(0);
  });
});

describe("connection registry", () => {
  test("bounds the process and each actor, and frees a slot once", () => {
    const registry = createConnectionRegistry({ maxConnections: 3, maxConnectionsPerActor: 2 });
    const a1 = registry.admit("a");
    const a2 = registry.admit("a");
    expect(registry.admit("a")).toEqual({ refused: "actor_limit" });
    const b1 = registry.admit("b");
    expect(registry.admit("c")).toEqual({ refused: "capacity" });
    expect(registry.open).toBe(3);
    if ("release" in a1) {
      a1.release();
      a1.release();
    }
    expect(registry.open).toBe(2);
    expect("release" in registry.admit("a")).toBe(true);
    void a2;
    void b1;
  });
});
