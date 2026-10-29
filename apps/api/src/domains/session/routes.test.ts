import { describe, expect, mock, test } from "bun:test";
import type { AppUser, WorkspaceActorContext } from "@narriflow/auth";
import { WorkspaceOperationError } from "@narriflow/services";
import { createRequestPolicyRuntime } from "../../http/request-policy-runtime";
import { createInventoryApp } from "../../test-app";
import { createSessionRoutes, type SessionRouteDeps } from "./routes";

const WEB = "http://localhost:3000";
const PERSONAL = "00000000-0000-4000-8000-000000000001";
const RESTRICTED = "00000000-0000-4000-8000-000000000002";
const user = {
  id: "user-1",
  clerkId: "clerk-1",
  primaryEmail: "member@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  imageUrl: null,
} as AppUser;

function context(workspaceId: string, over: Partial<WorkspaceActorContext> = {}): WorkspaceActorContext {
  return {
    userId: user.id,
    workspaceId,
    workspaceName: workspaceId === PERSONAL ? "Personal" : "Team",
    workspaceOwnerUserId: user.id,
    role: "owner",
    status: "active",
    pricingTier: "creator",
    isPersonal: workspaceId === PERSONAL,
    workspaceSelectionChanged: false,
    ...over,
  };
}

function policy() {
  return createRequestPolicyRuntime({
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer good"
        ? ({ status: "authenticated", identity: { clerkUserId: "clerk-1", sessionId: "s" } } as never)
        : ({ status: "unauthenticated", reason: "missing_credential" } as const),
    loadAppUser: async () => user,
    // A signed-in-only route must never need a selected Workspace.
    resolveScopedWorkspace: async () => {
      throw new Error("session routes must not resolve a scoped Workspace");
    },
    staffAllowlist: new Set(),
    policy: {
      resolveProject: async () => ({ kind: "inaccessible" }) as never,
      rateLimit: async () => ({ allowed: true }),
      now: () => 1_000,
    },
  });
}

function deps(over: Partial<SessionRouteDeps> = {}): SessionRouteDeps {
  return {
    resolveWorkspaceContext: mock(async (_user, hint) =>
      hint === RESTRICTED
        ? context(RESTRICTED, { status: "restricted", pricingTier: "business" })
        : context(PERSONAL, { workspaceSelectionChanged: hint !== undefined }),
    ),
    selectWorkspaceForActor: mock(async (_userId, workspaceId) =>
      workspaceId === RESTRICTED || workspaceId === PERSONAL ? context(workspaceId) : null,
    ),
    listUserWorkspaces: mock(async () => [
      { role: "owner", workspace: { id: PERSONAL, name: "Personal", avatarStorageKey: null, personalOwnerUserId: user.id, status: "active", pricingTier: "free" } },
      { role: "editor", workspace: { id: RESTRICTED, name: "Team", avatarStorageKey: null, personalOwnerUserId: null, status: "restricted", pricingTier: "business" } },
    ]) as never,
    workspaceService: {
      getAvatarUrls: mock(async () => ({})),
      getInvitePreview: mock(async (token: string) =>
        token === "t".repeat(24)
          ? { email: "member@example.com", role: "editor", expiresAt: new Date("2030-01-01T00:00:00Z"), workspace: { name: "Team", status: "active" } }
          : null,
      ),
    } as never,
    workspaceMembershipService: {
      acceptInvite: mock(async () => ({ workspaceId: RESTRICTED, workspaceName: "Team", role: "editor" })),
    } as never,
    projectService: {
      getUsageSummary: mock(async () => ({
        tier: "creator",
        usedCredits: 5,
        reservedCredits: 1,
        limitCredits: 100,
        remainingCredits: 94,
        periodStart: new Date("2030-01-01T00:00:00Z"),
        renewsAt: new Date("2030-02-01T00:00:00Z"),
        inFlight: 0,
        inFlightLimit: 2,
        maxUploadSeconds: 600,
      })),
    } as never,
    authContinuation: { issuerUrl: "https://clerk.example.com", consentOrigin: null },
    ...over,
  };
}

function app(routeDeps = deps()) {
  return createInventoryApp({
    policyRuntime: policy(),
    domains: { session: createSessionRoutes(routeDeps) },
  });
}

const headers = (extra: Record<string, string> = {}) => ({
  authorization: "Bearer good",
  origin: WEB,
  "content-type": "application/json",
  ...extra,
});

