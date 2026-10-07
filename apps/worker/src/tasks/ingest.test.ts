import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessingUsageError } from "@narriflow/services";
import { WorkerProcessFailure, type WorkerProcessModule } from "../worker-process";
import {
  classifyYtdlpProviderFailure,
  executeYtdlpCommand,
  normalizeDropboxDownloadUrl,
  readVerifiedUploadPayload,
  processIngestJob,
} from "./ingest";

function processModuleWithExecute(
  execute: WorkerProcessModule["execute"],
): WorkerProcessModule {
  return {
    execute,
    inspectMedia: async () => ({ durationSec: 30 }) as Awaited<ReturnType<WorkerProcessModule["inspectMedia"]>>,
    withScratchDirectory: async (_prefix, work) => work("/tmp/unused"),
  };
}

const unlimitedUsage = {
  resize: async (input: { projectId: string; seconds: number }) => ({
    projectId: input.projectId,
    workspaceId: "workspace",
    intakeKind: "link" as const,
    state: "reserved" as const,
    periodStart: new Date(),
    reservedSeconds: input.seconds,
    settledSeconds: null,
  }),
};

describe("readVerifiedUploadPayload", () => {
  test("uses the Upload Session's verified object facts", () => {
    expect(
      readVerifiedUploadPayload({
        storageKey: "workspaces/ws/upload-sessions/session/source.mp4",
        verifiedSizeBytes: 42,
        verifiedContentType: "video/mp4",
        verifiedEtag: '"etag"',
        uploadSessionId: "session",
      }),
    ).toEqual({
      storageKey: "workspaces/ws/upload-sessions/session/source.mp4",
      sizeBytes: 42,
      contentType: "video/mp4",
      etag: '"etag"',
      uploadSessionId: "session",
    });
  });

  test("rejects Upload Finalize Ingest Jobs without trusted metadata", () => {
    expect(() =>
      readVerifiedUploadPayload({ storageKey: "source.mp4" }),
    ).toThrow("verifiedSizeBytes");
  });
});

describe("classifyYtdlpProviderFailure", () => {
  test.each(["you're", "you’re", "you are"])("treats a YouTube bot check with %s as permanent", (wording) => {
    expect(classifyYtdlpProviderFailure(
      `ERROR: [youtube] 9aSKMf5nCk0: Sign in to confirm ${wording} not a bot. Use --cookies for authentication.`,
    )).toEqual({
      code: "source_provider_access_denied",
      message: "YouTube blocked this import. Upload the video file instead.",
    });
  });

  test("turns an HTTP 403 media response into a permanent provider-access failure", () => {
    expect(
      classifyYtdlpProviderFailure(
        "ERROR: unable to download video data: HTTP Error 403: Forbidden",
      ),
    ).toEqual({
      code: "source_provider_access_denied",
      message:
        "The video provider refused the download. Upload the video file instead.",
    });
  });

  test("leaves an unrelated command failure unclassified", () => {
    expect(classifyYtdlpProviderFailure("ERROR: requested format is not available"))
      .toBeNull();
  });
});

describe("executeYtdlpCommand process contract", () => {
  test("uses the full process diagnostic to classify a bot check before retry settlement", async () => {
    const workerProcess = processModuleWithExecute(async () => {
      throw new WorkerProcessFailure(
        "worker_command_failed", "retryable", "generic truncated message",
        "ERROR: [youtube] id: Sign in to confirm you’re not a bot. Use --cookies for authentication.", 1,
      );
    });
    await expect(executeYtdlpCommand(workerProcess, new AbortController().signal, [], {
      timeoutMs: 1000,
    })).rejects.toMatchObject({
      code: "source_provider_access_denied",
      message: "YouTube blocked this import. Upload the video file instead.",
    });
  });
  test("forwards yt-dlp's declared 101 success code", async () => {
    const controller = new AbortController();
    const workerProcess = processModuleWithExecute(async (request) => {
      expect(request).toMatchObject({
        command: process.env.YTDLP_EXECUTABLE || "yt-dlp",
        signal: controller.signal,
        acceptableExitCodes: [0, 101],
        captureStdout: true,
      });
      return { exitCode: 101, stdout: Buffer.from("/tmp/video.mp4\n") };
    });

    await expect(
      executeYtdlpCommand(workerProcess, controller.signal, ["--max-downloads", "1"], {
        timeoutMs: 45_000,
        acceptableExitCodes: [0, 101],
      }),
    ).resolves.toEqual({ stdout: "/tmp/video.mp4\n" });
  });

  test("classifies a bounded process diagnostic as provider access denial", async () => {
    const workerProcess = processModuleWithExecute(async () => {
      throw new WorkerProcessFailure(
        "worker_command_failed",
        "retryable",
        "yt-dlp failed",
        "ERROR: unable to download video data: HTTP Error 403: Forbidden",
        1,
      );
    });

    await expect(
      executeYtdlpCommand(
        workerProcess,
        new AbortController().signal,
        ["https://video.example/watch?v=1"],
        { timeoutMs: 45_000 },
      ),
    ).rejects.toMatchObject({ code: "source_provider_access_denied" });
  });
});

