import { describe, expect, test } from "bun:test";
import {
  createWorkflowStreamReauthorizationGuard,
  workflowStreamAuthorizationResult,
} from "./workflow-stream-reauthorization";
import {
  createAuthenticatedRequestPolicy,
  type ActorScope,
  type ProjectAdmissionResult,
} from "./authenticated-request-policy";

const revocations = [
  "authentication_required",
  "workspace_membership_missing",
  "capability_forbidden",
  "workspace_restricted",
  "project_not_found",
  "session_expired",
  "workspace_membership_purged",
] as const;

describe("workflow stream reauthorization guard", () => {
  for (const error of revocations) {
    test(`closes with one safe control event when ${error}`, async () => {
      const events: unknown[] = [];
      let cleanups = 0;
      let closes = 0;
      const guard = createWorkflowStreamReauthorizationGuard({
        authorize: async () => ({ ok: false, error, requestId: "request-stream-1" }),
        onAuthorized: () => events.push({ event: "ping" }),
        onRevoked: (control) => events.push(control),
        cleanup: () => cleanups++,
        close: () => closes++,
        unexpectedControl: () => ({ error: "internal_error" }),
      });

      await Promise.all([guard.check(), guard.check(), guard.check()]);
      await guard.check();

      expect(events).toEqual([{ error, requestId: "request-stream-1" }]);
      expect(cleanups).toBe(1);
      expect(closes).toBe(1);
    });
  }

  test("serializes checks and emits a ping only after fresh authorization", async () => {
    let releases: (() => void) | null = null;
    let authorizations = 0;
    let pings = 0;
    const guard = createWorkflowStreamReauthorizationGuard({
      authorize: () => {
        authorizations++;
        return new Promise((resolve) => {
          releases = () => resolve({ ok: true });
        });
      },
      onAuthorized: () => pings++,
      onRevoked: () => {},
      cleanup: () => {},
      close: () => {},
      unexpectedControl: () => ({ error: "internal_error" }),
    });

    const checks = [guard.check(), guard.check(), guard.check()];
    expect(authorizations).toBe(1);
    releases?.();
    await Promise.all(checks);
    expect(pings).toBe(1);
  });

  test("converts an unexpected authorization failure to one bounded control event", async () => {
    const events: unknown[] = [];
    const guard = createWorkflowStreamReauthorizationGuard({
      authorize: async () => {
        throw new Error("private database failure");
      },
      onAuthorized: () => {},
      onRevoked: (control) => events.push(control),
      cleanup: () => {},
      close: () => {},
      unexpectedControl: () => ({
        error: "internal_error",
        requestId: "request-stream-2",
      }),
    });

    await guard.check();
    await guard.check();
    expect(events).toEqual([
      { error: "internal_error", requestId: "request-stream-2" },
    ]);
  });
});

