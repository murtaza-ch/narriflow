import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowAttemptLost } from "@narriflow/services";
import {
  createWorkerProcessModule,
  WorkerProcessFailure,
  type WorkerProcessDiagnostic,
  type WorkerProcessRequest,
} from "./worker-process";

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
              },
              { codec_type: "audio" },
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
