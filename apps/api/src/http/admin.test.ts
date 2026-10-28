import { describe, expect, test } from "bun:test";
import type { AppUser, WorkspaceActorContext } from "@narriflow/auth";
import { Hono } from "hono";
import {
  AdminAuditRequiredError,
  type AdminAuditEntry,
  createAdminRoutes,
  getPlatformActor,
} from "./admin";
import { installRequestPolicy, requireAdmissionDeclaration } from "./admission";
import type { ApiEnv } from "./env";
import { apiErrorHandler, apiNotFoundHandler, errorEnvelopeMiddleware } from "./errors";
import { apiRequestId } from "./logging";
import type { RateLimitCheck } from "./request-policy";
import { createRequestPolicyRuntime } from "./request-policy-runtime";

const IDENTITIES: Record<string, string> = {
  "Bearer staff": "clerk-staff",
  "Bearer workspace-admin": "clerk-workspace-admin",
};

function build(options: {
  audit?: { entries: AdminAuditEntry[]; fail?: boolean };
  rateLimit?: (input: { key: string; limit: number; windowSeconds: number }) => RateLimitCheck;
} = {}) {
  const limits: Array<{ key: string; limit: number }> = [];
  const rateLimit = async (input: { key: string; limit: number; windowSeconds: number }) => {
    limits.push({ key: input.key, limit: input.limit });
    return options.rateLimit?.(input) ?? { allowed: true };
  };
  const runtime = createRequestPolicyRuntime({
    authenticate: async (request) => {
      const clerkUserId = IDENTITIES[request.headers.get("authorization") ?? ""];
      return clerkUserId
        ? ({ status: "authenticated", identity: { clerkUserId, sessionId: "s" } } as never)
        : ({ status: "unauthenticated", reason: "missing_credential" } as const);
    },
    // A Workspace admin has real Workspace privileges, which must not confer staff.
    loadAppUser: async () => ({ id: "user" }) as AppUser,
    resolveScopedWorkspace: async () => ({ role: "admin", userId: "user" }) as WorkspaceActorContext,
    staffAllowlist: new Set(["clerk-staff"]),
    policy: { resolveProject: async () => ({ kind: "missing" }), rateLimit, now: () => 0 },
  });
  const admin = createAdminRoutes({
    rateLimit,
    audit: options.audit
      ? {
          record: async (entry) => {
            if (options.audit?.fail) throw new Error("audit store down");
            options.audit?.entries.push(entry);
          },
        }
      : undefined,
    now: () => new Date("2026-10-29T00:00:00.000Z"),
  });
  const app = new Hono<ApiEnv>();
  app.use("*", apiRequestId());
  app.use("*", errorEnvelopeMiddleware());
  app.onError(apiErrorHandler);
  app.notFound(apiNotFoundHandler);
  app.use("*", installRequestPolicy(runtime));
  app.use("*", requireAdmissionDeclaration());
  return { app, admin, limits, mount: () => app.route("/api/admin", admin.app) };
}

const call = (app: Hono<ApiEnv>, path: string, token: string | null, method = "GET") =>
  app.request(path, {
    method,
    headers: {
      ...(token ? { authorization: token } : {}),
      "x-workspace-id": "workspace-a",
      "x-request-id": "admin-request-1",
    },
  });

