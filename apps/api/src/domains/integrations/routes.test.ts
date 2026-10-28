import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { checkRouteInventory } from "../../route-inventory";
import { integrationsAdmission } from "./admission";
import { ExpectedDomainFailureError } from "@narriflow/services";
import { createDomainTestApp, signedInHeaders } from "../ingest/test-app";
import { createIntegrationsRoutes, type IntegrationsRouteDeps } from "./routes";

function harness() {
  const calls: unknown[][] = [];
  const deps: IntegrationsRouteDeps = {
    status: async (actor) => { calls.push(["status", actor.workspaceId]); return { mcpUrl: "https://api.test/mcp", configuration: { label: "Ready", description: "Configured", verified: true }, workspace: { workspaceId: actor.workspaceId, workspaceName: actor.workspaceName, role: actor.role, status: actor.status, pricingTier: actor.pricingTier } }; },
    preparation: async (userId, token) => { calls.push(["preparation", userId, token]); throw new ExpectedDomainFailureError({ code: "mcp_continuation_revoked", kind: "forbidden", message: "Connection revoked" }); },
    uploadHandoff: async (userId, token) => { calls.push(["handoff", userId, token]); return { workspaceId: "signed-workspace", clientIdempotencyKey: "signed-key", recipeName: null, resumeOnly: true }; },
    confirm: async (userId, input) => { calls.push(["confirm", userId, input]); return { destination: "/projects/signed-project?publicationId=publication" }; },
  };
  const routes = createIntegrationsRoutes(deps);
  return { app: createDomainTestApp("integrations", routes), routes, calls };
}

describe("browser MCP continuations", () => {
  test("every browser endpoint carries its declared admission", () => {
    const h = harness();
    const declared = new Map(Object.entries(integrationsAdmission).map(([key, value]) => {
      const [method, path] = key.split(" ");
      return [`${method} /api${path}`, value] as const;
    }));
    expect(checkRouteInventory(new Hono().route("/api", h.routes), declared).problems).toEqual([]);
  });
  test("status is scoped, while a handoff ignores an unrelated Workspace selection", async () => {
    const h = harness();
    const response = await h.app.request("/api/integrations/mcp/status", { headers: signedInHeaders });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mcpUrl: "https://api.test/mcp" });
    const handoff = await h.app.request("/api/integrations/mcp/upload-handoff?intent=signed-intent", { headers: { ...signedInHeaders, "x-workspace-id": "unrelated-restricted-workspace" } });
    expect(handoff.status).toBe(200);
    expect(await handoff.json()).toMatchObject({ workspaceId: "signed-workspace", resumeOnly: true });
    expect(h.calls).toEqual([["status", "workspace-a"], ["handoff", "actor-user", "signed-intent"]]);
  });
  test("identity admission precedes validation and cookie-only requests fail", async () => {
    const h = harness();
    for (const path of ["/api/integrations/mcp/preparations", "/api/integrations/mcp/upload-handoff"]) {
      const response = await h.app.request(path, { headers: { cookie: "__session=cookie-token", origin: signedInHeaders.origin } });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "authentication_required", requestId: expect.any(String) });
    }
    expect(h.calls).toEqual([]);
  });
  test("revoked preparations retain the safe domain error and request ID", async () => {
    const h = harness();
    const response = await h.app.request("/api/integrations/mcp/preparations?token=signed-preparation", { headers: signedInHeaders });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "mcp_continuation_revoked", requestId: expect.any(String) });
  });
  test("confirmation validates after identity and returns JSON navigation", async () => {
    const h = harness();
    const bad = await h.app.request("/api/mcp/confirmations", { method: "POST", headers: signedInHeaders, body: JSON.stringify({ token: "signed", decision: "redirect-to-foreign-host" }) });
    expect(bad.status).toBe(400);
    expect(h.calls).toEqual([]);
    const response = await h.app.request("/api/mcp/confirmations", { method: "POST", headers: { ...signedInHeaders, "x-workspace-id": "unrelated" }, body: JSON.stringify({ token: "signed", decision: "confirm" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.json()).toEqual({ destination: "/projects/signed-project?publicationId=publication" });
    expect(h.calls).toEqual([["confirm", "actor-user", { token: "signed", decision: "confirm" }]]);
  });
});
