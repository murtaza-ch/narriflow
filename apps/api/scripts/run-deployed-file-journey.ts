import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { FileJourneyFailure, inspectFile, prepareFileJourney, runFileJourney, SPOKEN_SOURCE, type FileJourneyJournal } from "./gates/deployed-file-journey.ts";

function fact(value: unknown, code: string): asserts value { if (!value) throw new FileJourneyFailure(code); }
function privateJson(path: string) {
  const info = statSync(path); fact(info.isFile() && !(info.mode & 0o077) && info.size <= 128 * 1024, "private_file_invalid");
  const value: unknown = JSON.parse(readFileSync(path, "utf8")); fact(value && typeof value === "object" && !Array.isArray(value), "private_json_invalid");
  return value as Record<string, any>;
}
export async function main(args: string[]) {
  const values = new Map<string, string>();
  const allowed = new Set(["phase", "api-origin", "workspace-id", "source-file", "credentials-file", "journal-file"]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.slice(2), value = args[index + 1];
    fact(args[index]?.startsWith("--") && key && allowed.has(key) && value && !value.startsWith("--") && !values.has(key), "arguments_invalid"); values.set(key, value);
  }
  const required = (key: string) => { const value = values.get(key); fact(value, "argument_missing"); return value; };
  const phase = required("phase"), origin = new URL(required("api-origin"));
  fact(origin.protocol === "https:" && origin.pathname === "/" && !origin.username && !origin.password && !origin.search && !origin.hash, "api_origin_invalid");
  const journalPath = resolve(required("journal-file")); fact(!(statSync(dirname(journalPath)).mode & 0o077), "journal_directory_not_private");
  if (phase === "prepare") {
    const path = resolve(required("source-file")), source = await inspectFile(path);
    fact(source.byteLength === SPOKEN_SOURCE.byteLength && source.sha256 === SPOKEN_SOURCE.sha256, "spoken_source_identity_mismatch");
    const journal = prepareFileJourney({ apiOrigin: origin.origin, workspaceId: required("workspace-id"), source: { path, ...source, durationSeconds: SPOKEN_SOURCE.durationSeconds } });
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ status: "prepared_only", sourceBytes: source.byteLength, durationSeconds: SPOKEN_SOURCE.durationSeconds, networkRequests: 0 })}\n`); return;
  }
  fact(phase === "upload" || phase === "generate" || phase === "status", "phase_invalid");
  const journal = privateJson(journalPath) as FileJourneyJournal;
  const credentials = privateJson(required("credentials-file"));
  fact(credentials.workspaceId === journal.workspaceId && (!values.has("workspace-id") || values.get("workspace-id") === journal.workspaceId), "credential_workspace_mismatch");
  fact(typeof credentials.apiKey === "string" && /^nf_[A-Za-z0-9_-]+$/.test(credentials.apiKey), "api_key_invalid");
  fact(typeof credentials.sessionToken === "string" && /^[^\s,]{1,8192}$/.test(credentials.sessionToken), "clerk_session_invalid");
  const persist = (value: FileJourneyJournal) => {
    const temporary = `${journalPath}.next-${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    try { renameSync(temporary, journalPath); } catch (error) { unlinkSync(temporary); throw error; }
  };
  const report = await runFileJourney(phase, { apiOrigin: origin.origin, apiKey: credentials.apiKey, sessionToken: credentials.sessionToken, journal, persist });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (import.meta.main) main(process.argv.slice(2)).catch(error => {
  process.stdout.write(`${JSON.stringify({ status: "failed", code: error instanceof FileJourneyFailure ? error.code : "file_journey_transport_or_input_failed" })}\n`); process.exitCode = 1;
});
