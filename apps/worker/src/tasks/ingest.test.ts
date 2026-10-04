import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    inspectMedia: async () => {
      throw new Error("unexpected media inspection");
    },
    withScratchDirectory: async (_prefix, work) => work("/tmp/unused"),
  };
}

describe("readVerifiedUploadPayload", () => {
  test("uses the Upload Session's verified object facts", () => {
    expect(
      readVerifiedUploadPayload({
        storageKey: "workspaces/ws/upload-sessions/session/source.mp4",
        verifiedSizeBytes: 42,
        verifiedContentType: "video/mp4",
      }),
    ).toEqual({
      storageKey: "workspaces/ws/upload-sessions/session/source.mp4",
      sizeBytes: 42,
      contentType: "video/mp4",
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
          complete: async () => { settlements++; },
          fail: async () => { settlements++; return { outcome: "requeue" }; },
        },
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
