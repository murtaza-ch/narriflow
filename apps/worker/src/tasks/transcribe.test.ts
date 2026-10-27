import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { projectService, type ClaimedWorkflowAttempt, type CompleteTranscriptInput } from "@narriflow/services";
import { parseSuppliedCaptions } from "@narriflow/validators";
import { assemblyAiFailure, getAssemblyAiTranscript, processTranscriptRun } from "./transcribe";

const mocks: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const mock of mocks.splice(0)) mock.mockRestore(); });

describe("AssemblyAI result polling failure disposition", () => {
  test("classifies an authentication response as permanent at the poll seam", async () => {
    await expect(
      getAssemblyAiTranscript("transcript-1", "bad-key", {
        maxRetries: 0,
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
          }),
      }),
    ).rejects.toMatchObject({
      code: "assemblyai_transcription_poll_failed",
      disposition: "permanent",
    });
  });

  test("keeps a provider outage retryable at the poll seam", async () => {
    await expect(
      getAssemblyAiTranscript("transcript-1", "key", {
        maxRetries: 0,
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: "unavailable" }), {
            status: 503,
          }),
      }),
    ).rejects.toMatchObject({
      code: "assemblyai_transcription_poll_failed",
      disposition: "retryable",
    });
  });
});

describe("transcription without speech-to-text", () => {
  const attempt = {
    workflowRunId: "stt-run", projectId: "project", stage: "stt", attemptId: "attempt", attemptCount: 1, status: "running", progress: 10,
    contentPackId: "pack", leaseExpiresAt: new Date(Date.now() + 60_000),
    project: { id: "project", title: "AI short", sourceMediaUrl: "r2://bucket/source.mp4", sourceType: "upload", sourceInput: null, sourceStorageKey: "source.mp4",
      sourceMimeType: "video/mp4", sourceDurationSeconds: 8, createdByUserId: "actor", workspaceId: "workspace" },
  } as unknown as ClaimedWorkflowAttempt;
  const context = { signal: new AbortController().signal, reportProgress: async () => {} };

  function harness(plan: Awaited<ReturnType<typeof projectService.getTranscriptPlanForWorker>>["plan"]) {
    const complete = mock(async (_attempt: unknown, _input: CompleteTranscriptInput) => {});
    const fetched = spyOn(globalThis, "fetch");
    mocks.push(fetched);
    const skip = {
      transcriptPlan: async () => ({ plan, durationSeconds: 8, languageCode: "en" }),
      completeTranscript: complete,
    };
    return { complete, fetched, skip };
  }

  test("supplied captions complete the transcript at once, cut to the source, without calling the provider", async () => {
    const utterances = parseSuppliedCaptions("1\n00:00:00,000 --> 00:00:02,000\nHello there\n\n2\n00:00:07,000 --> 00:00:12,000\nrunning past the end\n\n3\n00:00:20,000 --> 00:00:21,000\ngone");
    const h = harness({ kind: "supplied", utterances });
    delete process.env.ASSEMBLYAI_API_KEY;
    await processTranscriptRun(attempt, context, undefined, h.skip);
    expect(h.fetched).not.toHaveBeenCalled();
    expect(h.complete).toHaveBeenCalledTimes(1);
    const [received, input] = h.complete.mock.calls[0]!;
    expect(received).toBe(attempt);
    expect(input).toMatchObject({ provider: "supplied_captions", providerJobId: null, rawStorageKey: null, languageCode: "en", durationSeconds: 8, speakerCount: 1, text: "Hello there running" });
    expect((input.utterances as Array<{ index: number; startSec: number; endSec: number }>).map((u) => [u.index, u.startSec, u.endSec])).toEqual([[0, 0, 2], [1, 7, 8]]);
  });

  test.each(["captions_none", "no_audio_stream"] as const)("%s completes with an empty transcript and no provider call", async (reason) => {
    const h = harness({ kind: "empty", reason });
    delete process.env.ASSEMBLYAI_API_KEY;
    await processTranscriptRun(attempt, context, undefined, h.skip);
    expect(h.fetched).not.toHaveBeenCalled();
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.complete.mock.calls[0]![1]).toMatchObject({ provider: "none", utterances: [], text: "", speakerCount: 0, durationSeconds: 8, rawStorageKey: null });
  });
});

describe("assemblyAiFailure", () => {
  test("an out-of-credits account fails at once with its own code", () => {
    const negative = { error: "Your current account balance is negative. Please top up to continue using the API." };
    for (const [code, status] of [
      ["assemblyai_transcription_submit_failed", 400],
      ["assemblyai_upload_failed", 429],
      ["assemblyai_transcription_failed", null],
    ] as const) {
      const failure = assemblyAiFailure(code, status, negative, "fallback");
      expect(failure.code).toBe("assemblyai_quota_exhausted");
      expect(failure.disposition).toBe("permanent");
    }
  });

  test("other provider errors keep their code and HTTP-based disposition", () => {
    expect(assemblyAiFailure("assemblyai_transcription_submit_failed", 503, { error: "Service unavailable" }, "x")).toMatchObject({
      code: "assemblyai_transcription_submit_failed",
      disposition: "retryable",
    });
    expect(assemblyAiFailure("assemblyai_transcription_submit_failed", 400, { error: "Invalid audio_url" }, "x")).toMatchObject({
      code: "assemblyai_transcription_submit_failed",
      disposition: "permanent",
    });
    expect(assemblyAiFailure("assemblyai_transcription_failed", null, { error: "File does not appear to contain audio." }, "x")).toMatchObject({
      code: "assemblyai_transcription_failed",
      disposition: "retryable",
    });
  });
});