describe("GET /api/session/bootstrap", () => {
  test("requires a signed-in session", async () => {
    const response = await app().request("/api/session/bootstrap", { headers: { origin: WEB } });
    expect(response.status).toBe(401);
  });

  test("provisions identity, lists every membership with its status and reports the effective selection", async () => {
    const response = await app().request("/api/session/bootstrap", {
      headers: headers({ "x-workspace-id": RESTRICTED }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-workspace-id")).toBe(RESTRICTED);
    const body = await response.json();
    expect(body.user).toEqual({ id: "user-1", email: "member@example.com", firstName: "Ada", lastName: "Lovelace", imageUrl: null });
    expect(body.memberships.map((m: { id: string; status: string }) => [m.id, m.status])).toEqual([
      [PERSONAL, "active"],
      [RESTRICTED, "restricted"],
    ]);
    // A restricted owner keeps billing and content.view but cannot create content.
    expect(body.selection).toEqual({ workspaceId: RESTRICTED, workspaceSelectionChanged: false });
    expect(body.capabilities["billing.manage"]).toBe(true);
    expect(body.capabilities["content.edit"]).toBe(false);
    expect(body.authContinuation).toEqual({ issuerUrl: "https://clerk.example.com", consentOrigin: null });
    expect(JSON.stringify(body)).not.toContain("clerk-1");
  });

  test("carries the effective Workspace's credits so the shell needs no second request", async () => {
    const routeDeps = deps();
    const response = await app(routeDeps).request("/api/session/bootstrap", { headers: headers({ "x-workspace-id": PERSONAL }) });
    const body = await response.json();
    expect(body.usage).toMatchObject({ tier: "creator", remainingCredits: 94, renewsAt: "2030-02-01T00:00:00.000Z" });
    expect(routeDeps.projectService.getUsageSummary).toHaveBeenCalledWith({ actorUserId: "user-1", workspaceId: PERSONAL });
  });

  test("a Workspace the member cannot view carries no credits and never reads them", async () => {
    const routeDeps = deps({
      resolveWorkspaceContext: mock(async () => context(RESTRICTED, { role: "viewer", status: "pending_payment" })) as never,
    });
    const response = await app(routeDeps).request("/api/session/bootstrap", { headers: headers() });
    const body = await response.json();
    expect(body.capabilities["content.view"]).toBe(false);
    expect(body.usage).toBeNull();
    expect(routeDeps.projectService.getUsageSummary).not.toHaveBeenCalled();
  });

  test("identity-only clients send the saved selection as a query parameter", async () => {
    const routeDeps = deps();
    const response = await app(routeDeps).request(`/api/session/bootstrap?workspaceId=${RESTRICTED}`, {
      headers: headers(),
    });
    expect(response.headers.get("x-workspace-id")).toBe(RESTRICTED);
    expect(routeDeps.resolveWorkspaceContext).toHaveBeenCalledWith({ id: "user-1" }, RESTRICTED);
    const unknown = await app().request("/api/session/bootstrap?other=1", { headers: headers() });
    expect(unknown.status).toBe(400);
  });

  test("a removed selection falls back to the personal Workspace and says so", async () => {
    const response = await app().request("/api/session/bootstrap", {
      headers: headers({ "x-workspace-id": "00000000-0000-4000-8000-0000000000ff" }),
    });
    const body = await response.json();
    expect(response.headers.get("x-workspace-id")).toBe(PERSONAL);
    expect(body.selection).toEqual({ workspaceId: PERSONAL, workspaceSelectionChanged: true });
  });
});

describe("POST /api/session/workspace-selection", () => {
  const post = (routeApp: ReturnType<typeof app>, workspaceId: unknown, extra = {}) =>
    routeApp.request("/api/session/workspace-selection", {
      method: "POST",
      headers: headers(extra),
      body: JSON.stringify({ workspaceId }),
    });

  test("returns the selected Workspace even when it is restricted", async () => {
    const response = await post(app(), RESTRICTED);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-workspace-id")).toBe(RESTRICTED);
    const body = await response.json();
    expect(body.workspace).toMatchObject({ id: RESTRICTED, name: "Team", role: "owner" });
    expect(body.capabilities["content.view"]).toBe(true);
  });

  test("a Workspace the user does not belong to is refused without being confirmed to exist", async () => {
    const response = await post(app(), "00000000-0000-4000-8000-0000000000aa");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "workspace_access_denied" });
    expect(response.headers.get("x-workspace-id")).toBeNull();
  });

  test("rejects a malformed Workspace id before touching membership", async () => {
    const routeDeps = deps();
    const response = await post(app(routeDeps), "not-a-uuid");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_input" });
    expect(routeDeps.selectWorkspaceForActor).not.toHaveBeenCalled();
  });
});

describe("invitations", () => {
  const token = "t".repeat(24);

  test("preview returns display facts with an ISO expiry", async () => {
    const response = await app().request(`/api/invites/${token}`, { headers: headers() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workspaceName: "Team",
      workspaceStatus: "active",
      role: "editor",
      email: "member@example.com",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
  });

  test("an unknown or expired token is an invalid-invitation refusal", async () => {
    const response = await app().request(`/api/invites/${"x".repeat(24)}`, { headers: headers() });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "workspace_invite_invalid" });
  });

  test("accepting returns the explicit selection and navigation, with no cookie", async () => {
    const routeDeps = deps();
    const response = await app(routeDeps).request(`/api/invites/${token}/accept`, {
      method: "POST",
      headers: headers(),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-workspace-id")).toBe(RESTRICTED);
    const body = await response.json();
    expect(body.workspace.id).toBe(RESTRICTED);
    expect(body.destination).toBe("/home");
    expect(routeDeps.workspaceMembershipService.acceptInvite).toHaveBeenCalledWith("user-1", token);
  });

  test("a refusal from the service keeps its code and status", async () => {
    const routeDeps = deps({
      workspaceMembershipService: {
        acceptInvite: mock(async () => {
          throw new WorkspaceOperationError(
            "workspace_invite_email_mismatch",
            "Sign in with the email address this invitation was sent to",
          );
        }),
      } as never,
    });
    const response = await app(routeDeps).request(`/api/invites/${token}/accept`, {
      method: "POST",
      headers: headers(),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "workspace_invite_email_mismatch" });
  });
});