describe("normalizeDropboxDownloadUrl", () => {
  test("forces dl=1 on a legacy /s/ share link with dl=0", () => {
    expect(
      normalizeDropboxDownloadUrl(
        "https://www.dropbox.com/s/abc123/video.mp4?dl=0",
      ),
    ).toBe("https://www.dropbox.com/s/abc123/video.mp4?dl=1");
  });

  test("forces dl=1 on a /scl/fi/ share link with no dl param", () => {
    expect(
      normalizeDropboxDownloadUrl(
        "https://www.dropbox.com/scl/fi/abc123/video.mp4?rlkey=xyz",
      ),
    ).toBe("https://www.dropbox.com/scl/fi/abc123/video.mp4?rlkey=xyz&dl=1");
  });

  test("overrides an existing dl=1 idempotently", () => {
    expect(
      normalizeDropboxDownloadUrl(
        "https://www.dropbox.com/s/abc123/video.mp4?dl=1",
      ),
    ).toBe("https://www.dropbox.com/s/abc123/video.mp4?dl=1");
  });

  test("throws on an invalid URL", () => {
    expect(() => normalizeDropboxDownloadUrl("not-a-url")).toThrow();
  });
});


describe("YouTube proxy session rotation", () => {
  async function importYoutube(proxy: string, blocked: (call: number) => boolean) {
    const scratch = await mkdtemp(join(tmpdir(), "ingest-rotation-"));
    const file = join(scratch, "source.mp4");
    await writeFile(file, "test source");
    const previous = process.env.YTDLP_PROXY_URL;
    process.env.YTDLP_PROXY_URL = proxy;
    const proxies: string[] = [];
    const settled: string[] = [];
    const workerProcess = processModuleWithExecute(async (request) => {
      proxies.push(request.args[request.args.indexOf("--proxy") + 1] ?? "");
      if (blocked(proxies.length)) {
        throw new WorkerProcessFailure(
          "worker_command_failed", "retryable", "yt-dlp failed",
          "ERROR: [youtube] test: Sign in to confirm you’re not a bot.", 1,
        );
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(request.args.includes("--skip-download") ? JSON.stringify({ id: "test", title: "Test", duration: 30 }) : `${file}\n`),
      };
    });
    workerProcess.withScratchDirectory = async (_prefix, work) => work(scratch);
    try {
      await processIngestJob({ id: "job", projectId: "project", jobType: "link_import", claimId: "claim", attemptCount: 1, payload: { url: "https://www.youtube.com/watch?v=test", provider: "youtube" } }, {
        workerProcess,
        lifecycle: {
          progress: async () => {},
          pinSource: async () => {},
          complete: async () => { settled.push("complete"); },
          fail: async (_job, code) => { settled.push(code); return { outcome: "permanent", terminalErrorCode: code }; },
        },
        usage: unlimitedUsage,
        putSource: async () => {},
      });
      return { proxies, settled };
    } finally {
      if (previous === undefined) delete process.env.YTDLP_PROXY_URL;
      else process.env.YTDLP_PROXY_URL = previous;
      await rm(scratch, { recursive: true, force: true });
    }
  }

  const rotating = "http://user-session-{session}:pass@proxy.example:7000";

  test("a block on a rotating proxy retries the blocked command on a fresh session", async () => {
    // Probe succeeds, the first download is blocked, the second succeeds.
    const { proxies, settled } = await importYoutube(rotating, (call) => call === 2);
    expect(settled).toEqual(["complete"]);
    expect(proxies).toHaveLength(3);
    expect(proxies[1]).toBe(proxies[0]);
    expect(proxies[2]).not.toBe(proxies[1]);
  });

  test("an import stops after three proxy sessions", async () => {
    const { proxies, settled } = await importYoutube(rotating, () => true);
    expect(settled).toEqual(["source_provider_access_denied"]);
    expect(new Set(proxies).size).toBe(3);
  });

  test("direct and fixed-proxy imports fail on the first block", async () => {
    for (const proxy of ["", "http://user:pass@proxy.example:8080"]) {
      const { proxies, settled } = await importYoutube(proxy, () => true);
      expect(settled).toEqual(["source_provider_access_denied"]);
      expect(proxies).toHaveLength(1);
    }
  });
});

