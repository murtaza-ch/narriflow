import { expect, test } from "bun:test";
import { ProductionRenderDiagnosticAdapter } from "./render-diagnostic-adapter";

test("render diagnostic adapter emits stable JSON fields that context cannot override", () => {
  const lines: string[] = [];
  const adapter = new ProductionRenderDiagnosticAdapter({
    now: () => new Date("2026-08-26T10:00:00.000Z"),
    write: (line) => lines.push(line),
  });

  adapter.diagnose({
    level: "error",
    message: "clip_render_attempt_interrupted",
    context: {
      level: "spoofed",
      message: "spoofed",
      ts: "spoofed",
      workflowRunId: "run-1",
      workflowAttemptId: "attempt-1",
    },
  });

  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toEqual({
    workflowRunId: "run-1",
    workflowAttemptId: "attempt-1",
    level: "error",
    message: "clip_render_attempt_interrupted",
    ts: "2026-08-26T10:00:00.000Z",
  });
});
