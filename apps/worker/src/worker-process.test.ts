import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { sourceProbeSchema } from "@narriflow/validators";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKFLOW_LEASE_DURATION_MS, WorkflowAttemptLost } from "@narriflow/services";
import {
  activeScratchDirectories,
  createWorkerProcessModule,
  sweepAbandonedScratch,
  WorkerProcessFailure,
  type WorkerProcessDiagnostic,
  type WorkerProcessRequest,
} from "./worker-process";

test("owned helper exits when its worker is killed without shutdown handlers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "owned-helper-"));
  const pidFile = join(directory, "pid");
  const entry = join(directory, "helper.ts");
  const owner = join(directory, "owner.ts");
  await writeFile(entry, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); console.log('ready'); setInterval(() => {}, 1000);`);
  await writeFile(owner, `import { createWorkerProcessModule } from ${JSON.stringify(fileURLToPath(new URL("./worker-process.ts", import.meta.url)))};
    await createWorkerProcessModule().start({ command: process.execPath, args: [${JSON.stringify(fileURLToPath(new URL("./owned-helper.ts", import.meta.url)))}, ${JSON.stringify(entry)}], signal: new AbortController().signal, startupReadyMarker: 'ready' });`);
  const worker = spawn(process.execPath, [owner], { stdio: "ignore" });
  const workerExited = new Promise<void>((resolve) => worker.once("close", () => resolve()));
  let helperPid: number | undefined;
  const alive = () => {
    if (!helperPid) return false;
    try { process.kill(helperPid, 0); return true; } catch { return false; }
  };
  try {
    for (let i = 0; i < 100 && !helperPid; i++) {
      try { helperPid = Number(await readFile(pidFile, "utf8")); } catch { await Bun.sleep(20); }
    }
    expect(helperPid).toBeGreaterThan(0);
    expect(alive()).toBe(true);
    worker.kill("SIGKILL");
    await workerExited;
    for (let i = 0; i < 100 && alive(); i++) await Bun.sleep(20);
    expect(alive()).toBe(false);
  } finally {
    worker.kill("SIGKILL");
    await workerExited;
    if (alive()) process.kill(helperPid!, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("worker process accepts declared exit codes and returns binary stdout", async () => {
  const workerProcess = createWorkerProcessModule({ killGraceMs: 20 });

  const result = await workerProcess.execute({
    command: process.execPath,
    args: ["-e", "process.stdout.write(Buffer.from([0, 255, 1])); process.exit(101)"],
    signal: new AbortController().signal,
    deadlineMs: 1_000,
    acceptableExitCodes: [0, 101],
    captureStdout: true,
  });

  expect(result.exitCode).toBe(101);
  expect([...result.stdout]).toEqual([0, 255, 1]);
});

test("worker process reaps a persistent helper when its owner shuts down", async () => {
  const controller = new AbortController();
  const helper = await createWorkerProcessModule({ killGraceMs: 20 }).start?.({
    command: "sh",
    args: ["-c", "echo ready; sleep 60"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    signal: controller.signal,
  });
  expect(helper).toBeDefined();
  controller.abort();
  const outcome = await helper!.exited;
  expect(outcome.signalCode).not.toBeNull();
});

test("persistent helper bounds startup readiness and terminates on timeout", async () => {
  await expect(createWorkerProcessModule({ killGraceMs: 20 }).start?.({
    command: "sh", args: ["-c", "sleep 60"], cwd: process.cwd(), env: { PATH: process.env.PATH },
    signal: new AbortController().signal, startupReadyMarker: "ready", startupDeadlineMs: 20,
  })).rejects.toMatchObject({ code: "worker_process_startup_timeout", failureScope: "executor", executableClass: "other" });
});

test("persistent helper reaps a descendant after its parent exits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "narriflow-helper-descendant-"));
  const childPidPath = join(directory, "child.pid");
  let childPid: number | undefined;
  try {
    const helper = await createWorkerProcessModule({ killGraceMs: 20 }).start?.({
      command: process.execPath,
      args: ["-e", [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
        "process.exit(0);",
      ].join(" ")],
      signal: new AbortController().signal,
    });
    expect((await helper!.exited).exitCode).toBe(0);
    childPid = Number(await readFile(childPidPath, "utf8"));
    expect(() => process.kill(childPid!, 0)).toThrow();
  } finally {
    if (childPid) {
      try { process.kill(childPid, "SIGKILL"); } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistent startup failures discard sensitive stdout and preserve cancellation", async () => {
  const events: WorkerProcessDiagnostic[] = [];
  let failure: unknown;
  try {
    await createWorkerProcessModule({ killGraceMs: 20 }).start?.({
      command: "sh", args: ["-c", "echo opaque-test-token; exit 1"], cwd: process.cwd(),
      env: { PATH: process.env.PATH }, signal: new AbortController().signal,
      startupReadyMarker: "ready", startupDeadlineMs: 1000, diagnose: (event) => events.push(event),
    });
  } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: "worker_process_startup_failed", diagnostic: "" });
  expect(JSON.stringify(events)).not.toContain("opaque-test-token");
  expect(events.some((event) => event.operation === "exit" && event.status === "failed")).toBe(true);
  const controller = new AbortController();
  const reason = new Error("worker shutdown");
  const pending = createWorkerProcessModule({ killGraceMs: 20 }).start?.({
    command: "sh", args: ["-c", "sleep 60"], cwd: process.cwd(), env: { PATH: process.env.PATH },
    signal: controller.signal, startupReadyMarker: "ready", startupDeadlineMs: 1000,
  });
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
});

test("persistent startup failures report startup stderr but never stdout", async () => {
  let failure: unknown;
  try {
    await createWorkerProcessModule({ killGraceMs: 20 }).start?.({
      command: "sh", args: ["-c", "echo opaque-test-token; echo 'error: config file missing' >&2; exit 1"],
      cwd: process.cwd(), env: { PATH: process.env.PATH }, signal: new AbortController().signal,
      startupReadyMarker: "ready", startupDeadlineMs: 1000,
    });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(WorkerProcessFailure);
  const { diagnostic, exitCode } = failure as WorkerProcessFailure;
  expect(diagnostic).toContain("error: config file missing");
  expect(diagnostic).not.toContain("opaque-test-token");
  expect(exitCode).toBe(1);
});

test("a ready persistent helper keeps draining stderr", async () => {
  const helper = await createWorkerProcessModule({ killGraceMs: 20 }).start?.({
    command: "sh", args: ["-c", "echo ready; head -c 300000 /dev/zero | tr '\\0' x >&2; exit 0"],
    cwd: process.cwd(), env: { PATH: process.env.PATH }, signal: new AbortController().signal,
    startupReadyMarker: "ready", startupDeadlineMs: 1000,
  });
  expect((await helper!.exited).exitCode).toBe(0);
});

test("worker process returns captured text as bytes", async () => {
  const result = await createWorkerProcessModule({ killGraceMs: 20 }).execute({
    command: process.execPath,
    args: ["-e", "process.stdout.write('hello worker')"],
    signal: new AbortController().signal,
    deadlineMs: 1_000,
    captureStdout: true,
  });

  expect(result.stdout.toString("utf8")).toBe("hello worker");
});

test("worker process drains uncaptured stdout", async () => {
  const result = await createWorkerProcessModule({ killGraceMs: 20 }).execute({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"],
    signal: new AbortController().signal,
    deadlineMs: 1_000,
  });

  expect(result.stdout).toHaveLength(0);
});

test("worker process rejects a pre-aborted request without spawning", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancelled", "AbortError");
  const diagnostics: WorkerProcessDiagnostic[] = [];
  controller.abort(reason);

  await expect(
    createWorkerProcessModule({ killGraceMs: 20 }).execute({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      signal: controller.signal,
      deadlineMs: 1_000,
      diagnose: (event) => diagnostics.push(event),
    }),
  ).rejects.toBe(reason);
  expect(diagnostics.map((event) => event.operation)).toEqual(["cancellation"]);
});

test("worker process classifies a missing executable as configuration health", async () => {
  const diagnostics: WorkerProcessDiagnostic[] = [];
  await expect(
    createWorkerProcessModule({ killGraceMs: 20 }).execute({
      command: "narriflow-command-that-does-not-exist",
      args: [],
      signal: new AbortController().signal,
      deadlineMs: 1_000,
      diagnose: (event) => diagnostics.push(event),
    }),
  ).rejects.toMatchObject({
    code: "worker_command_unavailable",
    disposition: "retryable",
    failureScope: "configuration",
    errno: "ENOENT",
  });
  expect(diagnostics).toContainEqual(
    expect.objectContaining({
      operation: "spawn",
      failureCode: "worker_command_unavailable",
    }),
  );
});

test("worker process preserves cancellation when a spawn error races the abort", async () => {
  const controller = new AbortController();
  const reason = { kind: "shutdown-during-spawn" };
  const executing = createWorkerProcessModule({ killGraceMs: 20 }).execute({
    command: "narriflow-command-that-does-not-exist",
    args: [],
    signal: controller.signal,
    deadlineMs: 1_000,
  });
  controller.abort(reason);

  await expect(executing).rejects.toBe(reason);
});

test.skipIf(process.platform === "win32")(
  "worker process classifies a forbidden executable as configuration health with its cause",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "narriflow-spawn-error-contract-"));
    const command = join(directory, "not-executable");
    const diagnostics: WorkerProcessDiagnostic[] = [];
    try {
      await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
      let failure: unknown;
      try {
        await createWorkerProcessModule({ killGraceMs: 20 }).execute({
          command,
          args: [],
          signal: new AbortController().signal,
          deadlineMs: 1_000,
          diagnose: (event) => diagnostics.push(event),
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(WorkerProcessFailure);
      expect(failure).toMatchObject({
        code: "worker_command_unavailable",
        disposition: "retryable",
        failureScope: "configuration",
        errno: "EACCES",
        cause: expect.any(Error),
      });
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          operation: "spawn",
          status: "failed",
          failureCode: "worker_command_unavailable",
          disposition: "retryable",
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("worker process classifies invalid input and bounds redacted diagnostics", async () => {
  const secretUrl = `https://media.example/video.mp4?token=${"secret".repeat(2_000)}`;
  let failure: unknown;
  try {
    await createWorkerProcessModule({ killGraceMs: 20 }).execute({
      command: process.execPath,
      args: [
        "-e",
        `console.error(${JSON.stringify(`Invalid data found when processing input ${secretUrl}`)}); process.exit(1)`,
      ],
      signal: new AbortController().signal,
      deadlineMs: 1_000,
    });
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(WorkerProcessFailure);
  expect(failure).toMatchObject({
    code: "worker_command_input_invalid",
    disposition: "permanent",
  });
  expect((failure as WorkerProcessFailure).diagnostic.length).toBeLessThanOrEqual(8_192);
  expect((failure as WorkerProcessFailure).diagnostic).not.toContain("secret");
  expect((failure as WorkerProcessFailure).diagnostic).toContain("?[redacted]");
});

