import { describe, expect, mock, test } from "bun:test";
import type { AppUser, WorkspaceActorContext } from "@narriflow/auth";
import { createRequestPolicyRuntime } from "../../http/request-policy-runtime";
import { createInventoryApp } from "../../test-app";
import { createWorkspaceRoutes, type WorkspaceRouteDeps } from "./routes";

const WEB = "http://localhost:3000";
const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const MEMBER = "00000000-0000-4000-8000-000000000010";
const INVITE = "00000000-0000-4000-8000-000000000020";
const user = { id: "user-1", clerkId: "clerk-1", primaryEmail: "o@example.com", firstName: "Olu", lastName: null, imageUrl: null } as AppUser;

function context(role: WorkspaceActorContext["role"]): WorkspaceActorContext {
  return {
    userId: user.id,
    workspaceId: WORKSPACE,
    workspaceName: "Team",
    workspaceOwnerUserId: user.id,
    role,
    status: "active",
    pricingTier: "business",
    isPersonal: false,
    workspaceSelectionChanged: false,
  };
}

function policy(options: { role?: WorkspaceActorContext["role"]; rate?: (key: string) => boolean } = {}) {
  return createRequestPolicyRuntime({
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer good"
        ? ({ status: "authenticated", identity: { clerkUserId: "clerk-1", sessionId: "s" } } as never)
        : ({ status: "unauthenticated", reason: "missing_credential" } as const),
    loadAppUser: async () => user,
    // Only the explicit, current selection resolves; there is never a fallback Workspace.
    resolveScopedWorkspace: async (_user, hint) => (hint === WORKSPACE ? context(options.role ?? "owner") : null),
    staffAllowlist: new Set(),
    policy: {
      resolveProject: async () => ({ kind: "inaccessible" }) as never,
      rateLimit: async ({ key }) => {
        const allowed = options.rate?.(key) ?? true;
        return allowed
          ? { allowed: true, availability: "available", limit: 60, remaining: 59, resetSeconds: 60 }
          : { allowed: false, availability: "available", limit: 60, remaining: 0, resetSeconds: 60, retryAfterSeconds: 30 };
      },
      now: () => 1_000,
    } as never,
  });
}

const issued = { id: INVITE, email: "new@example.com", role: "editor" as const, expiresAt: "2030-01-01T00:00:00.000Z" };

function deps(over: Partial<WorkspaceRouteDeps> = {}) {
  const base = {
    workspaceService: {
      getWorkspace: mock(async () => ({
        id: WORKSPACE, name: "Team", avatarStorageKey: null, status: "active", timezone: "UTC", pricingTier: "business",
        billingAccount: { billingInterval: "monthly", currentPeriodEndAt: new Date("2030-02-01T00:00:00Z") },
        personalOwnerUserId: null, createdAt: new Date("2029-01-01T00:00:00Z"),
      })),
      updateWorkspace: mock(async (_u: string, _w: string, input: { name: string; timezone?: string }) => ({ id: WORKSPACE, ...input })),
      getAvatarUrls: mock(async () => ({})),
      listMembers: mock(async () => ({
        members: [{ id: MEMBER, role: "editor", joinedAt: new Date("2029-03-01T00:00:00Z"), user: { id: "u2", primaryEmail: "e@example.com", firstName: null, lastName: null, imageUrl: null } }],
        invites: [{ id: INVITE, email: "i@example.com", role: "viewer", expiresAt: new Date("2030-01-01T00:00:00Z"), createdAt: new Date("2029-12-25T00:00:00Z") }],
      })),
      revokeInvite: mock(async () => undefined),
      presignAvatarUpload: mock(async () => ({ key: "k", uploadUrl: "u", contentType: "image/png" })),
      setAvatar: mock(async () => undefined),
    },
    workspaceMembershipService: {
      changeRole: mock(async (_a: string, _w: string, memberId: string, role: string) => ({ id: memberId, role })),
      removeMember: mock(async () => undefined),
    },
    workspaceCommands: {
      inviteMember: mock(async (_actor: unknown, _input: unknown, mutation: { beforeAccept?: () => Promise<void> }) => {
        await mutation.beforeAccept?.();
        return { invite: issued, token: "raw-token-value", replayed: false };
      }),
      resendInvite: mock(async () => ({ invite: issued, token: null, replayed: true })),
    },
    projectService: {
      getUsageSummary: mock(async () => ({
        tier: "business", usedCredits: 5, reservedCredits: 1, limitCredits: 100, remainingCredits: 94,
        periodStart: new Date("2030-01-01T00:00:00Z"), renewsAt: new Date("2030-02-01T00:00:00Z"),
        inFlight: 0, inFlightLimit: 4, maxUploadSeconds: 7200,
      })),
    },
    performanceService: { setGuidanceEnabled: mock(async () => undefined) },
    autoCensorService: {
      getWorkspaceWords: mock(async () => ({ words: ["a"], customized: false })),
      replaceWorkspaceWords: mock(async (_scope: unknown, words: string[]) => ({ words, customized: true })),
      resetWorkspaceWords: mock(async () => ({ words: ["a"], customized: false })),
    },
    listUserWorkspaces: mock(async () => [
      { role: "owner", workspace: { id: WORKSPACE, name: "Team", avatarStorageKey: null, personalOwnerUserId: null, status: "active", pricingTier: "business" } },
    ]),
    sendEmail: mock(async () => ({ sent: true })),
    webOrigin: WEB,
    ...over,
  };
  return base as unknown as WorkspaceRouteDeps & typeof base;
}

