import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { RenderExecutorHealth, reserveWorkerHealthPort, verifySharedRenderEnvironment } from "./render-executor-health";
import { executorProcessFailure, WorkerProcessFailure } from "./worker-process";

const spawnFailure = () => new WorkerProcessFailure("worker_command_spawn_failed", "retryable", "spawn failed", "", null,
  { errno: "EBADF", executableClass: "ffprobe", failureScope: "executor" });

test("duplicate local startup cannot reach claims before acquiring the health port", async () => {
  const first = createServer();
  const second = createServer();
  let claims = 0;
  try {
    await reserveWorkerHealthPort(first, 0);
    const address = first.address();
    if (!address || typeof address === "string") throw new Error("missing bound port");
    await expect((async () => { await reserveWorkerHealthPort(second, address.port); claims += 1; })()).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(claims).toBe(0);
  } finally { first.close(); second.close(); }
});

test("quarantine stops starts immediately, delays checks and recycles after two failures", async () => {
  let now = 0;
  let checks = 0;
  let recycles = 0;
  const diagnostics: unknown[] = [];
  const health = new RenderExecutorHealth({ nowMs: () => now, checkDelayMs: 30,
    check: async () => { checks += 1; if (checks > 1) throw new Error("missing runtime"); },
    recycle: () => { recycles += 1; }, diagnose: (event) => diagnostics.push(event) });
  await health.checkIfDue();
  health.beforeStart("ffprobe");
  const error = spawnFailure();
  health.failed(error);
  health.failed(error);
  expect(diagnostics).toHaveLength(1);
  expect(() => health.beforeStart("ffmpeg")).toThrow(error);
  await health.checkIfDue();
  expect(checks).toBe(1);
  now = 30;
  await health.checkIfDue();
  expect(health.snapshot()).toMatchObject({ ready: false, failedChecks: 1, errno: "EBADF" });
  now = 60;
  await health.checkIfDue();
  await health.checkIfDue();
  expect(recycles).toBe(1);
  expect(health.snapshot().state).toBe("recycling");
});

test("startup runtime mismatch never admits media; a recovered exact check reopens admission", async () => {
  let now = 0;
  let valid = false;
  const health = new RenderExecutorHealth({ nowMs: () => now, checkDelayMs: 10,
    check: async () => { if (!valid) throw new Error("font/model/tool mismatch"); }, recycle: () => {} });
  await health.checkIfDue();
  expect(() => health.assertReady()).toThrow();
  valid = true;
  await health.checkIfDue();
  expect(health.snapshot().ready).toBe(false);
  now = 10;
  await health.checkIfDue();
  expect(health.snapshot().ready).toBe(true);
});

test("health failures remain recognizable through asset/analysis causes; Dolby Vision is content", () => {
  const failure = spawnFailure();
  expect(executorProcessFailure(new Error("analysis", { cause: failure }))).toBe(failure);
  expect(executorProcessFailure(new Error("hdr_dolby_vision_unsupported"))).toBeNull();
});

if (process.platform !== "linux") {
  test("the report-only native golden host cannot bypass shared-queue runtime admission", async () => {
    await expect(verifySharedRenderEnvironment()).rejects.toThrow();
  }, 30_000);
}