test("worker process removes authenticated proxy credentials from failures", async () => {
  let failure: unknown;
  try {
    await createWorkerProcessModule().execute({
      command: process.execPath,
      args: ["-e", 'console.error("Proxy connection failed: http://private-user:p%40ss@proxy.example:8080 and socks5h://other:secret@proxy.example:1080"); process.exit(1)'],
      signal: new AbortController().signal,
      deadlineMs: 1_000,
    });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(WorkerProcessFailure);
  const text = `${(failure as WorkerProcessFailure).message} ${(failure as WorkerProcessFailure).diagnostic}`;
  expect(text).toContain("http://[redacted]@proxy.example:8080");
  expect(text).toContain("socks5h://[redacted]@proxy.example:1080");
  for (const secret of ["private-user", "p%40ss", "other", "secret"]) {
    expect(text).not.toContain(secret);
  }
});

test("worker process classifies other nonzero exits as retryable", async () => {
  await expect(
    createWorkerProcessModule({ killGraceMs: 20 }).execute({
      command: process.execPath,
      args: ["-e", "console.error('encoder unavailable'); process.exit(7)"],
      signal: new AbortController().signal,
      deadlineMs: 1_000,
    }),
  ).rejects.toMatchObject({
    code: "worker_command_failed",
    disposition: "retryable",
    exitCode: 7,
  });
});

test("worker process terminates captured output that exceeds the caller limit", async () => {
  const diagnostics: WorkerProcessDiagnostic[] = [];
  await expect(
    createWorkerProcessModule({ killGraceMs: 20 }).execute({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(4096))"],
      signal: new AbortController().signal,
      deadlineMs: 1_000,
      captureStdout: true,
      maxStdoutBytes: 128,
      diagnose: (event) => diagnostics.push(event),
    }),
  ).rejects.toMatchObject({
    code: "worker_command_output_too_large",
    disposition: "permanent",
  });
  expect(diagnostics).toContainEqual(
    expect.objectContaining({
      operation: "output_limit",
      failureCode: "worker_command_output_too_large",
    }),
  );
});

