import { describe, expect, test } from "bun:test";
import { MCP_TOOL_COMMANDS } from "@narriflow/mcp-core";
import { INTEGRATION_COMMANDS, type IntegrationCommand } from "@narriflow/services";
import { Hono } from "hono";
import { ADMISSION_TABLES } from "./domains";
import type { AdmissionEntry } from "./domains/platform/admission-table";
import { REST_ENDPOINT_COMMANDS } from "./domains/rest/admission";
import { createRestRoutes } from "./domains/rest/routes";

type BrowserPeer = { method: "GET" | "POST"; path: string };

// The API checks its own first-party declarations without making integrations
// depend on browser policy. Every integration command has a first-party peer
// route in the domain admission tables.
const browserPeers = {
  list_projects: { method: "GET", path: "/projects" },
  get_project: { method: "GET", path: "/projects/:id" },
  get_workspace_usage: { method: "GET", path: "/workspace/usage" },
  // Events report what finished across the Workspace's projects, so they take the project list's role.
  list_events: { method: "GET", path: "/projects" },
  // Webhooks deliver those same events, so reading them takes the project list's role.
  list_webhooks: { method: "GET", path: "/projects" },
  // Creating, deleting, re-enabling, or testing an endpoint spends processing the way starting work does.
  manage_webhooks: { method: "POST", path: "/projects/:id/generate" },
  list_autopilot_rules: { method: "GET", path: "/autopilot/rules" },
  create_rss_autopilot_rule: { method: "POST", path: "/autopilot/rules" },
  run_autopilot_rule_now: { method: "POST", path: "/autopilot/rules/:ruleId/run-now" },
  get_social_publication: { method: "GET", path: "/projects/:id/social-posts/:postId/publication" },
  recheck_social_publication: { method: "POST", path: "/projects/:id/social-posts/:postId/recheck" },
  confirm_social_publication: { method: "POST", path: "/projects/:id/social-posts/:postId/confirm" },
  publish_social_publication_again: { method: "POST", path: "/projects/:id/social-posts/:postId/publish-again" },
  submit_video: { method: "POST", path: "/ingest/link" },
  create_captioned_video: { method: "POST", path: "/ingest/link" },
  open_upload: { method: "POST", path: "/upload-sessions/open" },
  generate_clips: { method: "POST", path: "/projects/:id/generate" },
  search_library: { method: "GET", path: "/library/search" },
  list_clips: { method: "GET", path: "/projects/:id/clips" },
  get_clip: { method: "GET", path: "/projects/:id/clips" },
  create_clip_export: { method: "POST", path: "/projects/:id/clips/:clipId/exports" },
  get_clip_export: { method: "GET", path: "/projects/:id/clips/:clipId/exports/:exportId" },
  list_social_accounts: { method: "GET", path: "/social/accounts" },
  get_publishing_options: { method: "GET", path: "/projects/:id/social-accounts/:accountId/publishing-options" },
  prepare_social_post: { method: "POST", path: "/projects/:id/campaign-operations/schedule/preview" },
  // Proposing queues a post for acceptance; accepting it schedules it, which takes the same role.
  propose_social_post: { method: "POST", path: "/projects/:id/campaign-operations/schedule" },
  schedule_social_post: { method: "POST", path: "/projects/:id/campaign-operations/schedule" },
  list_social_publications: { method: "GET", path: "/projects/:id/social-posts" },
  get_operation: { method: "GET", path: "/projects/:id" },
  // Starting work and asking for its completion notice again need the same role.
  redeliver_callback: { method: "POST", path: "/projects/:id/generate" },
  get_export_download: { method: "GET", path: "/projects/:id/clips/:clipId/exports/:exportId" },
  get_clip_timeline: { method: "GET", path: "/projects/:id/clips/:clipId/timeline/:format" },
  list_brand_profiles: { method: "GET", path: "/brand-profiles" },
  list_recipes: { method: "GET", path: "/recipes" },
  create_review_handoff: { method: "GET", path: "/projects/:id/review-rounds" },
  list_review_rounds: { method: "GET", path: "/projects/:id/review-rounds" },
  get_review_round: { method: "GET", path: "/projects/:id/review-rounds" },
} satisfies Record<IntegrationCommand, BrowserPeer>;

function firstPartyEntry(key: string): AdmissionEntry | undefined {
  for (const table of Object.values(ADMISSION_TABLES)) {
    const entry = (table as Record<string, AdmissionEntry>)[key];
    if (entry) return entry;
  }
  return undefined;
}

describe("integration and browser capability parity", () => {
  test("every MCP workspace tool is an integration command; only discovery is MCP-only", () => {
    const commands = Object.entries(MCP_TOOL_COMMANDS);
    expect(commands.filter(([, command]) => command === null).map(([tool]) => tool)).toEqual(["narriflow_list_workspaces"]);
    for (const [, command] of commands) if (command) expect(INTEGRATION_COMMANDS[command]).toBeDefined();
  });

  test("every REST endpoint admits one integration command with a browser peer", async () => {
    const app = new Hono().route("/api/v1", createRestRoutes({
      checkRateLimit: async () => ({ allowed: true, availability: "available", remaining: 1, limit: 1 }),
      readRateLimit: async () => ({ allowed: true, availability: "available", remaining: 1, limit: 1 }),
      apiOrigin: () => "https://api.narriflow.test",
      webOrigin: () => "https://narriflow.test",
      corsAllowedOrigins: ["https://narriflow.test"],
      log: () => {},
    }));
    const document = await (await app.request("/api/v1/openapi.json")).json() as { paths: Record<string, Record<string, unknown>> };
    const documented = Object.entries(document.paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path.replace("/api/v1", "")}`));
    expect(documented.sort()).toEqual(Object.keys(REST_ENDPOINT_COMMANDS).sort());
    for (const command of Object.values(REST_ENDPOINT_COMMANDS)) expect(browserPeers[command]).toBeDefined();
  });

  for (const command of Object.keys(browserPeers) as IntegrationCommand[]) {
    test(`${command} uses its browser peer's capability`, () => {
      const peer: BrowserPeer = browserPeers[command];
      const policy = INTEGRATION_COMMANDS[command];
      const entry = firstPartyEntry(`${peer.method} ${peer.path}`);
      expect(entry).toBeDefined();
      if (!entry || "trust" in entry) throw new Error(`Missing first-party peer route for ${command}`);
      expect(policy.capability).toBe(entry.capability);
    });
  }
});
