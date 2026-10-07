import { describe, expect, test } from "bun:test";
import { deriveExportStatus, deriveGenerationStatus, deriveIntakePhase, intakeProgress, type GenerationRender, type GenerationRun } from "./operation-status";

const origin: GenerationRun = { id: "stt", stage: "stt", status: "completed", errorCode: null, idempotencyKey: "generation", contentPackId: "pack" };
const detection: GenerationRun = { ...origin, id: "detection", stage: "moment_detection", idempotencyKey: "generation__moment_detection" };
const render: GenerationRun = { ...origin, id: "render", stage: "clip_rendering", idempotencyKey: "auto-render-detection" };
function rendered(id: string, status: string, errorCode: string | null = null): GenerationRender {
  return { id, status, errorCode, failureDisposition: status === "failed" ? "permanent" : null };
}
const frozen = (ids: string[]) => ids.map((renderId) => ({ renderId, clipId: `clip-${renderId}` }));
function status(renders: GenerationRender[], run = render) {
  return deriveGenerationStatus({ origin, detection, renders, renderRuns: [run], expectedRenders: frozen(renders.map((item) => item.id)),
    renderOutcomes: renders.filter((item) => item.status === "completed" || item.status === "failed" && item.failureDisposition === "permanent") });
}

describe("generation Operation Status", () => {
  test("transcription completion keeps generation working until its exact detection child settles", () => {
    expect(deriveGenerationStatus({ origin, detection: { ...detection, status: "queued" }, renders: [], renderRuns: [] })).toMatchObject({ state: "working", stage: "detecting" });
    expect(deriveGenerationStatus({ origin, detection: { ...detection, status: "failed", errorCode: "detection_failed" }, renders: [], renderRuns: [] })).toMatchObject({ state: "failed", failureCode: "detection_failed" });
    expect(deriveGenerationStatus({ origin, detection: { ...detection, idempotencyKey: "other__moment_detection" }, renders: [], renderRuns: [] }).state).toBe("working");
    expect(deriveGenerationStatus({ origin, detection: { ...detection, contentPackId: "other" }, renders: [], renderRuns: [] }).state).toBe("working");
    expect(deriveGenerationStatus({ origin: { ...origin, status: "running", progress: 50 }, detection: null, renders: [], renderRuns: [] })).toMatchObject({ state: "working", stage: "transcribing", progress: 0.15 });
  });

  test("generation waits for only its original renders and reports partial or failed rendering with per-clip outcomes", () => {
    expect(status([rendered("a", "pending")], { ...render, status: "queued" }).state).toBe("working");
    expect(status([rendered("a", "completed"), rendered("b", "rendering")], { ...render, status: "running" })).toMatchObject({ state: "working", progress: 0.8 });
    expect(status([rendered("a", "completed"), rendered("b", "failed", "render_failed")])).toMatchObject({
      state: "partial", failureCode: "render_failed",
      items: [{ kind: "clip", id: "clip-a", state: "completed", failureCode: null }, { kind: "clip", id: "clip-b", state: "failed", failureCode: "render_failed" }],
    });
    expect(status([rendered("a", "failed", "render_failed")]).state).toBe("failed");
    // Unrelated shared variants cannot hold or fail an already completed generation.
    expect(status([rendered("a", "completed")], { ...render, status: "running" })).toMatchObject({ state: "completed", progress: 1 });
    expect(status([rendered("a", "completed")], { ...render, status: "partial" }).state).toBe("completed");
  });

  test("cancellation becomes terminal only after running original variants finish", () => {
    expect(status([rendered("a", "failed", "MCP_CANCELLED"), rendered("b", "rendering")], { ...render, status: "running" }).state).toBe("working");
    expect(status([rendered("a", "failed", "MCP_CANCELLED"), rendered("b", "completed")], { ...render, status: "running" })).toMatchObject({
      state: "cancelled", items: [{ id: "clip-a", state: "cancelled" }, { id: "clip-b", state: "completed" }],
    });
  });

  test("retryable failures remain working until a later attempt settles the original render", () => {
    expect(status([{ ...rendered("a", "failed", "temporary_provider_error"), failureDisposition: "retryable" }], { ...render, status: "running" }).state).toBe("working");
    expect(status([{ ...rendered("a", "failed", "temporary_provider_error"), failureDisposition: "retryable" }], { ...render, status: "queued" }).state).toBe("working");
    expect(deriveGenerationStatus({ origin, detection, renders: [rendered("a", "completed")], renderRuns: [{ ...render, status: "running" }], expectedRenders: frozen(["a"]) }).state).toBe("working");
  });

  test("first durable outcomes survive cache reset and clip deletion without absorbing later shared drains", () => {
    const completed = rendered("a", "completed");
    const base = { origin, detection, expectedRenders: frozen(["a"]), renderRuns: [render], renderOutcomes: [completed] };
    expect(deriveGenerationStatus({ ...base, renders: [rendered("a", "pending")] }).state).toBe("completed");
    // Clip identity survives render and clip deletion through the frozen handoff.
    expect(deriveGenerationStatus({ ...base, renders: [], renderOutcomes: [rendered("a", "failed", "render_failed")] }))
      .toMatchObject({ state: "failed", items: [{ kind: "clip", id: "clip-a", state: "failed", failureCode: "render_failed" }] });
    expect(deriveGenerationStatus({ ...base, renders: [], renderRuns: [render, { ...render, id: "drain", status: "queued" }] }).state).toBe("completed");
    expect(deriveGenerationStatus({ ...base, renders: [], renderOutcomes: [completed, rendered("a", "failed", "later_render_failure")] }).state).toBe("completed");
    expect(deriveGenerationStatus({ ...base, expectedRenders: frozen(["a", "late"]), renders: [], renderRuns: [render, { ...render, id: "drain", status: "queued" }] }).state).toBe("working");
    expect(deriveGenerationStatus({ ...base, expectedRenders: frozen(["a", "late"]), renders: [], renderOutcomes: [completed, rendered("late", "failed", "render_failed")] }).state).toBe("partial");
  });

  test("terminal render work with a missing original artifact fails instead of borrowing shared results", () => {
    expect(deriveGenerationStatus({ origin, detection, expectedRenders: frozen(["a"]), renders: [], renderRuns: [{ ...render, status: "completed" }], renderOutcomes: [] }))
      .toMatchObject({ state: "failed", failureCode: "render_unavailable" });
  });
});