test("worker process samples worker and command memory", async () => {
  const commandBytes: number[] = [];

  await createWorkerProcessModule({ killGraceMs: 20 }).execute({
    command: process.execPath,
    args: [
      "-e",
      "const held = Buffer.alloc(64 * 1024 * 1024, 1); setTimeout(() => process.exit(held[0] === 1 ? 0 : 1), 350)",
    ],
    signal: new AbortController().signal,
    deadlineMs: 2_000,
    // The worker may release memory while the command runs. Compare each
    // sample with its current RSS, not a baseline from before that release.
    recordResourceSample: (rssBytes) => commandBytes.push(rssBytes - process.memoryUsage().rss),
  });

  expect(commandBytes.length).toBeGreaterThan(0);
  expect(Math.max(...commandBytes)).toBeGreaterThan(32 * 1024 * 1024);
});

test("worker process times out and escalates from TERM to KILL", async () => {
  const diagnostics: WorkerProcessDiagnostic[] = [];
  await expect(
    createWorkerProcessModule({ killGraceMs: 20 }).execute({
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      signal: new AbortController().signal,
      deadlineMs: 20,
      diagnose: (event) => diagnostics.push(event),
    }),
  ).rejects.toMatchObject({
    code: "worker_command_timeout",
    disposition: "retryable",
  });
  expect(diagnostics).toContainEqual(expect.objectContaining({ operation: "timeout" }));
  expect(diagnostics).toContainEqual(
    expect.objectContaining({
      operation: "termination",
      terminationSignal: "SIGTERM",
    }),
  );
  expect(diagnostics).toContainEqual(
    expect.objectContaining({
      operation: "termination",
      terminationSignal: "SIGKILL",
    }),
  );
});