const streamActor: ActorScope = {
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

describe("workflow stream fresh-policy integration", () => {
  test("refuses the initial route before allocating a stream", async () => {
    const policy = createAuthenticatedRequestPolicy({
      resolveActorScope: async () => null,
      resolveProject: async () => ({ kind: "missing" }),
      rateLimit: async () => ({ allowed: true }),
      createRequestId: () => "request-stream-initial",
      now: () => 1,
    });
    const result = await policy.execute({
      adapter: "stream",
      operationName: "open-workflow-progress-stream",
      admission: {
        kind: "project",
        capability: "content.view",
        projectId: "project-stream",
      },
      operation: async () => true,
    });
    expect(workflowStreamAuthorizationResult(result)).toEqual({
      ok: false,
      error: "authentication_required",
      requestId: "request-stream-initial",
    });
  });

  const changes = [
    {
      name: "session expiry",
      mutate: (state: { actor: ActorScope | null }) => {
        state.actor = null;
      },
      error: "authentication_required",
    },
    {
      name: "membership purge",
      mutate: (state: { actor: ActorScope | null }) => {
        state.actor = null;
      },
      error: "authentication_required",
    },
    {
      name: "Workspace restriction",
      mutate: (state: { actor: ActorScope | null }) => {
        state.actor = { ...streamActor, status: "restricted" };
      },
      error: "workspace_restricted",
    },
    {
      name: "role loss in a restricted Workspace",
      before: { ...streamActor, role: "owner", status: "restricted" } as ActorScope,
      mutate: (state: { actor: ActorScope | null }) => {
        state.actor = { ...streamActor, role: "viewer", status: "restricted" };
      },
      error: "workspace_restricted",
    },
  ] as const;

  for (const change of changes) {
    test(`revokes after fresh ${change.name} authorization`, async () => {
      const state: {
        actor: ActorScope | null;
        project: ProjectAdmissionResult;
      } = {
        actor: "before" in change ? change.before : streamActor,
        project: { kind: "active", projectId: "project-stream" },
      };
      let requestSequence = 0;
      const policy = createAuthenticatedRequestPolicy({
        resolveActorScope: async () => state.actor,
        resolveProject: async () => state.project,
        rateLimit: async () => ({ allowed: true }),
        createRequestId: () => `request-stream-policy-${++requestSequence}`,
        now: () => 1,
      });
      const authorize = async () =>
        workflowStreamAuthorizationResult(
          await policy.execute({
            adapter: "stream",
            operationName: "reauthorize-workflow-progress-stream",
            admission: {
              kind: "project",
              capability: "content.view",
              projectId: "project-stream",
            },
            operation: async () => true,
          }),
        );

      expect(await authorize()).toEqual({ ok: true });
      change.mutate(state);
      const controls: unknown[] = [];
      let cleanups = 0;
      const guard = createWorkflowStreamReauthorizationGuard({
        authorize,
        onAuthorized: () => {},
        onRevoked: (control) => controls.push(control),
        cleanup: () => cleanups++,
        close: () => {},
        unexpectedControl: () => ({ error: "internal_error" }),
      });
      await guard.check();
      await guard.check();
      expect(controls).toEqual([
        {
          error: change.error,
          requestId: "request-stream-policy-2",
        },
      ]);
      expect(cleanups).toBe(1);
    });
  }

  for (const projectChange of [
    { name: "Project access loss", result: { kind: "missing" } as const },
    { name: "Project expiry", result: { kind: "missing" } as const },
    { name: "Project purge", result: { kind: "missing" } as const },
    {
      name: "active Workspace mismatch",
      result: {
        kind: "workspace_mismatch",
        projectId: "project-stream",
        workspaceId: "workspace-other",
        workspaceName: "Other Workspace",
      } as const,
    },
  ]) {
    test(`revokes after fresh ${projectChange.name}`, async () => {
      let project: ProjectAdmissionResult = {
        kind: "active",
        projectId: "project-stream",
      };
      const policy = createAuthenticatedRequestPolicy({
        resolveActorScope: async () => streamActor,
        resolveProject: async () => project,
        rateLimit: async () => ({ allowed: true }),
        createRequestId: () => "request-stream-project",
        now: () => 1,
      });
      const authorize = async () =>
        workflowStreamAuthorizationResult(
          await policy.execute({
            adapter: "stream",
            operationName: "reauthorize-workflow-progress-stream",
            admission: {
              kind: "project",
              capability: "content.view",
              projectId: "project-stream",
            },
            operation: async () => true,
          }),
        );
      expect(await authorize()).toEqual({ ok: true });
      project = projectChange.result;
      const controls: unknown[] = [];
      const guard = createWorkflowStreamReauthorizationGuard({
        authorize,
        onAuthorized: () => {},
        onRevoked: (control) => controls.push(control),
        cleanup: () => {},
        close: () => {},
        unexpectedControl: () => ({ error: "internal_error" }),
      });
      await guard.check();
      expect(controls).toEqual([
        expect.objectContaining({
          error:
            projectChange.result.kind === "workspace_mismatch"
              ? "active_workspace_mismatch"
              : "project_not_found",
        }),
      ]);
    });
  }
});