describe("reserved /api/admin group", () => {
  test("a staff request reaches the guard and answers 404 because no operations ship", async () => {
    const { app, mount } = build();
    mount();
    const response = await call(app, "/api/admin/anything", "Bearer staff");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_found", requestId: "admin-request-1" });
  });

  test("a Workspace Admin is not staff, even with an explicit Workspace selection", async () => {
    const { app, mount } = build();
    mount();
    const response = await call(app, "/api/admin/anything", "Bearer workspace-admin");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "staff_required" });
  });

  test("an unauthenticated request is a 401", async () => {
    const { app, mount } = build();
    mount();
    expect((await call(app, "/api/admin/anything", null)).status).toBe(401);
  });

  test("staff identity cannot be asserted through headers or metadata", async () => {
    const { app, mount } = build();
    mount();
    const response = await app.request("/api/admin/anything", {
      headers: {
        authorization: "Bearer workspace-admin",
        "x-platform-staff": "true",
        "x-clerk-user-id": "clerk-staff",
        "x-workspace-role": "staff",
      },
    });
    expect(response.status).toBe(403);
  });

  test("applies the 60/min read and 10/min mutation buckets keyed by the staff identity", async () => {
    const entries: AdminAuditEntry[] = [];
    const { app, admin, limits, mount } = build({ audit: { entries } });
    admin.read("/status", (c) => c.json({ staff: getPlatformActor(c).clerkUserId }));
    admin.mutation(
      { method: "POST", path: "/flags", action: "flags.toggle", target: () => "flag-1" },
      (c) => c.json({ ok: true }),
    );
    mount();
    await call(app, "/api/admin/status", "Bearer staff");
    await call(app, "/api/admin/flags", "Bearer staff", "POST");
    expect(limits).toEqual([
      { key: "api-admin-read:clerk-staff", limit: 60 },
      { key: "api-admin-mutation:clerk-staff", limit: 10 },
    ]);
  });

  test("an exhausted staff bucket is a 429", async () => {
    const { app, mount } = build({ rateLimit: () => ({ allowed: false, retryAfterSeconds: 9 }) });
    mount();
    const response = await call(app, "/api/admin/anything", "Bearer staff");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("9");
  });
});

describe("admin mutations require a durable audit", () => {
  test("registration without an injected audit is refused", () => {
    const { admin } = build();
    expect(() =>
      admin.mutation(
        { method: "POST", path: "/suspend", action: "workspace.suspend", target: () => "ws" },
        (c) => c.json({}),
      ),
    ).toThrow(AdminAuditRequiredError);
  });

  test("records staff actor, action, target, request ID, outcome and time", async () => {
    const entries: AdminAuditEntry[] = [];
    const { app, admin, mount } = build({ audit: { entries } });
    admin.mutation(
      { method: "POST", path: "/suspend", action: "workspace.suspend", target: () => "workspace-9" },
      (c) => c.json({ ok: true }),
    );
    admin.mutation(
      { method: "POST", path: "/refuse", action: "workspace.refuse", target: () => "workspace-9" },
      (c) => c.json({ error: "no" }, 409),
    );
    admin.mutation(
      { method: "POST", path: "/explode", action: "workspace.explode", target: () => "workspace-9" },
      () => {
        throw new Error("boom");
      },
    );
    mount();
    expect((await call(app, "/api/admin/suspend", "Bearer staff", "POST")).status).toBe(200);
    expect((await call(app, "/api/admin/refuse", "Bearer staff", "POST")).status).toBe(409);
    expect((await call(app, "/api/admin/explode", "Bearer staff", "POST")).status).toBe(500);
    expect(entries).toEqual([
      {
        staffClerkUserId: "clerk-staff",
        action: "workspace.suspend",
        target: "workspace-9",
        requestId: "admin-request-1",
        outcome: "succeeded",
        occurredAt: new Date("2026-10-29T00:00:00.000Z"),
      },
      expect.objectContaining({ action: "workspace.refuse", outcome: "refused" }),
      expect.objectContaining({ action: "workspace.explode", outcome: "failed" }),
    ]);
  });

  test("an unwritable audit makes the mutation fail rather than report success", async () => {
    const { app, admin, mount } = build({ audit: { entries: [], fail: true } });
    admin.mutation(
      { method: "POST", path: "/suspend", action: "workspace.suspend", target: () => "ws" },
      (c) => c.json({ ok: true }),
    );
    mount();
    const response = await call(app, "/api/admin/suspend", "Bearer staff", "POST");
    expect(response.status).toBe(500);
  });

  test("a non-staff caller never reaches a registered mutation or its audit", async () => {
    const entries: AdminAuditEntry[] = [];
    let ran = false;
    const { app, admin, mount } = build({ audit: { entries } });
    admin.mutation(
      { method: "POST", path: "/suspend", action: "workspace.suspend", target: () => "ws" },
      (c) => {
        ran = true;
        return c.json({});
      },
    );
    mount();
    const response = await call(app, "/api/admin/suspend", "Bearer workspace-admin", "POST");
    expect(response.status).toBe(403);
    expect(ran).toBe(false);
    expect(entries).toEqual([]);
  });
});