test("worker process reaps descendants when the root exits during escalation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "narriflow-process-contract-"));
  const childPidPath = join(directory, "child.pid");
  let childPid: number | null = null;

  try {
    await expect(
      createWorkerProcessModule({ killGraceMs: 50 }).execute({
        command: process.execPath,
        args: [
          "-e",
          [
            "const { spawn } = require('node:child_process');",
            "const { writeFileSync } = require('node:fs');",
            "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
            `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        signal: new AbortController().signal,
        deadlineMs: 100,
      }),
    ).rejects.toMatchObject({ code: "worker_command_timeout" });

    childPid = Number(await readFile(childPidPath, "utf8"));
    expect(() => process.kill(childPid!, 0)).toThrow();
  } finally {
    if (childPid) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("worker process preserves the exact Workflow Attempt abort after reaping", async () => {
  const controller = new AbortController();
  const reason = new WorkflowAttemptLost({
    workflowRunId: "10000000-0000-0000-0000-000000000001",
    projectId: "20000000-0000-0000-0000-000000000002",
    stage: "clip_rendering",
    attemptId: "30000000-0000-0000-0000-000000000003",
    attemptCount: 1,
  });
  const executing = createWorkerProcessModule({ killGraceMs: 20 }).execute({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    signal: controller.signal,
    deadlineMs: 5_000,
  });
  controller.abort(reason);

  await expect(executing).rejects.toBe(reason);
});

test("worker process preserves a non-Error abort reason after reaping", async () => {
  const controller = new AbortController();
  const reason = { kind: "worker-shutdown" };
  const executing = createWorkerProcessModule({ killGraceMs: 20 }).execute({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    signal: controller.signal,
    deadlineMs: 5_000,
  });
  controller.abort(reason);

  await expect(executing).rejects.toBe(reason);
});

test("media inspection normalizes duration, streams, dimensions, fps, and HTTP controls", async () => {
  const controller = new AbortController();
  let received: WorkerProcessRequest | null = null;
  const module = createWorkerProcessModule({
    execute: async (request) => {
      received = request;
      return {
        exitCode: 0,
        stdout: Buffer.from(
          JSON.stringify({
            format: { duration: "12.5" },
            streams: [
              {
                codec_type: "video",
                width: 1920,
                height: 1080,
                r_frame_rate: "30000/1001",
                avg_frame_rate: "30000/1001",
              },
              { codec_type: "audio", sample_rate: "48000", channels: 2 },
            ],
          }),
        ),
      };
    },
  });

  const inspection = await module.inspectMedia({
    sourcePath: "https://media.example/source.mp4?signature=secret",
    signal: controller.signal,
    deadlineMs: 2_000,
  });

  expect(inspection).toMatchObject({
    durationSec: 12.5,
    width: 1920,
    height: 1080,
    hasVideo: true,
    hasAudio: true,
    hasVisualStream: true,
    fps: 30000 / 1001,
    sourceProbe: {
      durationSec: 12.5,
      video: { width: 1920, height: 1080, frameRate: { numerator: 30000, denominator: 1001 }, startTimecode: null },
      audio: { sampleRate: 48000, channels: 2 },
    },
  });
  expect(received).toMatchObject({
    command: "ffprobe",
    signal: controller.signal,
    deadlineMs: 2_000,
    captureStdout: true,
  });
  expect(received!.args).toContain("-rw_timeout");
  expect(received!.args.slice(0, 2)).toEqual(["-v", "error"]);
});

test("media inspection does not classify attached cover art as playable video", async () => {
  const module = createWorkerProcessModule({
    execute: async () => ({
      exitCode: 0,
      stdout: Buffer.from(
        JSON.stringify({
          streams: [
            {
              codec_type: "video",
              codec_name: "mjpeg",
              width: 600,
              height: 600,
              nb_frames: "1",
              disposition: { attached_pic: 1 },
            },
            { codec_type: "audio", duration: "48" },
          ],
        }),
      ),
    }),
  });

  expect(
    await module.inspectMedia({
      sourcePath: "/tmp/podcast.mp3",
      signal: new AbortController().signal,
      deadlineMs: 1_000,
    }),
  ).toMatchObject({
    durationSec: 48,
    width: 0,
    height: 0,
    hasVideo: false,
    hasAudio: true,
    hasVisualStream: true,
    fps: 30,
    sourceProbe: { durationSec: 48, video: null, audio: null },
  });
});

async function probeOf(streams: unknown[], format: unknown = { duration: "30" }) {
  const module = createWorkerProcessModule({
    execute: async () => ({ exitCode: 0, stdout: Buffer.from(JSON.stringify({ format, streams })) }),
  });
  const { sourceProbe } = await module.inspectMedia({
    sourcePath: "/tmp/source.mov",
    signal: new AbortController().signal,
    deadlineMs: 1_000,
  });
  return sourceProbe;
}

const videoStream = (rates: { r_frame_rate?: string; avg_frame_rate?: string }, extra: Record<string, unknown> = {}) =>
  ({ codec_type: "video", width: 1920, height: 1080, ...rates, ...extra });

describe("the source probe's frame rate", () => {
  test.each([
    ["a constant 30 fps file whose average drifts to 29.98 stays 30", { r_frame_rate: "30/1", avg_frame_rate: "2998/100" }, { numerator: 30, denominator: 1 }],
    ["a constant 29.97 file whose average reads 30 stays 29.97", { r_frame_rate: "30000/1001", avg_frame_rate: "30/1" }, { numerator: 30000, denominator: 1001 }],
    ["a base rate with no average (0/0) is used", { r_frame_rate: "30000/1001", avg_frame_rate: "0/0" }, { numerator: 30000, denominator: 1001 }],
    ["an average with no base rate is used", { avg_frame_rate: "25/1" }, { numerator: 25, denominator: 1 }],
    ["a variable-rate file's absurd base rate falls back to its standard average", { r_frame_rate: "90000/1", avg_frame_rate: "29970/1000" }, { numerator: 30000, denominator: 1001 }],
    ["a rounded decimal base rate snaps to the exact fraction", { r_frame_rate: "2997/100", avg_frame_rate: "0/0" }, { numerator: 30000, denominator: 1001 }],
  ])("%s", async (_name, rates, expected) => {
    expect((await probeOf([videoStream(rates)]))?.video?.frameRate).toEqual(expected);
  });

  test("a rate matching no standard is stored as measured, for the export to refuse", async () => {
    expect((await probeOf([videoStream({ r_frame_rate: "25/2", avg_frame_rate: "25/2" })]))?.video?.frameRate).toEqual({ numerator: 25, denominator: 2 });
    expect((await probeOf([videoStream({ r_frame_rate: "90000/1", avg_frame_rate: "0/0" })]))?.video?.frameRate).toEqual({ numerator: 90000, denominator: 1 });
    expect((await probeOf([videoStream({ r_frame_rate: "90000/1", avg_frame_rate: "15/1" })]))?.video?.frameRate).toEqual({ numerator: 15, denominator: 1 });
  });

  test("a video with no readable rate has no video facts", async () => {
    expect((await probeOf([videoStream({ r_frame_rate: "0/0", avg_frame_rate: "0/0" }), { codec_type: "audio", sample_rate: "48000" }]))?.video).toBeNull();
  });
});

describe("the source probe's start timecode", () => {
  const rates = { r_frame_rate: "30000/1001", avg_frame_rate: "30000/1001" };

  test("a file without a timecode starts at none", async () => {
    expect((await probeOf([videoStream(rates)]))?.video?.startTimecode).toBeNull();
  });

  test.each([
    ["the video stream", [videoStream(rates, { tags: { timecode: "01:00:00:00" } })], { duration: "30" }, "01:00:00:00"],
    ["a timecode track, keeping the drop-frame mark", [videoStream(rates), { codec_type: "data", codec_tag_string: "tmcd", tags: { timecode: "10:15:30;12" } }], { duration: "30" }, "10:15:30;12"],
    ["the container", [videoStream(rates)], { duration: "30", tags: { timecode: "00:59:58:00" } }, "00:59:58:00"],
    ["a differently cased tag", [videoStream(rates, { tags: { TIMECODE: "02:00:00:00" } })], { duration: "30" }, "02:00:00:00"],
  ])("is read from %s", async (_name, streams, format, expected) => {
    expect((await probeOf(streams, format))?.video?.startTimecode).toBe(expected);
  });

  test("the video stream's timecode wins over the container's", async () => {
    expect((await probeOf([videoStream(rates, { tags: { timecode: "01:00:00:00" } })], { duration: "30", tags: { timecode: "05:00:00:00" } }))?.video?.startTimecode).toBe("01:00:00:00");
  });

  test("a value that is not a timecode is ignored", async () => {
    expect((await probeOf([videoStream(rates, { tags: { timecode: "not a timecode" } })]))?.video?.startTimecode).toBeNull();
  });
});

test("media inspection rejects malformed output and empty media", async () => {
  const malformed = createWorkerProcessModule({
    execute: async () => ({ exitCode: 0, stdout: Buffer.from("not json") }),
  });
  const empty = createWorkerProcessModule({
    execute: async () => ({
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify({ streams: [] })),
    }),
  });
  const nonMedia = createWorkerProcessModule({
    execute: async () => ({
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify({ streams: [{ codec_type: "subtitle" }] })),
    }),
  });
  const request = {
    sourcePath: "/tmp/corrupt.mp4",
    signal: new AbortController().signal,
    deadlineMs: 1_000,
  };

  await expect(malformed.inspectMedia(request)).rejects.toMatchObject({
    code: "source_media_invalid",
    disposition: "permanent",
  });
  await expect(empty.inspectMedia(request)).rejects.toMatchObject({
    code: "source_media_invalid",
    disposition: "permanent",
  });
  await expect(nonMedia.inspectMedia(request)).rejects.toMatchObject({
    code: "source_media_invalid",
    disposition: "permanent",
  });
});

test("media inspection normalizes a decoder input failure as invalid media", async () => {
  const module = createWorkerProcessModule({
    execute: async () => {
      throw new WorkerProcessFailure(
        "worker_command_input_invalid",
        "permanent",
        "invalid input",
        "Invalid data found when processing input",
        1,
      );
    },
  });

  await expect(
    module.inspectMedia({
      sourcePath: "/tmp/corrupt.mp4",
      signal: new AbortController().signal,
      deadlineMs: 1_000,
    }),
  ).rejects.toMatchObject({
    code: "source_media_invalid",
    disposition: "permanent",
  });
});

test("scratch lifetime removes its directory after success and failure", async () => {
  const removed: string[] = [];
  const module = createWorkerProcessModule({
    createScratchDirectory: async (prefix) => `/tmp/${prefix}one`,
    removeScratchDirectory: async (directory) => {
      removed.push(directory);
    },
  });
  const causalError = new Error("body failed");

  await expect(
    module.withScratchDirectory("success-", async (directory) => directory),
  ).resolves.toBe("/tmp/success-one");
  await expect(
    module.withScratchDirectory("failure-", async () => {
      throw causalError;
    }),
  ).rejects.toBe(causalError);
  expect(removed).toEqual(["/tmp/success-one", "/tmp/failure-one"]);
});

test("scratch cleanup failures are report-only for success and causal failure", async () => {
  const diagnostics: WorkerProcessDiagnostic[] = [];
  const causalError = new Error("body failed");
  const module = createWorkerProcessModule({
    createScratchDirectory: async () => "/tmp/narriflow-test-scratch",
    removeScratchDirectory: async () => {
      throw new Error("cleanup failed");
    },
  });

  await expect(
    module.withScratchDirectory(
      "success-",
      async () => "durable success",
      (event) => diagnostics.push(event),
    ),
  ).resolves.toBe("durable success");
  await expect(
    module.withScratchDirectory(
      "failure-",
      async () => {
        throw causalError;
      },
      (event) => diagnostics.push(event),
    ),
  ).rejects.toBe(causalError);
  expect(diagnostics).toHaveLength(2);
  expect(diagnostics).toEqual([
    expect.objectContaining({ operation: "scratch_cleanup", status: "failed" }),
    expect.objectContaining({ operation: "scratch_cleanup", status: "failed" }),
  ]);
});

const FFMPEG_AVAILABLE = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const FFPROBE_AVAILABLE = spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

test.skipIf(!FFMPEG_AVAILABLE || !FFPROBE_AVAILABLE)(
  "media inspection handles an isolated real fixture",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "narriflow-media-contract-"));
    const sourcePath = join(directory, "source.mp4");
    try {
      const generated = spawnSync("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=320x180:r=24:d=0.2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=0.2",
        "-shortest",
        "-c:v",
        "mpeg4",
        "-c:a",
        "aac",
        sourcePath,
      ]);
      expect(generated.status).toBe(0);

      expect(
        await createWorkerProcessModule({ killGraceMs: 50 }).inspectMedia({
          sourcePath,
          signal: new AbortController().signal,
          deadlineMs: 5_000,
        }),
      ).toMatchObject({
        width: 320,
        height: 180,
        hasVideo: true,
        hasAudio: true,
        hasVisualStream: true,
        fps: 24,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(!FFPROBE_AVAILABLE)(
  "media inspection classifies a real corrupt file as permanent invalid media",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "narriflow-corrupt-media-contract-"));
    const sourcePath = join(directory, "corrupt.mp4");
    try {
      await writeFile(sourcePath, "this is not media");
      await expect(
        createWorkerProcessModule({ killGraceMs: 50 }).inspectMedia({
          sourcePath,
          signal: new AbortController().signal,
          deadlineMs: 5_000,
        }),
      ).rejects.toMatchObject({
        code: "source_media_invalid",
        disposition: "permanent",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);


describe("process-start health", () => {
  for (const errno of ["EBADF", "EMFILE", "ENFILE", "EAGAIN", "ENOENT", "EACCES", "EPERM"]) {
    test(`${errno} has the same code and safe diagnostics for sync/async execute/helper starts`, async () => {
      const failures: WorkerProcessFailure[] = [];
      const diagnostics: unknown[] = [];
      for (const mode of ["sync", "async"]) {
        for (const operation of ["execute", "start"]) {
          const events: WorkerProcessDiagnostic[] = [];
          const cause = Object.assign(new Error("posix_spawn private-path https://x.test/a?token=secret"), { code: errno });
          const fakeSpawn = (() => {
            if (mode === "sync") throw cause;
            const child = Object.assign(new EventEmitter(), {
              stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
            });
            queueMicrotask(() => { child.emit("error", cause); child.emit("close", null, null); });
            return child;
          }) as unknown as typeof spawn;
          const module = createWorkerProcessModule({ spawn: fakeSpawn });
          const request = {
            command: "/private/toolchain/ffprobe", args: ["https://x.test/a?token=secret"],
            signal: new AbortController().signal, deadlineMs: 1000, startupDeadlineMs: 1000,
            cwd: process.cwd(), env: {}, diagnose: (event: WorkerProcessDiagnostic) => events.push(event),
          };
          let error: unknown;
          try { await module[operation as "execute"](request); } catch (caught) { error = caught; }
          expect(error).toBeInstanceOf(WorkerProcessFailure);
          const failure = error as WorkerProcessFailure;
          expect(failure.cause).toBe(cause);
          expect(failure).toMatchObject({ errno, executableClass: "ffprobe", disposition: "retryable" });
          expect(`${failure.message} ${failure.diagnostic} ${JSON.stringify(events)}`).not.toMatch(/secret|private-path|https:/);
          failures.push(failure);
          diagnostics.push(events.filter((event) => event.operation === "spawn").map(({ elapsedMs: _, ...event }) => event));
        }
      }
      expect(new Set(failures.map((failure) => failure.code)).size).toBe(1);
      expect(failures.every((failure) => failure.diagnostic === failures[0]!.diagnostic)).toBe(true);
      for (const diagnostic of diagnostics) expect(diagnostic).toEqual(diagnostics[0]);
      expect(failures[0]!.failureScope).toBe(["ENOENT", "EACCES", "EPERM"].includes(errno) ? "configuration" : "executor");
    });
  }

  test("pre-aborted execute, inspection and helper starts never reach spawn or injected execution", async () => {
    let starts = 0;
    const module = createWorkerProcessModule({ spawn: (() => { starts++; throw new Error("must not spawn"); }) as typeof spawn });
    const reason = { shutdown: true };
    const signal = AbortSignal.abort(reason);
    await expect(module.execute({ command: "ffprobe", args: [], signal, deadlineMs: 1000 })).rejects.toBe(reason);
    await expect(module.start!({ command: "ffprobe", args: [], signal, cwd: process.cwd(), env: {} })).rejects.toBe(reason);
    await expect(module.inspectMedia({ sourcePath: "unused.mp4", signal, deadlineMs: 1000 })).rejects.toBe(reason);
    const injected = createWorkerProcessModule({ execute: async () => { starts++; throw new Error("must not execute"); } });
    await expect(injected.execute({ command: "ffprobe", args: [], signal, deadlineMs: 1000 })).rejects.toBe(reason);
    expect(starts).toBe(0);
  });

  test("helper without a readiness marker still awaits the spawn result", async () => {
    await expect(createWorkerProcessModule().start!({
      command: "narriflow-not-an-executable", args: [], signal: new AbortController().signal, cwd: process.cwd(), env: {},
    })).rejects.toMatchObject({ code: "worker_command_unavailable", errno: "ENOENT", failureScope: "configuration" });
  });

  test("inspection propagates executor health instead of blaming source media", async () => {
    const cause = Object.assign(new Error("posix_spawn"), { code: "EBADF" });
    const module = createWorkerProcessModule({ spawn: (() => { throw cause; }) as typeof spawn });
    await expect(module.inspectMedia({ sourcePath: "https://x.test/a?token=secret", signal: new AbortController().signal, deadlineMs: 1000 }))
      .rejects.toMatchObject({ code: "worker_command_spawn_failed", errno: "EBADF", cause, executableClass: "ffprobe" });
  });
});

test("complete probe facts retain geometry, clocks, late audio and HDR without changing old consumer fields", async () => {
  const matrix = "\n00000000:            0      -65536           0\n00000001:       -65536           0           0\n00000002:            0           0  1073741824\n";
  const probe = await probeOf([
    { codec_type: "video", index: 0, codec_name: "mjpeg", disposition: { attached_pic: 1 }, width: 600, height: 600 },
    videoStream({ r_frame_rate: "90000/1", avg_frame_rate: "15/1" }, {
      index: 1, codec_name: "hevc", profile: "Main 10", coded_width: 1920, coded_height: 1088,
      sample_aspect_ratio: "2:1", pix_fmt: "yuv420p10le", time_base: "1/90000", start_pts: -9000, start_time: "-0.1",
      duration: "30", duration_ts: 2700000, nb_frames: "N/A", color_transfer: "smpte2084", color_primaries: "bt2020", color_space: "bt2020nc", color_range: "tv",
      side_data_list: [
        { side_data_type: "Display Matrix", displaymatrix: matrix, rotation: 90 },
        { side_data_type: "Mastering display metadata", max_luminance: "10000000/10000", min_luminance: "50/10000" },
        { side_data_type: "Content light level metadata", max_content: 1000, max_average: 400 },
        { side_data_type: "DOVI configuration record", dv_profile: 8, dv_level: 6, rpu_present_flag: 1, el_present_flag: 0, bl_present_flag: 1, dv_bl_signal_compatibility_id: 1 },
      ],
    }),
    { codec_type: "audio", index: 2, codec_name: "aac", profile: "LC", sample_rate: "44100", channels: 1, channel_layout: "mono", time_base: "1/44100", start_time: "0.4", duration: "20", initial_padding: 1024 },
  ], { duration: "30", size: "123456", format_name: "mov,mp4", start_time: "-0.1" });
  expect(sourceProbeSchema.parse(probe)).toEqual(probe);
  expect(probe?.video).toMatchObject({ width: 1920, height: 1080, frameRate: { numerator: 15, denominator: 1 } });
  expect(probe?.facts).toMatchObject({
    attachedPictureCount: 1, format: { sizeBytes: 123456, startTimeSec: -0.1 },
    videos: [{ index: 1, width: 1920, height: 1080, codedHeight: 1088, displayWidth: 1080, displayHeight: 3840,
      rotationDeg: 90, reflected: true, sampleAspectRatio: { numerator: 2, denominator: 1 },
      avgFrameRate: { numerator: 15, denominator: 1 }, rFrameRate: { numerator: 90000, denominator: 1 },
      timeBase: { numerator: 1, denominator: 90000 }, startTimeSec: -0.1, endTimeSec: 29.9, frameCount: null,
      pixelFormat: "yuv420p10le", colorTransfer: "smpte2084", colorPrimaries: "bt2020", colorSpace: "bt2020nc",
      masteringDisplay: { maxLuminance: 1000, minLuminance: 0.005 }, contentLight: { maxContent: 1000, maxAverage: 400 },
      dolbyVision: { profile: 8, baseLayerPresent: true, enhancementLayerPresent: false } }],
    audios: [{ startTimeSec: 0.4, durationSec: 20, endTimeSec: 20.4, sampleRate: 44100, channels: 1, initialPadding: 1024 }],
  });
});

test.each([
  ["0 -65536 0", "65536 0 0", 90, false, 1080, 1920],
  ["-65536 0 0", "0 -65536 0", -180, false, 1920, 1080],
  ["0 65536 0", "-65536 0 0", -90, false, 1080, 1920],
  ["-65536 0 0", "0 65536 0", -180, true, 1920, 1080],
])("display matrix %s / %s is retained", async (row1, row2, rotationDeg, reflected, displayWidth, displayHeight) => {
  const probe = await probeOf([videoStream({ r_frame_rate: "30/1" }, {
    sample_aspect_ratio: "1:1", side_data_list: [{ side_data_type: "Display Matrix", displaymatrix: `0: ${row1}\n1: ${row2}\n2: 0 0 1073741824` }],
  })]);
  expect(probe?.facts?.videos[0]).toMatchObject({ rotationDeg, reflected, displayWidth, displayHeight });
});

test("unreported facts stay null, including frame counts and invalid ratios", async () => {
  const probe = await probeOf([videoStream({ r_frame_rate: "0/0" }, { sample_aspect_ratio: "0:1", nb_frames: "N/A" })]);
  expect(probe?.facts?.videos[0]).toMatchObject({ sampleAspectRatio: null, rFrameRate: null, avgFrameRate: null, frameCount: null, timeBase: null });
  expect(sourceProbeSchema.safeParse(probe).success).toBe(true);
});

test("frame and packet sampling has a bounded input budget, output and shared deadline", async () => {
  for (const kind of ["frames", "packets"] as const) {
    const calls: WorkerProcessRequest[] = [];
    const module = createWorkerProcessModule({ execute: async (request) => {
      calls.push(request);
      return { exitCode: 0, stdout: Buffer.from(JSON.stringify(calls.length === 1
        ? { streams: [videoStream({ r_frame_rate: "30/1" })], format: { duration: "30" } }
        : { [kind]: [{ stream_index: 0, pts: 9000, pts_time: "0.1", duration: 6000, duration_time: "0.0666667", nb_samples: 1024, key_frame: 1 }] })) };
    }});
    const inspection = await module.inspectMedia({ sourcePath: "https://x.test/a?token=secret", signal: new AbortController().signal, deadlineMs: 5000,
      sample: { kind, streamIndex: 0, startSec: 2, maxPackets: 150 } });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toContain("2%+#150");
    expect(calls[1]!.args).toContain(`-show_${kind}`);
    expect(calls[1]!.args).toContain("-rw_timeout");
    expect(calls[1]!.deadlineMs).toBeLessThanOrEqual(5000);
    expect(calls[1]!.maxStdoutBytes).toBe(4 * 1024 * 1024);
    expect(inspection.samples?.items).toEqual([expect.objectContaining({ pts: 9000, ptsSec: 0.1, duration: 6000, durationSec: 0.0666667, samples: 1024, keyFrame: true })]);
  }
  let calls = 0;
  const module = createWorkerProcessModule({ execute: async () => { calls++; throw new Error("should not execute"); } });
  for (const sample of [
    { kind: "frames" as const, streamIndex: 0, maxPackets: 4097 },
    { kind: "frames" as const, streamIndex: 0, maxPackets: 0 },
    { kind: "packets" as const, streamIndex: 0, startSec: -1, maxPackets: 1 },
    { kind: "packets" as const, streamIndex: -1, maxPackets: 1 },
  ]) await expect(module.inspectMedia({ sourcePath: "unused.mp4", signal: new AbortController().signal, deadlineMs: 1000, sample })).rejects.toThrow("packet budget");
  expect(calls).toBe(0);
});

test.skipIf(!FFMPEG_AVAILABLE || !FFPROBE_AVAILABLE)("real probes expose matrices, SAR, HDR, late audio and bounded timestamps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "narriflow-probe-facts-"));
  const source = join(directory, "source.mp4");
  const module = createWorkerProcessModule();
  const signal = new AbortController().signal;
  try {
    const generated = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=320x180:r=15:d=1",
      "-itsoffset", "0.3", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=0.5",
      "-vf", "setsar=2/1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-x264-params", "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc", "-color_trc", "smpte2084", "-color_primaries", "bt2020", "-colorspace", "bt2020nc", "-c:a", "aac", source]);
    expect(generated.status).toBe(0);
    const inspection = await module.inspectMedia({ sourcePath: source, signal, deadlineMs: 5000,
      sample: { kind: "frames", streamIndex: 0, maxPackets: 6 } });
    expect(inspection.facts?.videos[0]).toMatchObject({ width: 320, height: 180, displayWidth: 640, displayHeight: 180,
      sampleAspectRatio: { numerator: 2, denominator: 1 }, colorTransfer: "smpte2084", colorPrimaries: "bt2020", frameCount: 15 });
    expect(inspection.facts!.audios[0]!.startTimeSec).toBeGreaterThan(0.25);
    expect(inspection.facts!.audios[0]!.endTimeSec).toBeLessThan(0.9);
    expect(inspection.facts!.format.sizeBytes).toBeGreaterThan(0);
    expect(inspection.samples!.items.length).toBeGreaterThan(0);
    expect(inspection.samples!.items.length).toBeLessThanOrEqual(6);
    expect(inspection.samples!.items[0]!.ptsSec).toBe(0);
    expect(sourceProbeSchema.parse(inspection.sourceProbe)).toEqual(inspection.sourceProbe);
    for (const angle of [90, 180, 270]) {
      const rotated = join(directory, `rot${angle}.mp4`);
      expect(spawnSync("ffmpeg", ["-v", "error", "-display_rotation", String(angle), "-i", source, "-c", "copy", rotated]).status).toBe(0);
      const rotatedProbe = await module.inspectMedia({ sourcePath: rotated, signal, deadlineMs: 5000 });
      expect(rotatedProbe.width).toBe(320);
      expect(rotatedProbe.height).toBe(180);
      expect(rotatedProbe.facts!.videos[0]!.displayMatrix).toHaveLength(9);
      expect(rotatedProbe.facts!.videos[0]!.displayWidth).toBe(angle === 180 ? 640 : 180);
      expect(rotatedProbe.facts!.videos[0]!.displayHeight).toBe(angle === 180 ? 180 : 640);
    }
    const hlg = join(directory, "hlg.mp4");
    expect(spawnSync("ffmpeg", ["-v", "error", "-i", source, "-c", "copy", "-bsf:v", "h264_metadata=transfer_characteristics=18", hlg]).status).toBe(0);
    expect((await module.inspectMedia({ sourcePath: hlg, signal, deadlineMs: 5000 })).facts!.videos[0]!.colorTransfer).toBe("arib-std-b67");
    const cover = join(directory, "cover.mp3");
    const picture = join(directory, "cover.jpg");
    expect(spawnSync("ffmpeg", ["-v", "error", "-i", source, "-frames:v", "1", picture]).status).toBe(0);
    expect(spawnSync("ffmpeg", ["-v", "error", "-i", source, "-i", picture, "-map", "0:a", "-map", "1:v", "-c:a", "libmp3lame", "-c:v", "copy", "-disposition:v", "attached_pic", cover]).status).toBe(0);
    const covered = await module.inspectMedia({ sourcePath: cover, signal, deadlineMs: 5000 });
    expect(covered).toMatchObject({ hasVideo: false, hasAudio: true, hasVisualStream: true });
    expect(covered.facts).toMatchObject({ attachedPictureCount: 1, videos: [] });
    const mirrored = join(directory, "mirrored.mp4");
    expect(spawnSync("ffmpeg", ["-v", "error", "-display_hflip", "-i", source, "-c", "copy", mirrored]).status).toBe(0);
    expect((await module.inspectMedia({ sourcePath: mirrored, signal, deadlineMs: 5000 })).facts!.videos[0]!.reflected).toBe(true);
    const packets = await module.inspectMedia({ sourcePath: source, signal, deadlineMs: 5000, sample: { kind: "packets", streamIndex: 1, maxPackets: 4 } });
    expect(packets.samples!.items.length).toBeLessThanOrEqual(4);
    expect(packets.samples!.items[0]!.streamIndex).toBe(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("long signed queries stay redacted across stderr chunks and capture truncation", async () => {
  for (const operation of ["execute", "start"] as const) {
    const module = createWorkerProcessModule({ killGraceMs: 20 });
    const request = {
      command: process.execPath,
      args: ["-e", `process.stderr.write('https://media.example/source.mp4?token='); setTimeout(() => { process.stderr.write('PRIVATE'.repeat(20000)); setTimeout(() => { process.stderr.write('TAILSECRET\\n'); process.exit(1); }, 30); }, 30);`],
      signal: new AbortController().signal, deadlineMs: 1000, startupDeadlineMs: 1000,
      cwd: process.cwd(), env: process.env, startupReadyMarker: "ready",
    };
    let failure: unknown;
    try { await module[operation](request); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(WorkerProcessFailure);
    expect((failure as WorkerProcessFailure).diagnostic).not.toMatch(/PRIVATE|TAILSECRET/);
    expect((failure as WorkerProcessFailure).diagnostic).toContain("?[redacted]");
    expect((failure as WorkerProcessFailure).diagnostic.length).toBeLessThanOrEqual(8192);
  }
});

describe("scratch ownership and the abandoned-directory sweep", () => {
  const OWNER_FILE = ".narriflow-scratch-owner.json";
  const HOUR_MS = 60 * 60 * 1000;
  let root = "";

  async function withRoot<T>(work: (root: string) => Promise<T>): Promise<T> {
    root = await mkdtemp(join(tmpdir(), "narriflow-sweep-test-"));
    try {
      return await work(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  async function abandoned(
    parent: string,
    name: string,
    options: { ageMs?: number; host?: string; marker?: boolean; ownership?: { attemptId: string } } = {},
  ): Promise<string> {
    const directory = join(parent, name);
    await mkdir(directory);
    await writeFile(join(directory, "partial.mp4"), "bytes");
    if (options.marker !== false) {
      const marker = join(directory, OWNER_FILE);
      await writeFile(
        marker,
        JSON.stringify({
          version: 1,
          instanceId: "dead-worker",
          host: options.host ?? hostname(),
          pid: 999_999,
          createdAtMs: 0,
          ...(options.ownership ? { ownership: options.ownership } : {}),
        }),
      );
      const at = new Date(Date.now() - (options.ageMs ?? 2 * HOUR_MS));
      await utimes(marker, at, at);
    }
    return directory;
  }

  test("a scratch directory carries an owner marker while live and is gone afterwards, however the work ends", async () => {
    await withRoot(async (parent) => {
      const module = createWorkerProcessModule({ scratchRoot: parent });
      let seen = "";
      await module.withScratchDirectory("narriflow-live-", async (directory) => {
        seen = directory;
        const record = JSON.parse(await readFile(join(directory, OWNER_FILE), "utf8"));
        expect(record).toMatchObject({ version: 1, host: hostname(), pid: process.pid, ownership: { attemptId: "attempt-1" } });
        expect(activeScratchDirectories()).toContain(directory);
        await writeFile(join(directory, "out.mp4"), "x");
      }, undefined, { workflowRunId: "run-1", attemptId: "attempt-1" });
      expect(await readdir(parent)).toEqual([]);
      expect(activeScratchDirectories()).not.toContain(seen);

      await expect(
        module.withScratchDirectory("narriflow-fail-", async () => {
          throw new Error("timeout");
        }),
      ).rejects.toThrow("timeout");
      const controller = new AbortController();
      await expect(
        module.withScratchDirectory("narriflow-abort-", async () => {
          controller.abort(new DOMException("shutdown", "AbortError"));
          controller.signal.throwIfAborted();
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(await readdir(parent)).toEqual([]);
    });
  });

  test("sweeps a crashed worker's old directory and nothing else", async () => {
    await withRoot(async (parent) => {
      const crashed = await abandoned(parent, "narriflow-render-crashed");
      const fresh = await abandoned(parent, "narriflow-render-fresh", { ageMs: 30_000 });
      const otherHost = await abandoned(parent, "narriflow-render-remote", { host: "someone-else" });
      const unmarked = await abandoned(parent, "narriflow-render-unmarked", { marker: false });
      const foreign = await abandoned(parent, "unrelated-dir");
      const module = createWorkerProcessModule({ scratchRoot: parent });
      await module.withScratchDirectory("narriflow-render-active-", async (active) => {
        const old = new Date(Date.now() - 5 * HOUR_MS);
        await utimes(join(active, OWNER_FILE), old, old);
        const result = await sweepAbandonedScratch({ root: parent });
        expect(result.removed).toEqual([crashed]);
        expect(new Set(result.skipped.map((entry) => `${entry.directory.split("/").pop()}:${entry.reason}`))).toEqual(
          new Set([
            "narriflow-render-fresh:fresh",
            "narriflow-render-remote:other_host",
            "narriflow-render-unmarked:unmarked",
            `${active.split("/").pop()}:active_local`,
          ]),
        );
        expect(await readdir(fresh)).toContain("partial.mp4");
        expect(await readdir(otherHost)).toContain("partial.mp4");
        expect(await readdir(unmarked)).toContain("partial.mp4");
        expect(await readdir(foreign)).toContain("partial.mp4");
        expect(await readdir(active)).toContain(OWNER_FILE);
      });
      await expect(stat(crashed)).rejects.toThrow();
    });
  });

  test("keeps an old directory whose database claim is still unexpired and sweeps it once the claim ends", async () => {
    await withRoot(async (parent) => {
      const directory = await abandoned(parent, "narriflow-render-claimed", { ownership: { attemptId: "attempt-9" } });
      const seen: unknown[] = [];
      let claimed = true;
      const options = {
        root: parent,
        isOwnerActive: async (ownership: unknown) => {
          seen.push(ownership);
          return claimed;
        },
      };
      expect((await sweepAbandonedScratch(options)).skipped).toEqual([{ directory, reason: "claim_active" }]);
      claimed = false;
      expect((await sweepAbandonedScratch(options)).removed).toEqual([directory]);
      expect(seen).toEqual([{ attemptId: "attempt-9" }, { attemptId: "attempt-9" }]);
    });
  });

  test("the stale threshold is the maximum lease plus the grace", async () => {
    await withRoot(async (parent) => {
      const directory = await abandoned(parent, "narriflow-render-edge", { ageMs: WORKFLOW_LEASE_DURATION_MS + 60_000 });
      expect((await sweepAbandonedScratch({ root: parent, graceMs: 120_000 })).skipped).toEqual([{ directory, reason: "fresh" }]);
      expect((await sweepAbandonedScratch({ root: parent, graceMs: 30_000 })).removed).toEqual([directory]);
    });
  });

  test("a failing removal is reported without aborting the sweep, and a missing root is empty", async () => {
    await withRoot(async (parent) => {
      const first = await abandoned(parent, "narriflow-render-a");
      const second = await abandoned(parent, "narriflow-render-b");
      const result = await sweepAbandonedScratch({
        root: parent,
        remove: async (directory) => {
          if (directory === first) throw new Error("EBUSY");
          await rm(directory, { recursive: true, force: true });
        },
      });
      expect(result.failed).toEqual([first]);
      expect(result.removed).toEqual([second]);
      expect(await sweepAbandonedScratch({ root: join(parent, "absent") })).toEqual({ scanned: 0, removed: [], skipped: [], failed: [] });
    });
  });
});
