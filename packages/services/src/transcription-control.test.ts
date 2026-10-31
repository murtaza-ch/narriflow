import { expect, test } from "bun:test";
import { createTranscriptionControl } from "./transcription-control";
import { ScribeSubmissionUnconfirmed } from "./transcription-provider";

const reference = { dispatchId: "190f5cd8-2f6a-42a6-96dc-1dd08a99b2fb", deploymentEpoch: 1, kind: "operation_driver" as const,
  subject: { kind: "workflow_run" as const, id: "ce4d7e7e-caae-4d85-80f8-17f55e2eaf79" }, generation: 1, inputHash: "f".repeat(64) };
const key = { workflowRunId: reference.subject.id, attemptId: "05bfd4bb-8ce2-455c-a598-1328f676a288", deploymentEpoch: 1,
  sourceRevision: 1, sourceAudioId: "d5ab39a2-80e7-45d1-8da8-5bc90097075e" };
const now = new Date("2026-10-31T00:00:00Z"), deadline = new Date("2026-10-31T00:10:00Z"), hold = new Date("2026-10-31T04:00:00Z");
const intent = { kind: "begun" as const, reference: key, serverTime: now, submissionDeadlineAt: deadline, providerAudioGrantExpiresAt: hold, dispatchIds: [reference.dispatchId] };

function harness(input: { unknown?: boolean; deliveryFailure?: boolean; explicitLanguage?: string; skip?: boolean } = {}) {
  let admissions = 0, submissions = 0, grants = 0, probes = 0;
  const deliveries: string[][] = [], failures: unknown[] = [];
  const waiting = { kind: "waiting" as const, attempt: { workflowRunId: key.workflowRunId, projectId: crypto.randomUUID(), attemptId: key.attemptId, attemptCount: 1, stage: "stt" as const },
    providerJobId: null as string | null, providerRequestId: null as string | null, submissionDeadlineAt: deadline as Date | null, resultDeadlineAt: null as Date | null,
    submittedAt: now, serverTime: now, nextCheckAt: deadline };
  const control = createTranscriptionControl({
    admission: { admit: async () => input.skip ? { kind: "completed", dispatchIds: [] } : ++admissions === 1 ?
      { kind: "begun", intent, languageCode: input.explicitLanguage ?? null, dispatchIds: intent.dispatchIds } :
      { kind: "already_waiting", intent: { ...intent, kind: "already_waiting" }, dispatchIds: intent.dispatchIds } },
    workflow: {
      readProviderControl: async () => waiting,
      recordProviderAcceptance: async (_key, accepted) => { waiting.providerJobId = accepted.transcriptionId; waiting.providerRequestId = accepted.requestId;
        waiting.resultDeadlineAt = new Date("2026-10-31T02:00:00Z"); waiting.nextCheckAt = new Date("2026-10-31T00:00:30Z"); waiting.submissionDeadlineAt = null;
        return { kind: "applied", dispatchIds: ["6d6aa630-d89d-40c8-a7fe-8af8d1f726ae"] }; },
      failProviderAttempt: async (_key, error) => { failures.push(error); return { kind: "applied" }; },
      expireProviderDeadline: async () => { throw new Error("No expiry expected"); },
      observeProviderPending: async () => { throw new Error("No recovery expected"); },
    },
    provider: () => ({ submit: async submission => { submissions++; expect(submission.reference).toEqual(key); expect(submission.sourceAudioUrl).toBe("https://private.example/audio");
      expect(submission.languageCode).toBe(input.explicitLanguage ?? "urd"); if (input.unknown) throw new ScribeSubmissionUnconfirmed(); return { requestId: "request", transcriptionId: "transcription" }; },
      result: async () => { throw new Error("No GET expected"); } }),
    sourceAudioGrant: async (_key, expiresAt) => { grants++; expect(expiresAt).toEqual(hold); return { sourceAudioId: key.sourceAudioId!, url: "https://private.example/audio", expiresAt: hold }; },
    probeLanguage: async () => { probes++; return { pinned: "ur", reason: "pinned" }; },
    finalize: async () => { throw new Error("No finalization expected"); },
    deliverWakes: async ids => { deliveries.push([...ids]); if (input.deliveryFailure) throw new Error("scheduler_unavailable"); },
  });
  return { control, deliveries, failures, calls: () => ({ submissions, grants, probes }) };
}

test("fresh STT command confirms intent before one POST and a repeated invocation cannot POST again", async () => {
  const h = harness();
  expect((await h.control.run(reference)).kind).toBe("wait");
  expect((await h.control.run(reference)).kind).toBe("wait");
  expect(h.calls()).toEqual({ submissions: 1, grants: 1, probes: 1 });
  expect(h.deliveries[0]).toEqual(intent.dispatchIds);
  expect(h.failures).toEqual([]);
});

test("unknown acceptance stays on the original intent deadline with no second POST", async () => {
  const h = harness({ unknown: true });
  expect(await h.control.run(reference)).toEqual({ kind: "wait", dueAt: deadline });
  expect(await h.control.run(reference)).toEqual({ kind: "wait", dueAt: deadline });
  expect(h.calls().submissions).toBe(1);
  expect(h.failures).toEqual([]);
});

test("an unconfirmed intent wake prevents heavy submission and explicit language bypasses the optional probe", async () => {
  const denied = harness({ deliveryFailure: true });
  await expect(denied.control.run(reference)).rejects.toThrow("scheduler_unavailable");
  expect(denied.calls()).toEqual({ submissions: 0, grants: 0, probes: 0 });
  const pinned = harness({ explicitLanguage: "eng" });
  await pinned.control.run(reference);
  expect(pinned.calls()).toEqual({ submissions: 1, grants: 1, probes: 0 });
});

test("a completed supplied or empty plan never needs provider configuration or source grants", async () => {
  const h = harness({ skip: true });
  expect(await h.control.run(reference)).toEqual({ kind: "complete", disposition: "terminal" });
  expect(h.calls()).toEqual({ submissions: 0, grants: 0, probes: 0 });
});