describe("ingest media execution cancellation", () => {
  test("the link import path forwards cancellation through its R2 upload and never settles failure", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "ingest-cancellation-"));
    const file = join(scratch, "source.mp4");
    await writeFile(file, "test source");
    const shutdown = new AbortController();
    const reason = new Error("worker shutdown");
    let uploads = 0;
    let settlements = 0;
    const workerProcess = processModuleWithExecute(async (request) => ({
      exitCode: 0,
      stdout: Buffer.from(request.args.includes("--skip-download") ? JSON.stringify({ id: "test", title: "Test", duration: 30 }) : `${file}\n`),
    }));
    workerProcess.withScratchDirectory = async (_prefix, work) => work(scratch);
    try {
      await expect(processIngestJob({ id: "job", projectId: "project", jobType: "link_import", claimId: "claim", attemptCount: 1, payload: { url: "https://www.youtube.com/watch?v=test", provider: "youtube" } }, {
        signal: shutdown.signal,
        workerProcess,
        lifecycle: {
          progress: async () => {},
          pinSource: async () => {},
          complete: async () => { settlements++; },
          fail: async () => { settlements++; return { outcome: "requeue" }; },
        },
        usage: unlimitedUsage,
        putSource: async (input) => {
          uploads++;
          expect(input.signal).toBe(shutdown.signal);
          shutdown.abort(reason);
          input.signal!.throwIfAborted();
          throw new Error("upload should be aborted");
        },
      })).rejects.toBe(reason);
      expect(uploads).toBe(1);
      expect(settlements).toBe(0);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe("upload source pinning and usage facts", () => {
  const uploadJob = {
    id: "job",
    projectId: "project",
    jobType: "upload_finalize" as const,
    claimId: "claim",
    attemptCount: 1,
    payload: {
      storageKey: "workspaces/ws/upload-sessions/session/source.mp4",
      verifiedSizeBytes: 42,
      verifiedContentType: "video/mp4",
      verifiedEtag: '"verified"',
      uploadSessionId: "session",
    },
  };

  test("a replaced upload fails its ETag-conditioned pin permanently, before probing", async () => {
    const settled: string[] = [];
    let probes = 0;
    const workerProcess = processModuleWithExecute(async () => {
      throw new Error("no subprocess expected");
    });
    workerProcess.inspectMedia = async () => {
      probes++;
      return { durationSec: 9_000 } as Awaited<ReturnType<WorkerProcessModule["inspectMedia"]>>;
    };
    await processIngestJob(uploadJob, {
      workerProcess,
      lifecycle: {
        progress: async () => {},
        pinSource: async () => { settled.push("pinned"); },
        complete: async () => { settled.push("complete"); },
        fail: async (_job, code) => { settled.push(code); return { outcome: "permanent", terminalErrorCode: code }; },
      },
      usage: unlimitedUsage,
      putSource: async () => {},
      sourceStorage: {
        exists: async () => false,
        copyIfMatch: async (input) => {
          expect(input.etag).toBe('"verified"');
          expect(input.destinationKey).toBe("projects/project/upload/session.mp4");
          return "changed";
        },
      },
    });
    expect(settled).toEqual(["upload_source_changed"]);
    expect(probes).toBe(0);
  });

  test("a verified upload is pinned once, probed from the pinned key, and resized", async () => {
    const settled: string[] = [];
    const resized: number[] = [];
    let copies = 0;
    await processIngestJob(uploadJob, {
      workerProcess: processModuleWithExecute(async () => {
        throw new Error("no subprocess expected");
      }),
      lifecycle: {
        progress: async () => {},
        pinSource: async (_job, input) => {
          settled.push(`pinned:${input.sourceStorageKey}:${input.releasedStorageKey}`);
        },
        complete: async (_job, source) => { settled.push(`complete:${source.sourceStorageKey}`); },
        fail: async (_job, code) => { settled.push(code); return { outcome: "permanent", terminalErrorCode: code }; },
      },
      usage: {
        resize: async (input) => {
          resized.push(input.seconds);
          return unlimitedUsage.resize(input);
        },
      },
      putSource: async () => {},
      sourceStorage: {
        // A retry after a committed copy finds the pinned key and reuses it.
        exists: async () => copies > 0,
        copyIfMatch: async () => { copies++; return "copied"; },
      },
    });
    expect(copies).toBe(1);
    expect(resized).toEqual([30]);
    expect(settled).toEqual([
      "pinned:projects/project/upload/session.mp4:workspaces/ws/upload-sessions/session/source.mp4",
      "complete:projects/project/upload/session.mp4",
    ]);
  });

  test("a link whose metadata exceeds the allowance is refused before download with its typed code", async () => {
    const settled: string[] = [];
    const commands: string[][] = [];
    const workerProcess = processModuleWithExecute(async (request) => {
      commands.push(request.args);
      return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ id: "test", title: "Test", duration: 7_200 })) };
    });
    await processIngestJob({ id: "job", projectId: "project", jobType: "link_import", claimId: "claim", attemptCount: 1, payload: { url: "https://www.youtube.com/watch?v=test", provider: "youtube" } }, {
      workerProcess,
      lifecycle: {
        progress: async () => {},
        pinSource: async () => {},
        complete: async () => { settled.push("complete"); },
        fail: async (_job, code) => { settled.push(code); return { outcome: "permanent", terminalErrorCode: code }; },
      },
      usage: {
        resize: async () => {
          throw new ProcessingUsageError({
            code: "processing_quota_exhausted",
            message: "No minutes left",
            details: { tier: "free", limitMinutes: 60, remainingMinutes: 5, requestedMinutes: 120 },
          });
        },
      },
      putSource: async () => {},
    });
    expect(settled).toEqual(["processing_quota_exhausted"]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("--skip-download");
  });
});
