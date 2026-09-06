import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  AuthenticatedRequestFailure,
  AuthenticatedRequestUnexpectedError,
  createAuthenticatedRequestPolicy,
  type ActorScope,
  type AuthenticatedRequestPolicyDependencies,
} from "./authenticated-request-policy";

const actorScope: ActorScope = {
  actorUserId: "actor-user",
  workspaceId: "workspace-a",
  workspaceName: "Workspace A",
  workspaceOwnerUserId: "owner-user",
  role: "editor",
  status: "active",
  pricingTier: "pro",
  isPersonalWorkspace: false,
  workspaceSelectionChanged: false,
};

function makeDependencies(
  overrides: Partial<AuthenticatedRequestPolicyDependencies> = {},
): AuthenticatedRequestPolicyDependencies {
  return {
    resolveActorScope: async () => actorScope,
    resolveProject: async () => ({ kind: "active", projectId: "project-a" }),
    rateLimit: async () => ({ allowed: true }),
    createRequestId: () => "request-1",
    now: () => 1_000,
    ...overrides,
  };
}

describe("Authenticated Request Policy", () => {
  test("admits identity-only requests without resolving an active Workspace", async () => {
    const diagnostics: Array<Record<string, unknown>> = [];
    const dependencies: AuthenticatedRequestPolicyDependencies<{
      actorUserId: string;
      clerkId: string;
    }> = {
      resolveActorScope: async () => ({
        actorUserId: "actor-user",
        clerkId: "clerk-user",
      }),
      resolveProject: async () => {
        throw new Error("Project admission must not run");
      },
      rateLimit: async () => ({ allowed: true }),
      createRequestId: () => "identity-request",
      now: () => 1_000,
      recordDiagnostic: (value) => diagnostics.push(value),
    };
    const policy = createAuthenticatedRequestPolicy(dependencies);

    const result = await policy.execute({
      adapter: "server_action",
      operationName: "identity-bootstrap",
      admission: { kind: "signed_in" },
      operation: async ({ actor }) => actor.clerkId,
    });

    expect(result).toEqual({
      ok: true,
      requestId: "identity-request",
      value: "clerk-user",
    });
    expect(diagnostics).toEqual([
      expect.not.objectContaining({ workspaceId: expect.anything() }),
    ]);
  });

  test("enforces the complete role, Workspace-status, and capability matrix", async () => {
    const capabilities = [
      "content.view",
      "content.download",
      "content.edit",
      "processing.consume",
      "publishing.manage",
      "brand.manage",
      "social.manage",
      "workspace.manage",
      "api.manage",
      "members.invite",
      "members.promote_admin",
      "billing.manage",
    ] as const;
    const activeByRole = {
      owner: new Set(capabilities),
      admin: new Set(
        capabilities.filter(
          (value) =>
            value !== "billing.manage" && value !== "members.promote_admin",
        ),
      ),
      editor: new Set([
        "content.view",
        "content.download",
        "content.edit",
        "processing.consume",
        "publishing.manage",
        "brand.manage",
        "api.manage",
      ]),
      viewer: new Set(["content.view", "content.download"]),
    } as const;
    const ownerByStatus = {
      pending_payment: new Set([
        "content.view",
        "content.download",
        "workspace.manage",
        "billing.manage",
      ]),
      restricted: new Set([
        "content.view",
        "content.download",
        "billing.manage",
        "members.invite",
      ]),
    } as const;

    for (const role of ["owner", "admin", "editor", "viewer"] as const) {
      for (const status of [
        "active",
        "pending_payment",
        "restricted",
      ] as const) {
        for (const capability of capabilities) {
          const roleAllows = activeByRole[role].has(capability as never);
          const expected =
            status === "active"
              ? roleAllows
              : role === "owner" &&
                ownerByStatus[status].has(capability as never);
          const policy = createAuthenticatedRequestPolicy(
            makeDependencies({
              resolveActorScope: async () => ({ ...actorScope, role, status }),
            }),
          );
          const result = await policy.execute({
            adapter: "page",
            operationName: `${role}-${status}-${capability}`,
            admission: { kind: "workspace", capability },
            operation: async () => true,
          });
          expect(result.ok).toBe(expected);
          if (!expected && !result.ok) {
            expect(result.failure.code).toBe(
              roleAllows ? "workspace_restricted" : "capability_denied",
            );
          }
        }
      }
    }
  });

  test("keeps actor and Workspace owner identity distinct through the operation", async () => {
    const policy = createAuthenticatedRequestPolicy(makeDependencies());

    const result = await policy.execute({
      adapter: "hono",
      operationName: "audit-aware-operation",
      admission: { kind: "workspace", capability: "content.edit" },
      operation: async ({ actor }) => ({
        actorUserId: actor.actorUserId,
        workspaceOwnerUserId: actor.workspaceOwnerUserId,
      }),
    });

    expect(result).toEqual({
      ok: true,
      requestId: "request-1",
      value: {
        actorUserId: "actor-user",
        workspaceOwnerUserId: "owner-user",
      },
    });
  });

  test("runs authentication, capability, rate limit, Project, input, then operation", async () => {
    const calls: string[] = [];
    const policy = createAuthenticatedRequestPolicy(
      makeDependencies({
        resolveActorScope: async () => {
          calls.push("authentication-and-workspace");
          return actorScope;
        },
        rateLimit: async () => {
          calls.push("rate-limit");
          return { allowed: true };
        },
        resolveProject: async () => {
          calls.push("project");
          return { kind: "active", projectId: "project-a" };
        },
      }),
    );

    const result = await policy.execute({
      adapter: "hono",
      operationName: "ordered-operation",
      admission: {
        kind: "project",
        capability: "processing.consume",
        projectId: "project-a",
      },
      rateLimit: {
        key: ({ actorUserId }) => {
          calls.push(`rate-key:${actorUserId}`);
          return "generation:actor-user";
        },
        limit: 10,
        windowSeconds: 60,
      },
      input: {
        load: async () => {
          calls.push("input");
          return { title: "A clip" };
        },
        schema: z.object({ title: z.string() }).strict(),
      },
      operation: async ({ input }) => {
        calls.push("operation");
        return input.title;
      },
    });

    expect(result).toMatchObject({ ok: true, value: "A clip" });
    expect(calls).toEqual([
      "authentication-and-workspace",
      "rate-key:actor-user",
      "rate-limit",
      "project",
      "input",
      "operation",
    ]);
  });

  test("forbidden requests do not rate-limit, resolve a Project, parse, or run domain work", async () => {
    const calls: string[] = [];
    const policy = createAuthenticatedRequestPolicy(
      makeDependencies({
        resolveActorScope: async () => ({ ...actorScope, role: "viewer" }),
        rateLimit: async () => {
          calls.push("rate-limit");
          return { allowed: true };
        },
        resolveProject: async () => {
          calls.push("project");
          return { kind: "active", projectId: "project-a" };
        },
      }),
    );

    const result = await policy.execute({
      adapter: "server_action",
      operationName: "forbidden-operation",
      admission: {
        kind: "project",
        capability: "processing.consume",
        projectId: "project-a",
      },
      rateLimit: {
        key: () => "generation:actor-user",
        limit: 10,
        windowSeconds: 60,
      },
      input: {
        load: async () => {
          calls.push("input");
          return {};
        },
        schema: z.object({}).strict(),
      },
      operation: async () => {
        calls.push("operation");
        return null;
      },
    });

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "capability_denied", status: 403 },
    });
    expect(calls).toEqual([]);
  });

  test("conceals inaccessible Projects but exposes an entitled Workspace mismatch", async () => {
    const missingPolicy = createAuthenticatedRequestPolicy(
      makeDependencies({
        resolveProject: async () => ({ kind: "missing" }),
      }),
    );
    const mismatchPolicy = createAuthenticatedRequestPolicy(
      makeDependencies({
        resolveProject: async () => ({
          kind: "workspace_mismatch",
          projectId: "project-a",
          workspaceId: "workspace-b",
          workspaceName: "Workspace B",
        }),
      }),
    );
    const request = {
      adapter: "page" as const,
      operationName: "open-project",
      admission: {
        kind: "project" as const,
        capability: "content.view" as const,
        projectId: "project-a",
      },
      operation: async () => "opened",
    };

    await expect(missingPolicy.execute(request)).resolves.toMatchObject({
      ok: false,
      failure: { code: "project_not_found", status: 404 },
    });
    await expect(mismatchPolicy.execute(request)).resolves.toMatchObject({
      ok: false,
      failure: {
        code: "active_workspace_mismatch",
        status: 409,
        details: { workspaceId: "workspace-b", workspaceName: "Workspace B" },
      },
    });
  });

  test("bounds validation details and never runs the operation for invalid input", async () => {
    let operated = false;
    const policy = createAuthenticatedRequestPolicy(makeDependencies());

    const result = await policy.execute({
      adapter: "hono",
      operationName: "strict-input",
      admission: { kind: "workspace", capability: "content.edit" },
      input: {
        load: async () => ({ title: 42, ownerUserId: "forged" }),
        schema: z.object({ title: z.string() }).strict(),
      },
      operation: async () => {
        operated = true;
        return null;
      },
    });

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: "invalid_input",
        status: 400,
        issues: [
          { path: ["title"], code: "invalid_type" },
          { path: [], code: "unrecognized_keys" },
        ],
      },
    });
    expect(operated).toBe(false);
  });

  test("returns typed expected failures and lets unknown exceptions escape", async () => {
    const policy = createAuthenticatedRequestPolicy(makeDependencies());

    const expected = await policy.execute({
      adapter: "hono",
      operationName: "known-domain-failure",
      admission: { kind: "workspace", capability: "content.edit" },
      operation: async () => {
        throw new AuthenticatedRequestFailure({
          code: "revision_conflict",
          category: "conflict",
          status: 409,
          message: "The clip changed. Refresh and try again.",
        });
      },
    });
    expect(expected).toMatchObject({
      ok: false,
      requestId: "request-1",
      failure: {
        code: "revision_conflict",
        status: 409,
        requestId: "request-1",
      },
    });

    await expect(
      policy.execute({
        adapter: "hono",
        operationName: "bug",
        admission: { kind: "workspace", capability: "content.view" },
        operation: async () => {
          throw new Error("private database detail");
        },
      }),
    ).rejects.toBeInstanceOf(AuthenticatedRequestUnexpectedError);
  });

  test("bounds rate-limit recovery and records safe diagnostics for every disposition", async () => {
    const diagnostics: unknown[] = [];
    let now = 100;
    const policy = createAuthenticatedRequestPolicy(
      makeDependencies({
        rateLimit: async () => ({ allowed: false, retryAfterSeconds: 2.2 }),
        now: () => now++,
        recordDiagnostic: (value) => diagnostics.push(value),
      }),
    );
    const result = await policy.execute({
      adapter: "server_action",
      operationName: "rate-limited-action",
      admission: { kind: "workspace", capability: "content.edit" },
      rateLimit: {
        key: ({ actorUserId }) => `edit:${actorUserId}`,
        limit: 2,
        windowSeconds: 60,
      },
      operation: async () => true,
    });
    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: "rate_limited",
        retryAfterSeconds: 3,
        requestId: "request-1",
      },
    });
    expect(diagnostics).toEqual([
      expect.objectContaining({
        requestId: "request-1",
        adapter: "server_action",
        operationName: "rate-limited-action",
        failureCode: "rate_limited",
        actorUserId: "actor-user",
        workspaceId: "workspace-a",
        disposition: "refused",
      }),
    ]);
  });

  test("classifies a normalized adapter error response before recording diagnostics", async () => {
    const diagnostics: unknown[] = [];
    const policy = createAuthenticatedRequestPolicy({
      ...makeDependencies(),
      recordDiagnostic: (value) => diagnostics.push(value),
    });

    const result = await policy.execute({
      adapter: "hono",
      operationName: "POST /projects/:id/generate",
      admission: { kind: "workspace", capability: "content.view" },
      operation: async () => Response.json({ error: "quota_exceeded" }, { status: 402 }),
      diagnoseResult: async (response) => ({
        disposition: response.status >= 500 ? "failed" : "refused",
        failureCode: "quota_exceeded",
        status: response.status,
      }),
    });

    expect(result.ok).toBe(true);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        disposition: "refused",
        failureCode: "quota_exceeded",
        status: 402,
      }),
    ]);
  });

  test("wraps dependency failures with the same request identifier without exposing their message", async () => {
    const diagnostics: unknown[] = [];
    const policy = createAuthenticatedRequestPolicy(
      makeDependencies({
        resolveActorScope: async () => {
          throw new Error("private provider token");
        },
        recordDiagnostic: (value) => diagnostics.push(value),
      }),
    );

    try {
      await policy.execute({
        adapter: "hono",
        operationName: "actor-resolution-failure",
        admission: { kind: "signed_in" },
        operation: async () => true,
      });
      throw new Error("expected policy to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AuthenticatedRequestUnexpectedError);
      expect((error as AuthenticatedRequestUnexpectedError).requestId).toBe(
        "request-1",
      );
      expect((error as Error).message).not.toContain("private provider token");
    }
    expect(diagnostics).toEqual([
      expect.objectContaining({
        failureCode: "internal_error",
        disposition: "failed",
      }),
    ]);
  });

  test("preserves framework control-flow exceptions for the transport", async () => {
    const frameworkSignal = new Error("framework-control-flow");
    const policy = createAuthenticatedRequestPolicy(
      makeDependencies({
        resolveActorScope: async () => {
          throw frameworkSignal;
        },
        rethrowFrameworkControlFlow: (error) => {
          if (error === frameworkSignal) throw error;
        },
      }),
    );
    await expect(
      policy.execute({
        adapter: "page",
        operationName: "dynamic-page",
        admission: { kind: "signed_in" },
        operation: async () => true,
      }),
    ).rejects.toBe(frameworkSignal);
  });
});
