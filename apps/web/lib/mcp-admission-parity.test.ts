import { describe, expect, test } from "bun:test";
import { MCP_TOOL_ADMISSIONS, type NarriflowMcpToolName } from "@narriflow/mcp-core";
import {
  browserSessionHonoSurfaces,
  browserSessionPages,
} from "./authenticated-request-inventory";

type WorkspaceToolName = Exclude<NarriflowMcpToolName, "narriflow_list_workspaces">;
type BrowserPeer = { method: "GET" | "POST"; path: string } | { module: string };

// The web app checks its own declarations without making MCP depend on browser policy.
const browserPeers = {
  narriflow_list_projects: { method: "GET", path: "/projects" },
  narriflow_get_project: { module: "app/(app)/projects/[projectId]/page.tsx" },
  narriflow_get_workspace_usage: { module: "app/(app)/settings/usage/page.tsx" },
  narriflow_list_autopilot_rules: { method: "GET", path: "/autopilot/rules" },
  narriflow_create_rss_autopilot_rule: { method: "POST", path: "/autopilot/rules" },
  narriflow_run_autopilot_rule_now: { method: "POST", path: "/autopilot/rules/:ruleId/run-now" },
  narriflow_get_social_publication: { method: "GET", path: "/projects/:id/social-posts/:postId/publication" },
  narriflow_recheck_social_publication: { method: "POST", path: "/projects/:id/social-posts/:postId/recheck" },
  narriflow_confirm_social_publication: { method: "POST", path: "/projects/:id/social-posts/:postId/confirm" },
  narriflow_publish_social_publication_again: { method: "POST", path: "/projects/:id/social-posts/:postId/publish-again" },
} satisfies Record<WorkspaceToolName, BrowserPeer>;

describe("MCP and browser capability parity", () => {
  test("every tool has a browser peer or the explicit Workspace discovery exception", () => {
    expect(Object.keys(MCP_TOOL_ADMISSIONS).sort()).toEqual([
      ...Object.keys(browserPeers),
      "narriflow_list_workspaces",
    ].sort());
    expect(MCP_TOOL_ADMISSIONS.narriflow_list_workspaces).toEqual({
      admission: "discovery",
      capability: null,
      apiKeyScope: null,
    });
  });

  for (const tool of Object.keys(browserPeers) as WorkspaceToolName[]) {
    test(`${tool} uses its browser peer's capability`, () => {
      const peer: BrowserPeer = browserPeers[tool];
      const admission = MCP_TOOL_ADMISSIONS[tool];
      expect(admission.admission).toBe("workspace");
      if ("module" in peer) {
        const surface = browserSessionPages.find((entry) => entry.module === peer.module);
        expect(surface).toBeDefined();
        expect(surface?.admission).not.toBe("signed_in");
        if (!surface || surface.admission === "signed_in") throw new Error(`Missing Workspace page peer for ${tool}`);
        expect(admission.capability).toBe(surface.capability);
      } else {
        const surface = browserSessionHonoSurfaces.find((entry) =>
          entry.method === peer.method && entry.path === peer.path,
        );
        expect(surface).toBeDefined();
        if (!surface) throw new Error(`Missing browser route peer for ${tool}`);
        expect(admission.capability).toBe(surface.capability);
      }
    });
  }
});
