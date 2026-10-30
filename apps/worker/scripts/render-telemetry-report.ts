/** Read Railway JSON/JSONL without a DB connection. Usage:
 * bun apps/worker/scripts/render-telemetry-report.ts LOG_FILE WORKFLOW_RUN_ID
 * Exit 1 for missing execution summaries or accepted artifacts without a
 * validation record. Durable denominators require the runbook ledger query. */
import { readFile } from "node:fs/promises";

export function renderTelemetryReport(lines: string, workflowRunId: string) {
  const events: Record<string, unknown>[] = [];
  for (const line of lines.split("\n")) {
    try {
      let event = JSON.parse(line);
      if (typeof event.message === "string" && event.message.startsWith("{")) event = JSON.parse(event.message);
      if (event.workflowRunId === workflowRunId) events.push(event);
    } catch { /* Non-JSON provider log lines have no render facts. */ }
  }
  const metrics = new Map(events.filter((e) => e.message === "clip_render_attempt_metrics").map((e) => [String(e.groupToken ?? e.workflowAttemptId), e]));
  const phases: Record<string, number[]> = {};
  const counts: Record<string, number> = {};
  for (const m of metrics.values()) {
    for (const [phase, ms] of Object.entries((m.phaseMs ?? {}) as Record<string, number>)) { phases[phase] ??= []; phases[phase].push(ms); }
    for (const [key, count] of Object.entries((m.counts ?? {}) as Record<string, number>)) counts[key] = (counts[key] ?? 0) + count;
  }
  const releases = new Map(events.filter((e) => e.message === "render_group_released").map((e) => [String(e.groupToken ?? e.token), e]));
  for (const release of releases.values()) for (const [key, count] of Object.entries((release.counts ?? {}) as Record<string, number>)) counts[key] = (counts[key] ?? 0) + count;
  const busyMsByOwner: Record<string, number> = {};
  const settledGroups = new Map(events.filter((e) => e.message === "render_group_settled").map((e) => [String(e.groupToken ?? e.token), e]));
  for (const group of settledGroups.values()) {
    const owner = String(group.owner);
    busyMsByOwner[owner] = (busyMsByOwner[owner] ?? 0) + Number(group.replicaBusyMs ?? 0);
  }
  const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null;
  const accepted = events.filter((e) => e.message === "clip_render_variant_completed");
  const missingValidation = accepted.filter((e) => !events.some((v) => v.message === "clip_render_output_validation" && v.accepted === true && v.clipRenderId === e.clipRenderId && v.workflowAttemptId === e.workflowAttemptId)).map((e) => e.clipRenderId);
  const wallTimes = [...metrics.values()].map((m) => Number(m.elapsedMs));
  return { workflowRunId, loggedExecutionSummaries: metrics.size, releasedExecutions: releases.size, busyMsByOwner, completedArtifacts: accepted.length, missingValidation,
    attemptWallMs: { samples: wallTimes.length, p50: percentile(wallTimes, .5), p95: percentile(wallTimes, .95) },
    phaseMs: Object.fromEntries(Object.entries(phases).map(([key, values]) => [key, { samples: values.length, p50: percentile(values, .5), p95: percentile(values, .95) }])), counts,
    valid: metrics.size > 0 && missingValidation.length === 0,
    denominator: "logged group executions; use durable ledger for crash/release/supersession counts",
  };
}
if (import.meta.main) {
  const [file, run] = process.argv.slice(2);
  if (!file || !run) throw new Error("Usage: render-telemetry-report.ts LOG_FILE WORKFLOW_RUN_ID");
  const report = renderTelemetryReport(await readFile(file, "utf8"), run);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.valid ? 0 : 1;
}
