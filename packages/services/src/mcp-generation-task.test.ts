import { expect, test } from "bun:test";
import { generationTaskState, type GenerationTaskRun, type GenerationTaskRender } from "./mcp-generation-task";

const origin: GenerationTaskRun = { id: "stt", stage: "stt", status: "completed", errorCode: null, idempotencyKey: "generation", contentPackId: "pack" };
const detection: GenerationTaskRun = { ...origin, id: "detection", stage: "moment_detection", idempotencyKey: "generation__moment_detection" };
const render: GenerationTaskRun = { ...origin, id: "render", stage: "clip_rendering", idempotencyKey: "auto-render-detection" };
function rendered(id: string, status: string, errorCode: string | null = null): GenerationTaskRender { return { id, status, errorCode, failureDisposition: status === "failed" ? "permanent" : null }; }
function status(renders: GenerationTaskRender[], run = render) {
  return generationTaskState({ origin, detection, renders, renderRuns: [run], expectedRenderIds: renders.map((item) => item.id),
    renderOutcomes: renders.filter((item) => item.status === "completed" || item.status === "failed" && item.failureDisposition === "permanent") });
}

test("transcription completion keeps generation working until its exact detection child settles", () => {
  expect(generationTaskState({ origin, detection: { ...detection, status: "queued" }, renders: [], renderRuns: [] })).toEqual({ status: "working", cancelled: false });
  expect(generationTaskState({ origin, detection: { ...detection, status: "failed" }, renders: [], renderRuns: [] })).toEqual({ status: "failed", cancelled: false });
  expect(generationTaskState({ origin, detection: { ...detection, idempotencyKey: "other__moment_detection" }, renders: [], renderRuns: [] }).status).toBe("working");
  expect(generationTaskState({ origin, detection: { ...detection, contentPackId: "other" }, renders: [], renderRuns: [] }).status).toBe("working");
});

test("generation waits for only its original renders and reports partial or failed rendering accurately", () => {
  expect(status([rendered("a", "pending")], { ...render, status: "queued" }).status).toBe("working");
  expect(status([rendered("a", "completed"), rendered("b", "rendering")], { ...render, status: "running" }).status).toBe("working");
  expect(status([rendered("a", "completed"), rendered("b", "failed", "render_failed")]).status).toBe("partial");
  expect(status([rendered("a", "failed", "render_failed")]).status).toBe("failed");
  // Unrelated shared variants cannot hold or fail an already completed generation.
  expect(status([rendered("a", "completed")], { ...render, status: "running" }).status).toBe("completed");
  expect(status([rendered("a", "completed")], { ...render, status: "partial" }).status).toBe("completed");
});

test("cancellation becomes terminal only after running original variants finish", () => {
  expect(status([rendered("a", "failed", "MCP_CANCELLED"), rendered("b", "rendering")], { ...render, status: "running" })).toEqual({ status: "working", cancelled: false });
  expect(status([rendered("a", "failed", "MCP_CANCELLED"), rendered("b", "completed")], { ...render, status: "running" })).toEqual({ status: "cancelled", cancelled: true });
});

test("retryable failures remain working until a later attempt settles the original render", () => {
  expect(status([{ ...rendered("a", "failed", "temporary_provider_error"), failureDisposition: "retryable" }], { ...render, status: "running" }).status).toBe("working");
  expect(status([{ ...rendered("a", "failed", "temporary_provider_error"), failureDisposition: "retryable" }], { ...render, status: "queued" }).status).toBe("working");
  expect(status([rendered("a", "completed")], { ...render, status: "running" }).status).toBe("completed");
  expect(generationTaskState({ origin, detection, renders: [rendered("a", "completed")], renderRuns: [{ ...render, status: "running" }], expectedRenderIds: ["a"] }).status).toBe("working");
});

test("first durable outcomes survive cache reset and clip deletion without absorbing later shared drains", () => {
  const completed = rendered("a", "completed");
  const base = { origin, detection, expectedRenderIds: ["a"], renderRuns: [render], renderOutcomes: [completed] };
  expect(generationTaskState({ ...base, renders: [rendered("a", "pending")] }).status).toBe("completed");
  expect(generationTaskState({ ...base, renders: [], renderOutcomes: [rendered("a", "failed", "render_failed")] }).status).toBe("failed");
  expect(generationTaskState({ ...base, renders: [], renderRuns: [render, { ...render, id: "drain", status: "queued" }] }).status).toBe("completed");
  expect(generationTaskState({ ...base, renders: [], renderOutcomes: [completed, rendered("a", "failed", "later_render_failure")] }).status).toBe("completed");
  expect(generationTaskState({ ...base, expectedRenderIds: ["a", "late"], renders: [], renderRuns: [render, { ...render, id: "drain", status: "queued" }] }).status).toBe("working");
  expect(generationTaskState({ ...base, expectedRenderIds: ["a", "late"], renders: [], renderOutcomes: [completed, rendered("late", "failed", "render_failed")] }).status).toBe("partial");
});