describe("export Operation Status", () => {
  const variant = (id: string, status: string, hasAsset = status === "completed", errorCode: string | null = null) => ({ id, status, hasAsset, errorCode });
  test("reports mixed variants as partial with per-variant outcomes", () => {
    expect(deriveExportStatus({ status: "partial_ready", progress: 100, errorCode: null, variants: [variant("v1", "completed"), variant("v2", "failed", false, "render_failed")] })).toEqual({
      state: "partial", stage: "rendering", progress: 1, failureCode: "render_failed",
      items: [{ kind: "variant", id: "v1", state: "completed", failureCode: null }, { kind: "variant", id: "v2", state: "failed", failureCode: "render_failed" }],
    });
  });
  test("a completed variant without its file is not reported as delivered", () => {
    expect(deriveExportStatus({ status: "ready", progress: 100, errorCode: null, variants: [variant("v1", "completed", false)] }))
      .toMatchObject({ state: "failed", items: [{ id: "v1", state: "failed", failureCode: "export_file_missing" }] });
  });
  test("working, completed, and cancelled exports", () => {
    expect(deriveExportStatus({ status: "rendering", progress: 40, errorCode: null, variants: [variant("v1", "rendering")] })).toMatchObject({ state: "working", progress: 0.4 });
    expect(deriveExportStatus({ status: "ready", progress: 100, errorCode: null, variants: [variant("v1", "completed")] })).toMatchObject({ state: "completed", failureCode: null });
    expect(deriveExportStatus({ status: "failed", progress: 0, errorCode: "MCP_CANCELLED", variants: [variant("v1", "pending")] }))
      .toMatchObject({ state: "cancelled", items: [{ id: "v1", state: "cancelled" }] });
  });
});

describe("intake Operation Status before generation", () => {
  const ingest = (patch: Partial<Parameters<typeof deriveIntakePhase>[1] & object> = {}) =>
    ({ status: "completed", lastError: null, generationHandoffAt: null, generationRunId: null, ...patch });
  test("upload finalization, reconciliation, and permanent pre-handoff failure are reported", () => {
    expect(deriveIntakePhase({ status: "uploading", failureCode: null }, null)).toMatchObject({ state: "working", stage: "uploading" });
    expect(deriveIntakePhase({ status: "reconciling", failureCode: null }, null)).toMatchObject({ state: "working", stage: "verifying" });
    expect(deriveIntakePhase({ status: "failed", failureCode: "upload_size_mismatch" }, null)).toMatchObject({ state: "failed", failureCode: "upload_size_mismatch" });
    expect(deriveIntakePhase({ status: "aborted", failureCode: null }, null)).toMatchObject({ state: "cancelled" });
  });
  test("the Ingest Job then its stored handoff decide what follows", () => {
    expect(deriveIntakePhase(null, ingest({ status: "running" }))).toMatchObject({ state: "working", stage: "importing" });
    expect(deriveIntakePhase(null, ingest({ status: "failed", lastError: "processing_quota_exceeded: Minutes used" }))).toMatchObject({ state: "failed", failureCode: "processing_quota_exceeded" });
    expect(deriveIntakePhase(null, ingest())).toMatchObject({ state: "working", stage: "awaiting_generation" });
    expect(deriveIntakePhase({ status: "queued_for_ingest", failureCode: null }, ingest({ generationHandoffAt: new Date(), generationRunId: "stt" }))).toBeNull();
    expect(intakeProgress(0.5)).toBe(0.6);
  });
});