function app(routeDeps: WorkspaceRouteDeps, options: Parameters<typeof policy>[0] = {}) {
  return createInventoryApp({
    policyRuntime: policy(options),
    domains: { workspace: createWorkspaceRoutes(routeDeps) },
  });
}

const headers = (extra: Record<string, string> = {}) => ({
  authorization: "Bearer good",
  "x-workspace-id": WORKSPACE,
  origin: WEB,
  "content-type": "application/json",
  ...extra,
});

const send = (routeApp: ReturnType<typeof app>, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  routeApp.request(`/api${path}`, { method, headers: headers(extra), body: body === undefined ? undefined : JSON.stringify(body) });

describe("selection and capability", () => {
  test("a removed selection is refused before any service runs, never redirected to another Workspace", async () => {
    const d = deps();
    const response = await send(app(d), "PATCH", "/workspace", { name: "X", timezone: "UTC" }, { "x-workspace-id": "00000000-0000-4000-8000-0000000000ee" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "workspace_selection_changed" });
    expect(d.workspaceService.updateWorkspace).not.toHaveBeenCalled();
  });

  test.each([
    ["PATCH", "/workspace", { name: "X", timezone: "UTC" }],
    ["PATCH", "/workspace/performance-guidance", { enabled: true }],
    ["PUT", "/workspace/censor-words", { words: ["x"] }],
    ["DELETE", "/workspace/censor-words", undefined],
  ])("%s %s needs workspace.manage", async (method, path, body) => {
    const d = deps();
    const response = await send(app(d, { role: "editor" }), method, path, body);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "capability_denied" });
    expect(d.autoCensorService.replaceWorkspaceWords).not.toHaveBeenCalled();
    expect(d.workspaceService.updateWorkspace).not.toHaveBeenCalled();
  });

  test.each([
    ["POST", "/workspace/invites", { email: "a@example.com", role: "viewer" }],
    ["POST", `/workspace/invites/${INVITE}/resend`, undefined],
    ["DELETE", `/workspace/invites/${INVITE}`, undefined],
    ["PATCH", `/workspace/members/${MEMBER}`, { role: "viewer" }],
    ["DELETE", `/workspace/members/${MEMBER}`, undefined],
  ])("%s %s needs members.invite", async (method, path, body) => {
    const d = deps();
    const response = await send(app(d, { role: "viewer" }), method, path, body, { "idempotency-key": "k" });
    expect(response.status).toBe(403);
    expect(d.workspaceCommands.inviteMember).not.toHaveBeenCalled();
    expect(d.workspaceMembershipService.changeRole).not.toHaveBeenCalled();
    expect(d.workspaceMembershipService.removeMember).not.toHaveBeenCalled();
  });

  test("a viewer can read the profile, members and usage", async () => {
    const routeApp = app(deps(), { role: "viewer" });
    for (const path of ["/workspace", "/workspace/members", "/workspace/usage", "/workspace/censor-words", "/workspace/bootstrap"]) {
      expect((await send(routeApp, "GET", path)).status).toBe(200);
    }
  });
});

