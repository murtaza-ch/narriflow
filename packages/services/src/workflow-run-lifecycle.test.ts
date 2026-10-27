import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import { ClipEditorDocumentPersistenceError } from "./clip-editor-document-persistence";
import {
  WorkflowFailure,
  WorkflowAttemptLost,
  WorkflowRunLifecycle,
  type WorkflowAttemptRef,
  workflowFailureFromUnknown,
  workflowHttpFailureDisposition,
} from "./workflow-run-lifecycle";

describe("Workflow Attempt heartbeat recovery", () => {
  const attempt: WorkflowAttemptRef = {
    workflowRunId: "heartbeat-run",
    projectId: "heartbeat-project",
    stage: "dubbing",
    attemptId: "heartbeat-attempt",
  };

  function lifecycle() {
    return new WorkflowRunLifecycle({
      prisma: {} as PrismaClient,
      leaseOwner: "heartbeat-worker",
      leaseDurationMs: 100,
      heartbeatIntervalMs: 5,
    });
  }

  test("a transient database error leaves the attempt running for the next heartbeat", async () => {
    const runner = lifecycle();
    let heartbeatCount = 0;
    let renewed!: () => void;
    const renewal = new Promise<void>((resolve) => { renewed = resolve; });
    runner.heartbeat = async () => {
      heartbeatCount += 1;
      if (heartbeatCount === 1) throw new Error("temporary connection failure");
      renewed();
    };

    await expect(runner.runAttempt(attempt, async ({ signal }) => {
      const outcome = await Promise.race([
        renewal.then(() => "renewed"),
        new Promise<string>((resolve) => signal.addEventListener("abort", () => resolve("aborted"), { once: true })),
      ]);
      expect(signal.aborted).toBe(false);
      return outcome;
    })).resolves.toBe("renewed");
    expect(heartbeatCount).toBe(2);
  });

  test("confirmed ownership loss aborts execution and preserves the ownership error", async () => {
    const runner = lifecycle();
    const lost = new WorkflowAttemptLost(attempt);
    runner.heartbeat = async () => { throw lost; };
    let executionAborted = false;

    await expect(runner.runAttempt(attempt, async ({ signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
        executionAborted = true;
        resolve();
      }, { once: true }));
    })).rejects.toBe(lost);
    expect(executionAborted).toBe(true);
  });

  test("a sustained database outage stops execution once the lease cannot be renewed", async () => {
    const runner = new WorkflowRunLifecycle({
      prisma: {} as PrismaClient,
      leaseOwner: "heartbeat-worker",
      leaseDurationMs: 25,
      heartbeatIntervalMs: 5,
    });
    let heartbeats = 0;
    runner.heartbeat = async () => {
      heartbeats += 1;
      throw new Error("database unavailable");
    };

    await expect(runner.runAttempt(attempt, async ({ signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    })).rejects.toBeInstanceOf(WorkflowAttemptLost);
    expect(heartbeats).toBeGreaterThan(1);
  });

  test("an unresponsive heartbeat cannot keep work running past its lease", async () => {
    const runner = new WorkflowRunLifecycle({
      prisma: {} as PrismaClient,
      leaseOwner: "heartbeat-worker",
      leaseDurationMs: 25,
      heartbeatIntervalMs: 5,
    });
    runner.heartbeat = () => new Promise<void>(() => {});
    const shutdown = new AbortController();
    const stop = setTimeout(() => shutdown.abort(), 100);
    try {
      await expect(runner.runAttempt(attempt, async ({ signal }) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      }, { signal: shutdown.signal })).rejects.toBeInstanceOf(WorkflowAttemptLost);
    } finally {
      clearTimeout(stop);
    }
  });
});

describe("Workflow Failure disposition", () => {
  test("classifies permanent and transient HTTP responses at the provider boundary", () => {
    expect(workflowHttpFailureDisposition(400)).toBe("permanent");
    expect(workflowHttpFailureDisposition(401)).toBe("permanent");
    expect(workflowHttpFailureDisposition(429)).toBe("retryable");
    expect(workflowHttpFailureDisposition(503)).toBe("retryable");
  });

  test("preserves a disposition already assigned by the failure source", () => {
    const source = new WorkflowFailure(
      "invalid_provider_request",
      "permanent",
      "Provider rejected the request",
    );
    expect(workflowFailureFromUnknown(source)).toBe(source);
  });

  test("reads typed retryability from bounded domain details", () => {
    expect(
      workflowFailureFromUnknown(
        new ClipEditorDocumentPersistenceError(
          "editor_document_empty_timeline",
          "The document has no timeline",
        ),
      ).disposition,
    ).toBe("permanent");
    expect(
      workflowFailureFromUnknown(
        new ClipEditorDocumentPersistenceError(
          "retryable_contention",
          "Try again",
        ),
      ).disposition,
    ).toBe("retryable");
  });
});
