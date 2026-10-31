import { describe, expect, test } from "bun:test";
import type { AppUser, WorkspaceActorContext } from "@narriflow/auth";
import type { ProgressTicketPayload } from "@narriflow/validators/api/progress";
import { createRequestPolicyRuntime } from "../../http/request-policy-runtime";
import { createInventoryApp } from "../../test-app";
import { createProgressRoutes } from "./routes";

const PROJECT_ID = "50000000-0000-4000-8000-000000000001";
const WEB = "http://localhost:3000";
const user = { id: "actor-user", clerkId: "clerk-1" } as AppUser;
const context: WorkspaceActorContext = {
  userId: "actor-user",
  workspaceId: "workspace-a",
  workspaceName: "Workspace A",
  workspaceOwnerUserId: "owner-user",
  role: "editor",
  status: "active",
  pricingTier: "creator",
  isPersonal: false,
  workspaceSelectionChanged: false,
};


function build() {
  const world = { membership: true, project: true, rateAllowed: true, status: "active" as "active" | "restricted" };
  const issues: Array<Pick<ProgressTicketPayload, "actorUserId" | "workspaceId" | "projectId" | "origin" | "audience"> & { authorizedAt: number }> = [];
  const policyRuntime = createRequestPolicyRuntime({
    authenticate: async (request) => request.headers.get("authorization") === "Bearer good"
      ? { status: "authenticated", identity: { clerkUserId: "clerk-1", sessionId: "s" } } as never
      : { status: "unauthenticated", reason: "missing_credential" },
    loadAppUser: async () => user,
    resolveScopedWorkspace: async (_user, hint) => hint === "workspace-a" && world.membership ? { ...context, status: world.status } : null,
    staffAllowlist: new Set(),
    policy: { resolveProject: async () => world.project ? { kind: "active", projectId: PROJECT_ID } : { kind: "missing" },
      rateLimit: async () => ({ allowed: world.rateAllowed, availability: "available", retryAfterSeconds: 30, limit: 30, remaining: 3 }), now: Date.now },
  });
  const app = createInventoryApp({ policyRuntime, domains: { progress: createProgressRoutes({ allowedOrigins: [WEB], audience: "http://localhost:4000/api/progress",
    issue: async (scope, authorizedAt) => { issues.push({ ...scope, authorizedAt }); return "signed-connect-ticket"; },
  }) } });
  const headers = { authorization: "Bearer good", "x-workspace-id": "workspace-a", origin: WEB, "content-type": "application/json" };
  return { world, issues, open: (over: Record<string, string> = {}) => app.request(`/api/projects/${PROJECT_ID}/progress-ticket`, { method: "POST", headers: { ...headers, ...over }, body: "{}" }) };
}

describe("progress connect-ticket admission", () => {
  test("mints a scoped one-use ticket after content.view authorization", async () => {
    const t = build(); const before = Date.now(); const response = await t.open();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.ticket).toBe("signed-connect-ticket");
    expect(body.subscriptionExpiresAt - t.issues[0]!.authorizedAt).toBe(60_000);
    expect(body.ticketExpiresAt - t.issues[0]!.authorizedAt).toBe(30_000);
    expect(t.issues[0]).toMatchObject({ actorUserId: "actor-user", workspaceId: "workspace-a", projectId: PROJECT_ID, origin: WEB, audience: "http://localhost:4000/api/progress" });
    expect(t.issues[0]!.authorizedAt).toBeGreaterThanOrEqual(before);
  });
  test("a cookie cannot mint a progress ticket", async () => {
    const t = build(); expect((await t.open({ authorization: "", cookie: "__session=good" })).status).toBe(401); expect(t.issues).toHaveLength(0);
  });
  test("membership loss and inaccessible Projects cannot mint tickets", async () => {
    for (const missing of ["membership", "project"] as const) { const t = build(); t.world[missing] = false; expect((await t.open()).status).toBeGreaterThanOrEqual(400); expect(t.issues).toHaveLength(0); }
  });
  test("an untrusted Origin and an exhausted actor connection budget are refused", async () => {
    const t = build(); expect((await t.open({ origin: "https://wrong.test" })).status).toBe(403); t.world.rateAllowed = false; expect((await t.open()).status).toBe(429); expect(t.issues).toHaveLength(0);
  });
});