describe("reads", () => {
  test("bootstrap returns the shell facts as JSON-safe values and the admitted Workspace header", async () => {
    const response = await send(app(deps()), "GET", "/workspace/bootstrap");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-workspace-id")).toBe(WORKSPACE);
    const body = await response.json();
    expect(body.workspace).toMatchObject({ id: WORKSPACE, role: "owner", status: "active", pricingTier: "business" });
    expect(body.usage).toMatchObject({ usedCredits: 5, periodStart: "2030-01-01T00:00:00.000Z", renewsAt: "2030-02-01T00:00:00.000Z" });
    expect(body.capabilities["members.invite"]).toBe(true);
    expect(body.memberships).toHaveLength(1);
  });

  test("profile and members project dates to ISO strings", async () => {
    const routeApp = app(deps());
    const profile = await (await send(routeApp, "GET", "/workspace")).json();
    expect(profile).toMatchObject({ timezone: "UTC", billingInterval: "monthly", currentPeriodEndAt: "2030-02-01T00:00:00.000Z", createdAt: "2029-01-01T00:00:00.000Z" });
    const members = await (await send(routeApp, "GET", "/workspace/members")).json();
    expect(members.members[0].joinedAt).toBe("2029-03-01T00:00:00.000Z");
    expect(members.invites[0]).toMatchObject({ expiresAt: "2030-01-01T00:00:00.000Z", createdAt: "2029-12-25T00:00:00.000Z" });
  });
});

describe("invites", () => {
  const body = { email: "new@example.com", role: "editor" };

  test("an invite needs an Idempotency-Key", async () => {
    const d = deps();
    const response = await send(app(d), "POST", "/workspace/invites", body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "idempotency_key_required" });
    expect(d.workspaceCommands.inviteMember).not.toHaveBeenCalled();
  });

  test("the first acceptance emails a web-origin link, once, keyed by the invite", async () => {
    const d = deps();
    const response = await send(app(d), "POST", "/workspace/invites", body, { "idempotency-key": "intent-1" });
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result.inviteUrl).toBe(`${WEB}/invite/raw-token-value`);
    expect(result.emailSent).toBe(true);
    expect(result.replayed).toBe(false);
    expect(d.sendEmail).toHaveBeenCalledTimes(1);
    const email = (d.sendEmail.mock.calls[0] as unknown as [{ idempotencyKey: string; to: string }])[0];
    expect(email.idempotencyKey).toBe(`workspace-invite/${INVITE}`);
    expect(email.to).toBe("new@example.com");
    // Attribution is the acting member, in the selected Workspace, with the caller's key.
    const call = d.workspaceCommands.inviteMember.mock.calls[0] as unknown as [{ actorUserId: string; workspaceId: string }, unknown, { clientIdempotencyKey: string }];
    expect(call[0]).toMatchObject({ actorUserId: "user-1", workspaceId: WORKSPACE });
    expect(call[2].clientIdempotencyKey).toBe("intent-1");
  });

  test("a replay never sends again and carries no link", async () => {
    const d = deps();
    const response = await send(app(d), "POST", `/workspace/invites/${INVITE}/resend`, undefined, { "idempotency-key": "intent-2" });
    expect(response.status).toBe(200);
    expect(response.headers.get("idempotent-replayed")).toBe("true");
    expect(await response.json()).toMatchObject({ inviteUrl: null, emailSent: null, replayed: true });
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  test("a failed email is reported without failing the accepted invite or leaking the token", async () => {
    const warn = mock(() => undefined);
    const original = console.warn;
    console.warn = warn;
    try {
      const d = deps({ sendEmail: mock(async () => { throw new Error("provider down https://x?token=raw-token-value"); }) as never });
      const response = await send(app(d), "POST", "/workspace/invites", body, { "idempotency-key": "intent-3" });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ emailSent: false });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("raw-token-value");
    } finally {
      console.warn = original;
    }
  });

  test("an exhausted limiter refuses new work but never a replay", async () => {
    const exhausted = { rate: () => false };
    const replayDeps = deps({
      workspaceCommands: {
        // A replay never reaches the new-mutation limiter.
        inviteMember: mock(async () => ({ invite: issued, token: null, replayed: true })),
        resendInvite: mock(async () => ({ invite: issued, token: null, replayed: true })),
      } as never,
    });
    const replay = await send(app(replayDeps, exhausted), "POST", "/workspace/invites", body, { "idempotency-key": "intent-1" });
    expect(replay.status).toBe(200);

    const fresh = await send(app(deps(), exhausted), "POST", "/workspace/invites", body, { "idempotency-key": "intent-4" });
    expect(fresh.status).toBe(429);
    expect(await fresh.json()).toMatchObject({ error: "rate_limited" });
  });

  test("validates the body and the path id", async () => {
    const routeApp = app(deps());
    const badRole = await send(routeApp, "POST", "/workspace/invites", { email: "a@example.com", role: "owner" }, { "idempotency-key": "k" });
    expect(badRole.status).toBe(400);
    expect(await badRole.json()).toMatchObject({ error: "invalid_input" });
    expect((await send(routeApp, "DELETE", "/workspace/invites/not-a-uuid")).status).toBe(400);
  });
});

