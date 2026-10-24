import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowAttemptLost } from "@narriflow/services";
import {
  createWorkerProcessModule,
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
  })).rejects.toMatchObject({ code: "worker_process_startup_timeout" });
});

test("persistent helper reaps a descendant after its parent exits", async () => {
  const helper = await createWorkerProcessModule({ killGraceMs: 20 }).start?.({
    command: "sh",
    args: ["-c", "sleep 60 >/dev/null 2>&1 & echo $!; exit 0"],
    cwd: process.cwd(), env: { PATH: process.env.PATH }, signal: new AbortController().signal,
  });
  expect((await helper!.exited).exitCode).toBe(0);
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

test("worker process classifies a missing executable as permanent", async () => {
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
    code: "worker_command_missing",
    disposition: "permanent",
  });
  expect(diagnostics).toContainEqual(
    expect.objectContaining({
      operation: "spawn",
      failureCode: "worker_command_missing",
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
  "worker process classifies a generic spawn error as retryable with its cause",
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
        code: "worker_command_spawn_failed",
        disposition: "retryable",
        cause: expect.any(Error),
      });
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          operation: "spawn",
          status: "failed",
          failureCode: "worker_command_spawn_failed",
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
  const baselineBytes = process.memoryUsage().rss;
  const samples: number[] = [];

  await createWorkerProcessModule({ killGraceMs: 20 }).execute({
    command: process.execPath,
    args: [
      "-e",
      "const held = Buffer.alloc(64 * 1024 * 1024, 1); setTimeout(() => process.exit(held[0] === 1 ? 0 : 1), 350)",
    ],
    signal: new AbortController().signal,
    deadlineMs: 2_000,
    recordResourceSample: (rssBytes) => samples.push(rssBytes),
  });

  expect(samples.length).toBeGreaterThan(0);
  expect(Math.max(...samples)).toBeGreaterThan(baselineBytes + 32 * 1024 * 1024);
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

  expect(inspection).toEqual({
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
  ).toEqual({
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
