import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { AcceptanceFailure, runDeployedHttpAcceptance, type AcceptanceInput } from "./gates/deployed-http-acceptance.ts";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function fact(value: unknown, code: string): asserts value { if (!value) throw new AcceptanceFailure(code); }
function privateJson(path: string): Record<string, any> {
  const info = statSync(path);
  fact(info.isFile() && !(info.mode & 0o077) && info.size <= 128 * 1024, "private_input_file_invalid");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  fact(value && typeof value === "object" && !Array.isArray(value), "private_input_json_invalid");
  return value as Record<string, any>;
}
function origin(value: string) {
  const url = new URL(value);
  fact(url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash, "configured_origin_invalid");
  return url.origin;
}
function argumentsOf(args: string[]) {
  const allowed = new Set(["credentials-file", "settings-file", "api-origin", "workspace-id", "project-id", "denied-workspace-id", "task-id", "journal-file"]);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]?.slice(2), value = args[i + 1];
    fact(args[i]?.startsWith("--") && flag && allowed.has(flag) && value && !value.startsWith("--") && !values.has(flag), "arguments_invalid");
    values.set(flag, value);
  }
  const required = (key: string) => { const value = values.get(key); fact(value, "required_argument_missing"); return value; };
  const credentials = privateJson(required("credentials-file")), settings = privateJson(required("settings-file"));
  const apiOrigin = origin(required("api-origin")), webOrigin = origin(String(settings.WEB_ORIGIN ?? ""));
  const workspaceId = required("workspace-id"), projectId = required("project-id"), deniedWorkspaceId = required("denied-workspace-id"), taskId = required("task-id");
  fact([workspaceId, projectId, deniedWorkspaceId, taskId].every(id => UUID.test(id)), "fixture_identity_invalid");
  fact(deniedWorkspaceId !== workspaceId && credentials.workspaceId === workspaceId, "fixture_journal_identity_mismatch");
  fact(typeof credentials.apiKey === "string" && /^nf_[A-Za-z0-9_-]+$/.test(credentials.apiKey), "api_key_invalid");
  fact(typeof credentials.sessionToken === "string" && /^[^\s,]{1,8192}$/.test(credentials.sessionToken), "clerk_session_invalid");
  for (const name of ["ELEVENLABS_WEBHOOK_SECRET", "STRIPE_WEBHOOK_SECRET", "CLERK_WEBHOOK_SECRET"]) fact(typeof settings[name] === "string" && settings[name].length > 0, "webhook_secret_missing");
  const journal = required("journal-file");
  fact(!(statSync(dirname(journal)).mode & 0o077), "journal_directory_not_private");
  const runId = randomUUID(), fixtures = { runId, clerkEventId: `msg_cutover_gate_${runId}`, stripeEventId: `evt_cutover_gate_${runId}`, missingTaskId: randomUUID() };
  // Persist exact controlled receipt identities before the first HTTP request.
  // The journal contains no credential, ticket, signed URL or API origin.
  writeFileSync(journal, JSON.stringify({ version: 1, workspaceId, projectId, fixtures, taskId,
    cleanup: { clerk: { provider: "clerk", eventId: fixtures.clerkEventId }, stripe: { provider: "stripe", eventId: fixtures.stripeEventId } } }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  const input: AcceptanceInput = { apiOrigin, webOrigin, workspaceId, projectId, deniedWorkspaceId, taskId,
    apiKey: credentials.apiKey, sessionToken: credentials.sessionToken,
    webhookSecrets: { elevenlabs: settings.ELEVENLABS_WEBHOOK_SECRET, stripe: settings.STRIPE_WEBHOOK_SECRET, clerk: settings.CLERK_WEBHOOK_SECRET,
      ...(settings.ZOOM_WEBHOOK_SECRET_TOKEN ? { zoom: settings.ZOOM_WEBHOOK_SECRET_TOKEN } : {}) }, fixtures };
  return input;
}

export async function main(args: string[]) {
  const input = argumentsOf(args);
  const report = await runDeployedHttpAcceptance(input);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => {
  const code = error instanceof AcceptanceFailure ? error.code : "acceptance_transport_or_input_failed";
  // Never serialize thrown network errors, response bodies or private inputs.
  process.stdout.write(`${JSON.stringify({ status: "failed", code, ...(error instanceof AcceptanceFailure && error.phase ? { phase: error.phase, requestIndex: error.requestIndex } : {}) })}\n`); process.exitCode = 1;
});
