import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createScribeFinalizer,
  scribeRawStorageKey,
  type ScribeFinalizerDependencies,
} from "./scribe-transcript";
import type {
  CompleteTranscriptInput,
  ProviderAttemptLookup,
  ProviderSettlementResult,
  WorkflowFailure,
} from "./workflow-run-lifecycle";

const key = { workflowRunId: "run-1", attemptId: "attempt-1" };
const providerIds = { requestId: "req_1", transcriptionId: "tx_1" };
const attempt = { workflowRunId: "run-1", attemptId: "attempt-1", projectId: "project-1", stage: "transcription" } as never;
const waiting: ProviderAttemptLookup = {
  kind: "waiting", attempt, providerJobId: "tx_1", providerRequestId: "req_1", submissionDeadlineAt: null,
};
const payload = JSON.parse(readFileSync(join(import.meta.dir, "test-fixtures/scribe/en-diarized.json"), "utf8"));

function harness(options: {
  lookup?: ProviderAttemptLookup;
  allowEmpty?: boolean;
  duration?: number | null;
  settle?: ProviderSettlementResult;
  storeError?: Error;
} = {}) {
  const calls: string[] = [];
  const stored: { key: string; value: unknown; metadata: Record<string, string> }[] = [];
  const completed: CompleteTranscriptInput[] = [];
  const failed: { failure: WorkflowFailure; ids: unknown }[] = [];
  const lookups: unknown[] = [];
  const deps: ScribeFinalizerDependencies = {
    lifecycle: {
      async lookupProviderAttempt(_key, ids) {
        calls.push("lookup");
        lookups.push(ids);
        return options.lookup ?? waiting;
      },
      async completeProviderTranscript(_key, input) {
        calls.push("complete");
        completed.push(input);
        return options.settle ?? { kind: "applied" };
      },
      async failProviderAttempt(_key, failure, ids) {
        calls.push("fail");
        failed.push({ failure, ids });
        return options.settle ?? { kind: "applied" };
      },
    },
    async allowsEmptyTranscript() { return options.allowEmpty ?? false; },
    async sourceDurationSeconds() { return options.duration === undefined ? 188.4 : options.duration; },
    async storeRawJson(input) {
      calls.push("store");
      if (options.storeError) throw options.storeError;
      stored.push(input);
    },
  };
  return { finalize: createScribeFinalizer(deps), calls, stored, completed, failed, lookups };
}

describe("scribeRawStorageKey", () => {
  test("is keyed by project, run, attempt and provider model", () => {
    expect(scribeRawStorageKey("project-1", key)).toBe(
      "projects/project-1/transcripts/run-1-attempt-1-elevenlabs-scribe_v2.json",
    );
  });
});

describe("finalizeScribeTranscript", () => {
  test("stores the raw result, normalizes it and completes the waiting attempt", async () => {
    const h = harness();
    const result = await h.finalize({ key, payload, providerIds });

    expect(result).toEqual({ kind: "applied" });
    expect(h.calls).toEqual(["lookup", "store", "complete"]);
    expect(h.lookups).toEqual([providerIds]);
    expect(h.stored).toEqual([{
      key: "projects/project-1/transcripts/run-1-attempt-1-elevenlabs-scribe_v2.json",
      value: payload,
      metadata: {
        project_id: "project-1", workflow_run_id: "run-1", attempt_id: "attempt-1",
        provider: "elevenlabs", provider_job_id: "tx_1", provider_request_id: "req_1",
      },
    }]);
    expect(h.completed).toHaveLength(1);
    expect(h.completed[0]).toMatchObject({
      provider: "elevenlabs",
      providerModel: "scribe_v2",
      providerJobId: "tx_1",
      providerRequestId: "req_1",
      languageCode: "en",
      durationSeconds: 188,
      rawStorageKey: "projects/project-1/transcripts/run-1-attempt-1-elevenlabs-scribe_v2.json",
    });
    expect(h.completed[0]!.speakerCount).toBeGreaterThan(1);
    expect((h.completed[0]!.utterances as unknown[]).length).toBeGreaterThan(0);
  });

  test("falls back to the payload's transcription id when the caller has none", async () => {
    const h = harness();
    await h.finalize({ key, payload, providerIds: {} });
    expect(h.completed[0]).toMatchObject({ providerJobId: payload.transcription_id, providerRequestId: null });
  });

  const noops: [string, ProviderAttemptLookup][] = [
    ["a stale attempt", { kind: "stale", reason: "attempt_superseded" }],
    ["a provider id mismatch", { kind: "stale", reason: "provider_job_mismatch" }],
    ["a missing run", { kind: "stale", reason: "run_missing" }],
    ["a run that is not waiting", { kind: "stale", reason: "not_waiting" }],
    ["a duplicate delivery", { kind: "duplicate" }],
    ["a terminal run", { kind: "terminal", status: "completed" }],
    ["a cancelled run", { kind: "terminal", status: "failed" }],
  ];
  for (const [name, lookup] of noops) {
    test(`${name} is acknowledged without storing or writing`, async () => {
      const h = harness({ lookup });
      expect(await h.finalize({ key, payload, providerIds })).toEqual(lookup);
      expect(h.calls).toEqual(["lookup"]);
    });
  }

  test("returns what the lifecycle settles, even when the attempt went stale after the lookup", async () => {
    const h = harness({ settle: { kind: "stale", reason: "attempt_superseded" } });
    expect(await h.finalize({ key, payload, providerIds })).toEqual({ kind: "stale", reason: "attempt_superseded" });
    expect(h.calls).toEqual(["lookup", "store", "complete"]);
  });

  test("an unusable result fails the attempt permanently and keeps the raw evidence", async () => {
    const h = harness();
    const bad = { ...payload, words: [{ text: "Hi", start: 2, end: 1, type: "word", speaker_id: "speaker_0" }] };
    expect(await h.finalize({ key, payload: bad, providerIds })).toEqual({ kind: "applied" });
    expect(h.calls).toEqual(["lookup", "store", "fail"]);
    expect(h.completed).toEqual([]);
    expect(h.failed).toHaveLength(1);
    expect(h.failed[0]!.failure).toMatchObject({ code: "elevenlabs_result_invalid", disposition: "permanent" });
    expect(h.failed[0]!.ids).toEqual(providerIds);
  });

  test("a result with no speech fails unless the generation is caption-only", async () => {
    const silent = { ...payload, words: [] };
    const refused = harness();
    await refused.finalize({ key, payload: silent, providerIds });
    expect(refused.calls).toEqual(["lookup", "store", "fail"]);

    const allowed = harness({ allowEmpty: true, duration: 7.6 });
    await allowed.finalize({ key, payload: silent, providerIds });
    expect(allowed.calls).toEqual(["lookup", "store", "complete"]);
    expect(allowed.completed[0]).toMatchObject({ text: "", utterances: [], speakerCount: 0, durationSeconds: 8 });
  });

  test("an unknown probed duration falls back to the last word", async () => {
    const h = harness({ duration: null });
    await h.finalize({ key, payload, providerIds });
    const last = payload.words.filter((w: { type: string }) => w.type === "word").at(-1);
    expect(h.completed[0]!.durationSeconds).toBe(Math.round(last.end));
  });

  test("a storage failure is thrown for a retry and never completes the transcript", async () => {
    const h = harness({ storeError: new Error("r2 unavailable") });
    await expect(h.finalize({ key, payload, providerIds })).rejects.toThrow("r2 unavailable");
    expect(h.calls).toEqual(["lookup", "store"]);
  });
});
