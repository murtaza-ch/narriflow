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

import { RenderAttemptTelemetry, redactRenderDiagnostic } from "./render-diagnostic-adapter";

test("telemetry records failed and overlapping operations without changing their results", async () => {
  const events: unknown[] = [];
  let clock = 0;
  const metrics = new RenderAttemptTelemetry((event) => events.push(event), () => clock++);
  const failure = new Error("encode failed");
  await expect(metrics.measure("encode", "ffmpeg", () => Promise.reject(failure))).rejects.toBe(failure);
  expect(metrics.measure("compose", "compile", () => ["unchanged"])).toEqual(["unchanged"]);
  metrics.record({ level: "error", message: "clip_render_variant_failed", context: { disposition: "permanent" } });
  metrics.record({ level: "info", message: "clip_render_glyph_omissions", context: { count: 2 } });
  metrics.finish({ groupId: "group" });
  expect(metrics.phaseOperations).toEqual({ encode: 1, compose: 1 });
  expect(metrics.counts).toMatchObject({ permanent: 1, retryable: 0, glyphOmission: 2 });
  expect(events).toHaveLength(3);
});

test("logs redact unsigned/signed URLs, credentials and raw caption diagnostics recursively", () => {
  const result = JSON.stringify(redactRenderDiagnostic({ captionText: "private phrase", token: "private-token", apiKey: "private-key", nested: { signedUrl: "https://bucket/private?token=secret", stderr: "user text", error: "fetch https://host/private?sig=secret Bearer abc" }, groupToken: "safe-lease-uuid" }));
  for (const secret of ["private phrase", "private-token", "private-key", "bucket", "user text", "host/private", "Bearer abc"]) expect(result).not.toContain(secret);
  expect(result).toContain("safe-lease-uuid");
});
