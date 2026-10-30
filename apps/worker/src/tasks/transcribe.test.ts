import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectService,
  WorkflowFailure,
  type ClaimedWorkflowAttempt,
  type CompleteTranscriptInput,
  type WaitingWorkflowAttempt,
} from "@narriflow/services";
import { parseSuppliedCaptions } from "@narriflow/validators";
import type { LanguageProbeResult } from "../language-probe";
import {
  buildScribeSubmitForm,
  chooseSubmitInputKind,
  fetchScribeTranscript,
  processSubmittedTranscriptResults,
  processTranscriptRun,
  ScribeSubmissionUnconfirmed,
  submitScribeTranscription,
  type TranscriptResultAdapters,
  type TranscriptSubmitAdapters,
} from "./transcribe";

const mocks: Array<{ mockRestore(): void }> = [];
const originalEnv = { ...process.env };
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore();
  process.env = { ...originalEnv };
});

const detail = (code: string, status = "error") => ({ detail: { type: "x", code, message: "provider prose", status } });
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });

describe("Scribe submit form", () => {
  const base = { webhookId: "wh_1", workflowRunId: "run-1", attemptId: "attempt-1" };

  test("sends the full webhook-delivered field set with the source by URL", async () => {
    const form = await buildScribeSubmitForm({ ...base, languageCode: "urd", input: { kind: "url", sourceUrl: "https://r2.example/source.mp4?sig=1" } });
    expect(Object.fromEntries([...form.entries()])).toEqual({
      model_id: "scribe_v2",
      diarize: "true",
      timestamps_granularity: "word",
      tag_audio_events: "false",
      webhook: "true",
      webhook_id: "wh_1",
      webhook_metadata: JSON.stringify({ workflowRunId: "run-1", attemptId: "attempt-1" }),
      language_code: "urd",
      source_url: "https://r2.example/source.mp4?sig=1",
    });
  });

  test("omits language_code for Auto and uploads extracted audio as a file part", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scribe-form-"));
    try {
      const path = join(dir, "audio.mp3");
      writeFileSync(path, "not really mp3");
      const form = await buildScribeSubmitForm({ ...base, languageCode: null, input: { kind: "file", path } });
      expect(form.has("language_code")).toBe(false);
      expect(form.has("source_url")).toBe(false);
      const file = form.get("file") as File;
      expect(file.size).toBe("not really mp3".length);
      expect(file.type).toBe("audio/mpeg");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("chooseSubmitInputKind", () => {
  const url = "https://r2.example/source";
  test("first attempt within 2 GiB goes by URL", () => {
    expect(chooseSubmitInputKind({ attemptCount: 1, sourceSizeBytes: 1_000_000n, presignedUrl: url })).toBe("url");
    expect(chooseSubmitInputKind({ attemptCount: 1, sourceSizeBytes: 2n * 1024n ** 3n, presignedUrl: url })).toBe("url");
  });
  test("retries, larger or unsized sources and a failed presign send audio", () => {
    expect(chooseSubmitInputKind({ attemptCount: 2, sourceSizeBytes: 1_000_000n, presignedUrl: url })).toBe("file");
    expect(chooseSubmitInputKind({ attemptCount: 1, sourceSizeBytes: 2n * 1024n ** 3n + 1n, presignedUrl: url })).toBe("file");
    expect(chooseSubmitInputKind({ attemptCount: 1, sourceSizeBytes: null, presignedUrl: url })).toBe("file");
    expect(chooseSubmitInputKind({ attemptCount: 1, sourceSizeBytes: 10n, presignedUrl: null })).toBe("file");
  });
});

describe("submitScribeTranscription", () => {
  const request = {
    apiKey: "key",
    webhookId: "wh",
    workflowRunId: "run",
    attemptId: "attempt",
    languageCode: null,
    input: { kind: "url", sourceUrl: "https://r2.example/s" } as const,
  };

  test("POSTs once with the key and parses request_id and transcription_id from the 202", async () => {
    const fetchImpl = mock(async (_url: unknown, _init?: RequestInit) =>
      json({ message: "ok", request_id: "req_1", transcription_id: "tr_1" }, 202));
    const accepted = await submitScribeTranscription({ ...request, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(accepted).toEqual({ requestId: "req_1", transcriptionId: "tr_1" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["xi-api-key"]).toBe("key");
    expect(init?.body).toBeInstanceOf(FormData);
  });

  test("an unparseable acceptance is retryable and unconfirmed: the request may have started work", async () => {
    const rejection = submitScribeTranscription({ ...request, fetchImpl: (async () => json({ message: "ok" }, 202)) as unknown as typeof fetch });
    await expect(rejection).rejects.toMatchObject({ code: "elevenlabs_transcription_submit_failed", disposition: "retryable" });
    await expect(rejection).rejects.toBeInstanceOf(ScribeSubmissionUnconfirmed);
  });

  test.each([
    [500, null, "retryable"],
    [429, detail("too_many_concurrent_requests"), "retryable"],
    [401, detail("invalid_api_key"), "permanent"],
    [400, detail("no_webhooks_configured"), "permanent"],
  ] as const)("a %i response fails once, without a retry", async (status, body, disposition) => {
    const fetchImpl = mock(async () => json(body, status));
    await expect(submitScribeTranscription({ ...request, fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toMatchObject({ disposition });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("a network error or timeout is retryable, unconfirmed and not retried", async () => {
    const fetchImpl = mock(async () => { throw new TypeError("fetch failed"); });
    const rejection = submitScribeTranscription({ ...request, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(rejection).rejects.toMatchObject({ code: "elevenlabs_transcription_submit_failed", disposition: "retryable" });
    await expect(rejection).rejects.toBeInstanceOf(ScribeSubmissionUnconfirmed);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const timeout = submitScribeTranscription({
      ...request,
      fetchImpl: (async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }) as unknown as typeof fetch,
    });
    await expect(timeout).rejects.toBeInstanceOf(ScribeSubmissionUnconfirmed);
  });

  test("a definite HTTP rejection is not unconfirmed", async () => {
    const rejection = submitScribeTranscription({ ...request, fetchImpl: (async () => json(null, 503)) as unknown as typeof fetch });
    await expect(rejection).rejects.toMatchObject({ disposition: "retryable" });
    await expect(rejection).rejects.not.toBeInstanceOf(ScribeSubmissionUnconfirmed);
  });
});

describe("fetchScribeTranscript", () => {
  const fetchWith = (response: () => Response | Promise<Response>) => (async () => response()) as unknown as typeof fetch;

  test("200 is ready, with the id URL-encoded into the path", async () => {
    const fetchImpl = mock(async (_url: unknown) => json({ text: "hi", words: [] }, 200));
    expect(await fetchScribeTranscript("tr/1", "key", fetchImpl as unknown as typeof fetch)).toEqual({ kind: "ready", payload: { text: "hi", words: [] } });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.elevenlabs.io/v1/speech-to-text/transcripts/tr%2F1");
  });

  test("404 transcript_not_found is pending", async () => {
    expect(await fetchScribeTranscript("tr", "key", fetchWith(() => json(detail("transcript_not_found"), 404)))).toEqual({ kind: "pending" });
  });

  test.each([401, 403])("%i is a permanent failure", async (status) => {
    const result = await fetchScribeTranscript("tr", "key", fetchWith(() => json(detail("invalid_api_key"), status)));
    expect(result).toMatchObject({ kind: "failed", failure: { code: "elevenlabs_auth_failed", disposition: "permanent" } });
  });

  test("any other 404 is a permanent failure, not pending", async () => {
    const result = await fetchScribeTranscript("tr", "key", fetchWith(() => json({ detail: "Not Found" }, 404)));
    expect(result).toMatchObject({ kind: "failed", failure: { disposition: "permanent" } });
  });

  test.each([429, 500, 503])("%i waits for the next tick", async (status) => {
    expect(await fetchScribeTranscript("tr", "key", fetchWith(() => json(null, status)))).toMatchObject({ kind: "transient" });
  });

  test("a network error waits for the next tick", async () => {
    expect(await fetchScribeTranscript("tr", "key", (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch))
      .toMatchObject({ kind: "transient" });
  });
});

const baseAttempt = (overrides: { attemptCount?: number; sourceSizeBytes?: bigint | null; sourceDurationSeconds?: number | null } = {}) => ({
  workflowRunId: "stt-run", projectId: "project", stage: "stt", attemptId: "attempt", attemptCount: overrides.attemptCount ?? 1, status: "running", progress: 10,
  contentPackId: "pack", leaseExpiresAt: new Date(Date.now() + 60_000),
  project: { id: "project", title: "AI short", sourceMediaUrl: "r2://bucket/source.mp4", sourceType: "upload", sourceInput: null, sourceStorageKey: "source.mp4",
    sourceMimeType: "video/mp4", sourceDurationSeconds: overrides.sourceDurationSeconds === undefined ? 600 : overrides.sourceDurationSeconds,
    sourceSizeBytes: overrides.sourceSizeBytes === undefined ? 500_000_000n : overrides.sourceSizeBytes, createdByUserId: "actor", workspaceId: "workspace" },
}) as unknown as ClaimedWorkflowAttempt;
const context = { signal: new AbortController().signal, reportProgress: async () => {} };

describe("transcription without speech-to-text", () => {
  const attempt = baseAttempt();

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
    delete process.env.ELEVENLABS_API_KEY;
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
    delete process.env.ELEVENLABS_API_KEY;
    await processTranscriptRun(attempt, context, undefined, h.skip);
    expect(h.fetched).not.toHaveBeenCalled();
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.complete.mock.calls[0]![1]).toMatchObject({ provider: "none", utterances: [], text: "", speakerCount: 0, durationSeconds: 8, rawStorageKey: null });
  });
});

describe("transcription submit", () => {
  beforeEach(() => {
    process.env.ELEVENLABS_API_KEY = "key";
    process.env.ELEVENLABS_WEBHOOK_ID = "wh_dev";
  });

  const speechToText = {
    transcriptPlan: async () => ({ plan: { kind: "speech_to_text" as const }, durationSeconds: 600, languageCode: null }),
    completeTranscript: async () => {},
  } as unknown as Parameters<typeof processTranscriptRun>[3];

  const PINNED_PROBE: LanguageProbeResult = { pinned: "ur", detected: "urd", probability: 0.97, wordCount: 40, reason: "pinned" };
  const UNPINNED_PROBE: LanguageProbeResult = { pinned: null, detected: "und", probability: 0.4, wordCount: 3, reason: "low_language_probability" };

  function harness(options: {
    language?: string | null;
    presigned?: string | null;
    probe?: LanguageProbeResult;
    submit?: () => Promise<{ requestId: string; transcriptionId: string }>;
    begin?: () => Promise<void>;
  } = {}) {
    const calls: string[] = [];
    const lifecycle = {
      beginProviderSubmission: mock(async (_attempt: unknown, _input: { deadline: Date }) => { calls.push("begin"); await options.begin?.(); }),
      recordProviderAcceptance: mock(async (_key: unknown, _input: { requestId: string; transcriptionId: string; nextPollAt: Date }) => { calls.push("accept"); return { kind: "applied" as const }; }),
      failProviderAttempt: mock(async (_key: unknown, _failure: WorkflowFailure) => { calls.push("failProvider"); return { kind: "applied" as const }; }),
      failAttempt: mock(async (_attempt: unknown, _failure: WorkflowFailure) => { calls.push("failAttempt"); }),
    };
    const probe = mock(async (_options: { sourceUrl: string; durationSeconds: number }) => { calls.push("probe"); return options.probe ?? UNPINNED_PROBE; });
    const submit = mock(async (_request: { languageCode: string | null; input: { kind: string }; webhookId: string; attemptId: string; workflowRunId: string }) => {
      calls.push("post");
      return (options.submit ?? (async () => ({ requestId: "req_1", transcriptionId: "tr_1" })))();
    });
    const extracted: string[] = [];
    const notifyFailure = mock(async () => {});
    const adapters = {
      lifecycle,
      languageCode: async () => options.language ?? null,
      presign: async () => (options.presigned === undefined ? "https://r2.example/source?sig=1" : options.presigned),
      probe,
      submit,
      withExtractedAudio: async (_request: unknown, use: (path: string) => Promise<unknown>) => { calls.push("extract"); extracted.push("/tmp/audio.mp3"); return use("/tmp/audio.mp3"); },
      notifyFailure,
      now: () => 1_000_000,
    } as unknown as TranscriptSubmitAdapters;
    return { adapters, calls, lifecycle, probe, submit, notifyFailure, extracted };
  }

  test("begins the submission before the POST and records acceptance after the 202", async () => {
    const h = harness({ language: "ur" });
    await processTranscriptRun(baseAttempt(), context, undefined, speechToText, h.adapters);
    expect(h.calls).toEqual(["begin", "post", "accept"]);
    expect(h.lifecycle.beginProviderSubmission.mock.calls[0]![1].deadline.getTime()).toBe(1_000_000 + 10 * 60_000);
    expect(h.lifecycle.recordProviderAcceptance.mock.calls[0]![0]).toEqual({ workflowRunId: "stt-run", attemptId: "attempt" });
    expect(h.lifecycle.recordProviderAcceptance.mock.calls[0]![1]).toEqual({ requestId: "req_1", transcriptionId: "tr_1", nextPollAt: new Date(1_000_000 + 30_000) });
    expect(h.submit.mock.calls[0]![0]).toMatchObject({ webhookId: "wh_dev", attemptId: "attempt", workflowRunId: "stt-run" });
  });

  test("a chosen language is sent as its provider code and skips the probe", async () => {
    const h = harness({ language: "ur" });
    await processTranscriptRun(baseAttempt(), context, undefined, speechToText, h.adapters);
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.submit.mock.calls[0]![0].languageCode).toBe("urd");
  });

  test("Auto probes the presigned source and pins a trusted detection", async () => {
    const h = harness({ probe: PINNED_PROBE });
    await processTranscriptRun(baseAttempt(), context, undefined, speechToText, h.adapters);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.probe.mock.calls[0]![0]).toMatchObject({ sourceUrl: "https://r2.example/source?sig=1", durationSeconds: 600 });
    expect(h.calls).toEqual(["probe", "begin", "post", "accept"]);
    expect(h.submit.mock.calls[0]![0].languageCode).toBe("urd");
  });

  test("Auto with an untrusted probe submits unpinned", async () => {
    const h = harness({ probe: UNPINNED_PROBE });
    await processTranscriptRun(baseAttempt(), context, undefined, speechToText, h.adapters);
    expect(h.submit.mock.calls[0]![0].languageCode).toBeNull();
  });

  test("Auto without a known duration or presigned URL skips the probe and submits unpinned", async () => {
    const noDuration = harness();
    await processTranscriptRun(baseAttempt({ sourceDurationSeconds: null }), context, undefined, {
      transcriptPlan: async () => ({ plan: { kind: "speech_to_text" as const }, durationSeconds: null, languageCode: null }),
      completeTranscript: async () => {},
    } as unknown as Parameters<typeof processTranscriptRun>[3], noDuration.adapters);
    expect(noDuration.probe).not.toHaveBeenCalled();
    expect(noDuration.submit.mock.calls[0]![0].languageCode).toBeNull();

    const noUrl = harness({ presigned: null });
    await processTranscriptRun(baseAttempt(), context, undefined, speechToText, noUrl.adapters);
    expect(noUrl.probe).not.toHaveBeenCalled();
  });

  test("first attempt sends the presigned source by URL", async () => {
    const h = harness({ language: "en" });
    await processTranscriptRun(baseAttempt(), context, undefined, speechToText, h.adapters);
    expect(h.submit.mock.calls[0]![0].input).toEqual({ kind: "url", sourceUrl: "https://r2.example/source?sig=1" });
    expect(h.calls).not.toContain("extract");
  });

  test("a retry, an oversized source or a failed presign uploads extracted audio, begun after the extraction", async () => {
    for (const h of [
      { attempt: baseAttempt({ attemptCount: 2 }), options: { language: "en" } },
      { attempt: baseAttempt({ sourceSizeBytes: 3n * 1024n ** 3n }), options: { language: "en" } },
      { attempt: baseAttempt(), options: { language: "en", presigned: null } },
    ]) {
      const run = harness(h.options);
      await processTranscriptRun(h.attempt, context, undefined, speechToText, run.adapters);
      expect(run.submit.mock.calls[0]![0].input).toEqual({ kind: "file", path: "/tmp/audio.mp3" });
      expect(run.calls).toEqual(["extract", "begin", "post", "accept"]);
    }
  });

  test.each([
    ["a 5xx", new WorkflowFailure("elevenlabs_transcription_submit_failed", "retryable", "x")],
    ["a 429", new WorkflowFailure("elevenlabs_transcription_submit_failed", "retryable", "x")],
    ["an auth error", new WorkflowFailure("elevenlabs_auth_failed", "permanent", "x")],
    ["no_webhooks_configured", new WorkflowFailure("elevenlabs_webhook_not_configured", "permanent", "x")],
  ])("%s after begin fails the waiting attempt through the provider path, once", async (_name, failure) => {
    const h = harness({ language: "en", submit: async () => { throw failure; } });
    await processTranscriptRun(baseAttempt(), context, undefined, speechToText, h.adapters);
    expect(h.calls).toEqual(["begin", "post", "failProvider"]);
    expect(h.lifecycle.failProviderAttempt.mock.calls[0]![1]).toBe(failure);
    expect(h.lifecycle.failAttempt).not.toHaveBeenCalled();
    expect(h.lifecycle.recordProviderAcceptance).not.toHaveBeenCalled();
    expect(h.notifyFailure).toHaveBeenCalledTimes(1);
  });

  test("an unconfirmed POST leaves the run waiting on its attempt, without failing or notifying", async () => {
    const h = harness({ language: "en", submit: async () => { throw new ScribeSubmissionUnconfirmed("elevenlabs_transcription_submit_failed", "timed out", "retryable"); } });
    await processTranscriptRun(baseAttempt(), context, undefined, speechToText, h.adapters);
    expect(h.calls).toEqual(["begin", "post"]);
    expect(h.lifecycle.failProviderAttempt).not.toHaveBeenCalled();
    expect(h.lifecycle.failAttempt).not.toHaveBeenCalled();
    expect(h.notifyFailure).not.toHaveBeenCalled();
  });

  test("a definite rejection fails the begun attempt at once", async () => {
    const h = harness({ language: "en", submit: async () => { throw new WorkflowFailure("elevenlabs_auth_failed", "permanent", "401"); } });
    await processTranscriptRun(baseAttempt(), context, undefined, speechToText, h.adapters);
    expect(h.calls).toEqual(["begin", "post", "failProvider"]);
    expect(h.notifyFailure).toHaveBeenCalledTimes(1);
  });

  test("an unconfirmed error before the submission begins is an ordinary failure", async () => {
    const h = harness({ language: "en", begin: async () => { throw new ScribeSubmissionUnconfirmed("x", "y", "retryable"); } });
    await processTranscriptRun(baseAttempt(), context, undefined, speechToText, h.adapters);
    expect(h.lifecycle.failAttempt).toHaveBeenCalledTimes(1);
  });

  test("a stale attempt's failure is not notified", async () => {
    const h = harness({ language: "en", submit: async () => { throw new WorkflowFailure("elevenlabs_transcription_submit_failed", "retryable", "x"); } });
    h.lifecycle.failProviderAttempt.mockImplementation(async () => ({ kind: "stale", reason: "attempt_superseded" }) as never);
    await processTranscriptRun(baseAttempt(), context, undefined, speechToText, h.adapters);
    expect(h.notifyFailure).not.toHaveBeenCalled();
  });

  test.each([
    ["ELEVENLABS_API_KEY", "elevenlabs_api_key_missing"],
    ["ELEVENLABS_WEBHOOK_ID", "elevenlabs_webhook_not_configured"],
  ])("a missing %s is a permanent failure before anything is submitted", async (name, code) => {
    delete process.env[name];
    const h = harness({ language: "en" });
    await processTranscriptRun(baseAttempt(), context, undefined, speechToText, h.adapters);
    expect(h.calls).toEqual(["failAttempt"]);
    expect(h.lifecycle.failAttempt.mock.calls[0]![1]).toMatchObject({ code, disposition: "permanent" });
  });
});

describe("transcription results", () => {
  beforeEach(() => {
    process.env.ELEVENLABS_API_KEY = "key";
    delete process.env.ELEVENLABS_RESULT_TIMEOUT_MS;
  });

  const NOW = 10_000_000_000;
  const waiting = (overrides: Partial<WaitingWorkflowAttempt> = {}): WaitingWorkflowAttempt => ({
    workflowRunId: "stt-run", projectId: "project", stage: "stt", attemptId: "attempt", attemptCount: 1, progress: 40,
    providerJobId: "tr_1", submissionDeadlineAt: null, submittedAt: new Date(NOW - 60_000), ...overrides,
  });

  function harness(attempts: WaitingWorkflowAttempt[], fetchResult: Awaited<ReturnType<TranscriptResultAdapters["fetchTranscript"]>>) {
    const lifecycle = {
      claimDueWaitingTranscripts: mock(async (_batch: number, _interval: number) => attempts),
      expireUnconfirmedProviderSubmission: mock(async (_key: unknown) => ({ kind: "applied" as const })),
      failProviderAttempt: mock(async (_key: unknown, _failure: WorkflowFailure, _ids?: unknown) => ({ kind: "applied" as const })),
      reportProgress: mock(async (_attempt: unknown, _progress: number) => {}),
    };
    const finalize = mock(async (_input: unknown) => ({ kind: "applied" as const }));
    const fetchTranscript = mock(async (_id: string, _key: string) => fetchResult);
    const notifyFailure = mock(async () => {});
    const adapters = { lifecycle, finalize, fetchTranscript, notifyFailure, now: () => NOW } as unknown as TranscriptResultAdapters;
    return { adapters, lifecycle, finalize, fetchTranscript, notifyFailure };
  }

  test("does nothing without an API key", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const h = harness([waiting()], { kind: "pending" });
    expect(await processSubmittedTranscriptResults(h.adapters)).toBe(0);
    expect(h.lifecycle.claimDueWaitingTranscripts).not.toHaveBeenCalled();
  });

  test("claims with the poll interval from the environment", async () => {
    process.env.ELEVENLABS_RESULT_POLL_INTERVAL_MS = "12345";
    const h = harness([], { kind: "pending" });
    await processSubmittedTranscriptResults(h.adapters);
    expect(h.lifecycle.claimDueWaitingTranscripts.mock.calls[0]![1]).toBe(12345);
  });

  test("a 200 finalizes with the payload and transcription id", async () => {
    const payload = { language_code: "urd", words: [] };
    const h = harness([waiting()], { kind: "ready", payload });
    expect(await processSubmittedTranscriptResults(h.adapters)).toBe(1);
    expect(h.fetchTranscript.mock.calls[0]).toEqual(["tr_1", "key"]);
    expect(h.finalize.mock.calls[0]![0]).toEqual({
      key: { workflowRunId: "stt-run", attemptId: "attempt" },
      payload,
      providerIds: { transcriptionId: "tr_1" },
    });
  });

  test("a ready transcript is finalized even after the result deadline", async () => {
    const h = harness([waiting({ submittedAt: new Date(NOW - 3 * 60 * 60_000) })], { kind: "ready", payload: {} });
    expect(await processSubmittedTranscriptResults(h.adapters)).toBe(1);
    expect(h.finalize).toHaveBeenCalledTimes(1);
    expect(h.lifecycle.failProviderAttempt).not.toHaveBeenCalled();
  });

  test("a finalization failure keeps the run waiting, and the rest of the batch still settles", async () => {
    const second = waiting({ workflowRunId: "stt-run-2", attemptId: "attempt-2", providerJobId: "tr_2" });
    const h = harness([waiting(), second], { kind: "ready", payload: {} });
    h.finalize.mockImplementationOnce(async () => { throw new Error("R2 write denied"); });
    expect(await processSubmittedTranscriptResults(h.adapters)).toBe(1);
    expect(h.finalize).toHaveBeenCalledTimes(2);
    expect(h.finalize.mock.calls[1]![0]).toMatchObject({ key: { workflowRunId: "stt-run-2" } });
    expect(h.lifecycle.failProviderAttempt).not.toHaveBeenCalled();
    expect(h.notifyFailure).not.toHaveBeenCalled();
  });

  test("a finalization that keeps failing settles through the fenced failure path at the result deadline", async () => {
    const h = harness([waiting({ submittedAt: new Date(NOW - 10 * 60 * 60_000) })], { kind: "ready", payload: {} });
    h.finalize.mockImplementation(async () => { throw new Error("R2 write denied"); });
    expect(await processSubmittedTranscriptResults(h.adapters)).toBe(1);
    const [key, failure, ids] = h.lifecycle.failProviderAttempt.mock.calls[0]!;
    expect(key).toEqual({ workflowRunId: "stt-run", attemptId: "attempt" });
    expect(failure).toMatchObject({ code: "elevenlabs_transcript_fetch_failed", disposition: "retryable" });
    expect(ids).toEqual({ transcriptionId: "tr_1" });
    expect(h.notifyFailure).toHaveBeenCalledTimes(1);
  });

  test("an unexpected error on one run does not stop the others", async () => {
    const h = harness([waiting(), waiting({ workflowRunId: "stt-run-2", attemptId: "attempt-2", providerJobId: "tr_2" })], { kind: "ready", payload: {} });
    h.fetchTranscript.mockImplementationOnce(async () => { throw new Error("socket hang up"); });
    expect(await processSubmittedTranscriptResults(h.adapters)).toBe(1);
    expect(h.finalize).toHaveBeenCalledTimes(1);
  });

  test("a duplicate delivery settles nothing", async () => {
    const h = harness([waiting()], { kind: "ready", payload: {} });
    h.finalize.mockImplementation(async () => ({ kind: "duplicate" }) as never);
    expect(await processSubmittedTranscriptResults(h.adapters)).toBe(0);
  });

  test("404 transcript_not_found stays pending and reports progress", async () => {
    const h = harness([waiting()], { kind: "pending" });
    expect(await processSubmittedTranscriptResults(h.adapters)).toBe(0);
    expect(h.finalize).not.toHaveBeenCalled();
    expect(h.lifecycle.failProviderAttempt).not.toHaveBeenCalled();
    expect(h.lifecycle.reportProgress).toHaveBeenCalledTimes(1);
  });

  test("pending past the result deadline fails the attempt as a retryable timeout", async () => {
    const h = harness([waiting({ submittedAt: new Date(NOW - 2 * 60 * 60_000 - 1) })], { kind: "pending" });
    expect(await processSubmittedTranscriptResults(h.adapters)).toBe(1);
    const [key, failure, ids] = h.lifecycle.failProviderAttempt.mock.calls[0]!;
    expect(key).toEqual({ workflowRunId: "stt-run", attemptId: "attempt" });
    expect(failure).toMatchObject({ code: "elevenlabs_transcription_timeout", disposition: "retryable" });
    expect(ids).toEqual({ transcriptionId: "tr_1" });
    expect(h.notifyFailure).toHaveBeenCalledTimes(1);
  });

  test("ELEVENLABS_RESULT_TIMEOUT_MS moves the deadline", async () => {
    process.env.ELEVENLABS_RESULT_TIMEOUT_MS = "30000";
    const h = harness([waiting()], { kind: "pending" });
    expect(await processSubmittedTranscriptResults(h.adapters)).toBe(1);
    expect(h.lifecycle.failProviderAttempt.mock.calls[0]![1]).toMatchObject({ code: "elevenlabs_transcription_timeout" });
  });

  test("a transient provider error waits for the next tick, bounded by the deadline", async () => {
    const failure = new WorkflowFailure("elevenlabs_transcript_fetch_failed", "retryable", "x");
    const young = harness([waiting()], { kind: "transient", failure });
    expect(await processSubmittedTranscriptResults(young.adapters)).toBe(0);
    expect(young.lifecycle.failProviderAttempt).not.toHaveBeenCalled();

    const old = harness([waiting({ submittedAt: new Date(NOW - 3 * 60 * 60_000) })], { kind: "transient", failure });
    expect(await processSubmittedTranscriptResults(old.adapters)).toBe(1);
    expect(old.lifecycle.failProviderAttempt.mock.calls[0]![1]).toMatchObject({ code: "elevenlabs_transcription_timeout" });
  });

  test("a 401 fails the attempt permanently", async () => {
    const failure = new WorkflowFailure("elevenlabs_auth_failed", "permanent", "x");
    const h = harness([waiting()], { kind: "failed", failure });
    expect(await processSubmittedTranscriptResults(h.adapters)).toBe(1);
    expect(h.lifecycle.failProviderAttempt.mock.calls[0]![1]).toBe(failure);
  });

  test("a run with no recorded id is expired through the lifecycle, without a GET", async () => {
    const h = harness([waiting({ providerJobId: null, submissionDeadlineAt: new Date(NOW - 1) })], { kind: "pending" });
    expect(await processSubmittedTranscriptResults(h.adapters)).toBe(1);
    expect(h.lifecycle.expireUnconfirmedProviderSubmission.mock.calls[0]![0]).toEqual({ workflowRunId: "stt-run", attemptId: "attempt" });
    expect(h.fetchTranscript).not.toHaveBeenCalled();
  });

  test("a submission that is not yet due is left alone", async () => {
    const h = harness([waiting({ providerJobId: null })], { kind: "pending" });
    h.lifecycle.expireUnconfirmedProviderSubmission.mockImplementation(async () => ({ kind: "stale", reason: "submission_pending" }) as never);
    expect(await processSubmittedTranscriptResults(h.adapters)).toBe(0);
  });
});

describe("an unconfirmed POST settles through the durable submission (D1)", () => {
  const DEADLINE_MS = 10 * 60_000;
  const T0 = 20_000_000_000;

  /** A stand-in for the lifecycle rows: one run, one attempt, the transcript's provider id. */
  function rows() {
    const state = {
      status: "running" as "running" | "waiting" | "queued" | "completed",
      attemptId: "attempt-1" as string | null,
      providerJobId: null as string | null,
      deadline: null as number | null,
    };
    let clock = T0;
    const matches = (key: { attemptId: string }) => state.status === "waiting" && state.attemptId === key.attemptId;
    const lifecycle = {
      beginProviderSubmission: async (_attempt: unknown, input: { deadline: Date }) => {
        state.status = "waiting";
        state.deadline = input.deadline.getTime();
      },
      recordProviderAcceptance: async () => ({ kind: "applied" as const }),
      failProviderAttempt: async (key: { attemptId: string }) => {
        if (!matches(key)) return { kind: "stale" as const, reason: "attempt_superseded" as const };
        state.status = "queued";
        state.attemptId = null;
        return { kind: "applied" as const };
      },
      failAttempt: async () => {},
      claimDueWaitingTranscripts: async () =>
        state.status === "waiting" && state.attemptId
          ? [{
              workflowRunId: "stt-run", projectId: "project", stage: "stt", attemptId: state.attemptId, attemptCount: 1, progress: 40,
              providerJobId: state.providerJobId, submissionDeadlineAt: state.deadline ? new Date(state.deadline) : null,
              submittedAt: new Date(T0),
            }] as unknown as WaitingWorkflowAttempt[]
          : [],
      expireUnconfirmedProviderSubmission: async (key: { attemptId: string }) => {
        if (!matches(key)) return { kind: "stale" as const, reason: "attempt_superseded" as const };
        if (state.deadline && state.deadline > clock) return { kind: "stale" as const, reason: "submission_pending" as const };
        state.status = "queued";
        state.attemptId = null;
        return { kind: "applied" as const };
      },
      reportProgress: async () => {},
    };
    /** The webhook: finalizes the waiting attempt it names, whatever ids it carries. */
    const callback = (key: { attemptId: string }) => {
      if (!matches(key)) return { kind: "stale" as const };
      state.status = "completed";
      return { kind: "applied" as const };
    };
    return { state, lifecycle, callback, advance: (ms: number) => { clock += ms; }, now: () => clock };
  }

  async function timedOutSubmission() {
    process.env.ELEVENLABS_API_KEY = "key";
    process.env.ELEVENLABS_WEBHOOK_ID = "wh_dev";
    const r = rows();
    const notifyFailure = mock(async () => {});
    await processTranscriptRun(baseAttempt(), context, undefined, {
      transcriptPlan: async () => ({ plan: { kind: "speech_to_text" as const }, durationSeconds: 600, languageCode: null }),
      completeTranscript: async () => {},
    } as unknown as Parameters<typeof processTranscriptRun>[3], {
      lifecycle: r.lifecycle,
      languageCode: async () => "en",
      presign: async () => "https://r2.example/source?sig=1",
      probe: async () => { throw new Error("not reached"); },
      submit: async () => { throw new ScribeSubmissionUnconfirmed("elevenlabs_transcription_submit_failed", "Scribe submit request timed out", "retryable"); },
      withExtractedAudio: async () => { throw new Error("not reached"); },
      notifyFailure,
      now: r.now,
    } as unknown as TranscriptSubmitAdapters);
    return { ...r, notifyFailure };
  }

  const resultAdapters = (r: ReturnType<typeof rows>, notifyFailure: () => Promise<void>) => ({
    lifecycle: r.lifecycle,
    finalize: async () => ({ kind: "applied" as const }),
    fetchTranscript: async () => ({ kind: "pending" as const }),
    notifyFailure,
    now: r.now,
  }) as unknown as TranscriptResultAdapters;

  test("timeout, then a callback inside the deadline: the same attempt completes", async () => {
    const t = await timedOutSubmission();
    expect(t.state).toMatchObject({ status: "waiting", attemptId: "attempt-1", providerJobId: null });

    t.advance(2 * 60_000);
    expect(await processSubmittedTranscriptResults(resultAdapters(t, t.notifyFailure))).toBe(0);
    expect(t.state.status).toBe("waiting");

    expect(t.callback({ attemptId: "attempt-1" })).toEqual({ kind: "applied" });
    expect(t.state.status).toBe("completed");
    expect(t.notifyFailure).not.toHaveBeenCalled();
  });

  test("timeout, no callback: the deadline expires the attempt and the run retries", async () => {
    const t = await timedOutSubmission();
    t.advance(DEADLINE_MS + 1_000);
    expect(await processSubmittedTranscriptResults(resultAdapters(t, t.notifyFailure))).toBe(1);
    expect(t.state).toMatchObject({ status: "queued", attemptId: null });
    // A callback for the expired attempt is stale.
    expect(t.callback({ attemptId: "attempt-1" })).toEqual({ kind: "stale" });
  });
});