describe("members, settings and censor words", () => {
  test("role changes and removals act as the signed-in member in the selected Workspace", async () => {
    const d = deps();
    const routeApp = app(d);
    const changed = await send(routeApp, "PATCH", `/workspace/members/${MEMBER}`, { role: "admin" });
    expect(await changed.json()).toEqual({ id: MEMBER, role: "admin" });
    expect(d.workspaceMembershipService.changeRole).toHaveBeenCalledWith("user-1", WORKSPACE, MEMBER, "admin");
    expect((await send(routeApp, "DELETE", `/workspace/members/${MEMBER}`)).status).toBe(200);
    expect(d.workspaceMembershipService.removeMember).toHaveBeenCalledWith("user-1", WORKSPACE, MEMBER);
    expect((await send(routeApp, "PATCH", `/workspace/members/${MEMBER}`, { role: "owner" })).status).toBe(400);
  });

  test("settings validate the timezone and name", async () => {
    const routeApp = app(deps());
    const ok = await send(routeApp, "PATCH", "/workspace", { name: "  New  ", timezone: "Europe/Paris" });
    expect(await ok.json()).toMatchObject({ name: "New", timezone: "Europe/Paris" });
    expect((await send(routeApp, "PATCH", "/workspace", { name: "New", timezone: "Mars/Base" })).status).toBe(400);
    expect((await send(routeApp, "PATCH", "/workspace", { name: "", timezone: "UTC" })).status).toBe(400);
  });

  test("censor words are de-duplicated on replace and reset to defaults on delete", async () => {
    const d = deps();
    const routeApp = app(d);
    const saved = await (await send(routeApp, "PUT", "/workspace/censor-words", { words: ["Heck", "heck", " darn "] })).json();
    expect(saved.words).toEqual(["Heck", "darn"]);
    expect(await (await send(routeApp, "DELETE", "/workspace/censor-words")).json()).toEqual({ words: ["a"], customized: false });
    expect((await send(routeApp, "PUT", "/workspace/censor-words", { words: ["x".repeat(500)] })).status).toBe(400);
  });

  test("the performance-guidance switch takes a boolean", async () => {
    const d = deps();
    const routeApp = app(d);
    expect(await (await send(routeApp, "PATCH", "/workspace/performance-guidance", { enabled: true })).json()).toEqual({ enabled: true });
    expect(d.performanceService.setGuidanceEnabled).toHaveBeenCalledTimes(1);
    expect((await send(routeApp, "PATCH", "/workspace/performance-guidance", { enabled: "on" })).status).toBe(400);
  });

  test("avatar routes keep working behind shared validation", async () => {
    const routeApp = app(deps());
    expect((await send(routeApp, "POST", "/workspace/avatar/presign", { contentType: "image/png", sizeBytes: 100 })).status).toBe(200);
    expect((await send(routeApp, "PATCH", "/workspace/avatar", { storageKey: null })).status).toBe(200);
    expect((await send(routeApp, "PATCH", "/workspace/avatar", {})).status).toBe(400);
  });
});
