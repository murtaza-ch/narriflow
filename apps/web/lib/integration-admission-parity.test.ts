import { describe, expect, test } from "bun:test";
import { MCP_TOOL_COMMANDS } from "@narriflow/mcp-core";
import { INTEGRATION_COMMANDS, type IntegrationCommand } from "@narriflow/services";
import {
  browserSessionHonoSurfaces,
  browserSessionPages,
} from "./authenticated-request-inventory";

type BrowserPeer = { method: "GET" | "POST"; path: string } | { module: string };

// The web app checks its own declarations without making integrations depend
// on browser policy. Every integration command has a browser peer.
const browserPeers = {
  list_projects: { method: "GET", path: "/projects" },
  get_project: { module: "app/(app)/projects/[projectId]/page.tsx" },
  get_workspace_usage: { module: "app/(app)/settings/usage/page.tsx" },
  list_autopilot_rules: { method: "GET", path: "/autopilot/rules" },
  create_rss_autopilot_rule: { method: "POST", path: "/autopilot/rules" },
  run_autopilot_rule_now: { method: "POST", path: "/autopilot/rules/:ruleId/run-now" },
  get_social_publication: { method: "GET", path: "/projects/:id/social-posts/:postId/publication" },
  recheck_social_publication: { method: "POST", path: "/projects/:id/social-posts/:postId/recheck" },
  confirm_social_publication: { method: "POST", path: "/projects/:id/social-posts/:postId/confirm" },
  publish_social_publication_again: { method: "POST", path: "/projects/:id/social-posts/:postId/publish-again" },
  submit_video: { method: "POST", path: "/ingest/link" },
  open_upload: { method: "POST", path: "/upload-sessions/open" },
  generate_clips: { method: "POST", path: "/projects/:id/generate" },
  list_clips: { method: "GET", path: "/projects/:id/clips" },
  get_clip: { method: "GET", path: "/projects/:id/clips" },
  create_clip_export: { method: "POST", path: "/projects/:id/clips/:clipId/exports" },
  get_clip_export: { method: "GET", path: "/projects/:id/clips/:clipId/exports/:exportId" },
  list_social_accounts: { module: "app/(app)/projects/[projectId]/page.tsx" },
  get_publishing_options: { method: "GET", path: "/projects/:id/social-accounts/:accountId/publishing-options" },
  prepare_social_post: { method: "POST", path: "/projects/:id/campaign-operations/schedule/preview" },
  schedule_social_post: { method: "POST", path: "/projects/:id/campaign-operations/schedule" },
  list_social_publications: { method: "GET", path: "/projects/:id/social-posts" },
  get_operation: { module: "app/(app)/projects/[projectId]/page.tsx" },
  // Starting work and asking for its completion notice again need the same role.
  redeliver_callback: { method: "POST", path: "/projects/:id/generate" },
  get_export_download: { method: "GET", path: "/projects/:id/clips/:clipId/exports/:exportId" },
  list_brand_profiles: { method: "GET", path: "/brand-profiles" },
  create_review_handoff: { method: "GET", path: "/projects/:id/review-rounds" },
  list_review_rounds: { method: "GET", path: "/projects/:id/review-rounds" },
  get_review_round: { method: "GET", path: "/projects/:id/review-rounds" },
} satisfies Record<IntegrationCommand, BrowserPeer>;

describe("integration and browser capability parity", () => {
  test("every MCP workspace tool is an integration command; only discovery is MCP-only", () => {
    const commands = Object.entries(MCP_TOOL_COMMANDS);
    expect(commands.filter(([, command]) => command === null).map(([tool]) => tool)).toEqual(["narriflow_list_workspaces"]);
    for (const [, command] of commands) if (command) expect(INTEGRATION_COMMANDS[command]).toBeDefined();
  });

  for (const command of Object.keys(browserPeers) as IntegrationCommand[]) {
    test(`${command} uses its browser peer's capability`, () => {
      const peer: BrowserPeer = browserPeers[command];
      const policy = INTEGRATION_COMMANDS[command];
      if ("module" in peer) {
        const surface = browserSessionPages.find((entry) => entry.module === peer.module);
        expect(surface).toBeDefined();
        expect(surface?.admission).not.toBe("signed_in");
        if (!surface || surface.admission === "signed_in") throw new Error(`Missing Workspace page peer for ${command}`);
        expect(policy.capability).toBe(surface.capability);
      } else {
        const surface = browserSessionHonoSurfaces.find((entry) =>
          entry.method === peer.method && entry.path === peer.path,
        );
        expect(surface).toBeDefined();
        if (!surface) throw new Error(`Missing browser route peer for ${command}`);
        expect(policy.capability).toBe(surface.capability);
      }
    });
  }
});
