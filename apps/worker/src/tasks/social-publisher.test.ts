import { describe, expect, test } from "bun:test";
import {
  PublicationClaimLostError,
  type OwnedPublicationAttempt,
} from "@narriflow/services";
import { createSocialPublisherWorker } from "./social-publisher";

function owned(index: number): OwnedPublicationAttempt {
  return { attemptId: `attempt-${index}`, claimId: `claim-${index}` };
}

function runtime(overrides: {
  claims?: OwnedPublicationAttempt[];
  concurrency?: number;
  deadlineMs?: number;
  heartbeatMs?: number;
  execute(attempt: OwnedPublicationAttempt, signal: AbortSignal): Promise<unknown>;
  heartbeat?(attempt: OwnedPublicationAttempt): Promise<void>;
}) {
  return {
    config: {
      worker: {
        concurrency: overrides.concurrency ?? 2,
        providerDeadlineMs: overrides.deadlineMs ?? 1_000,
        heartbeatMs: overrides.heartbeatMs ?? 100,
      },
    },
    claimDue: async () => overrides.claims ?? [],
    heartbeat: overrides.heartbeat ?? (async () => undefined),
    attempt: {
      execute: ({ attempt, signal }: { attempt: OwnedPublicationAttempt; signal: AbortSignal }) =>
        overrides.execute(attempt, signal),
    },
  } as never;
}

describe("social publisher worker orchestration", () => {
  test("enforces bounded concurrency while continuing after an isolated crash", async () => {
    const claims = Array.from({ length: 6 }, (_, index) => owned(index + 1));
    let active = 0;
    let maximumActive = 0;
    const completed: string[] = [];
    const logs: Array<{ message: string; context: Record<string, unknown> }> = [];
    const worker = createSocialPublisherWorker({
      runtime: runtime({
        claims,
        concurrency: 2,
        async execute(attempt) {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await Bun.sleep(3);
          active -= 1;
          if (attempt.attemptId === "attempt-2") throw new Error("injected crash");
          completed.push(attempt.attemptId);
          return { kind: "posted" };
        },
      }),
      workerId: "worker-test",
      log: (_level, message, context) => logs.push({ message, context }),
    });

    await expect(worker.processDuePosts()).resolves.toBe(6);
    expect(maximumActive).toBe(2);
    expect(completed).toHaveLength(5);
    expect(logs.some((entry) => entry.message === "social_publication_attempt_crashed")).toBe(true);
  });

  test("a provider deadline aborts owned work and leaves settlement to the attempt", async () => {
    let observedAbort = false;
    const worker = createSocialPublisherWorker({
      runtime: runtime({
        claims: [owned(1)],
        deadlineMs: 5,
        async execute(_attempt, signal) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => {
              observedAbort = true;
              resolve();
            }, { once: true });
          });
          return { kind: "interrupted" };
        },
      }),
      workerId: "worker-test",
      log: () => undefined,
    });

    await expect(worker.processDuePosts()).resolves.toBe(1);
    expect(observedAbort).toBe(true);
  });

  test("heartbeat ownership loss aborts execution and is control flow, not a crash", async () => {
    const messages: string[] = [];
    let aborted = false;
    const worker = createSocialPublisherWorker({
      runtime: runtime({
        claims: [owned(1)],
        heartbeatMs: 2,
        heartbeat: async () => {
          throw new PublicationClaimLostError();
        },
        async execute(_attempt, signal) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve();
            }, { once: true });
          });
          throw new PublicationClaimLostError();
        },
      }),
      workerId: "worker-test",
      log: (_level, message) => messages.push(message),
    });

    await expect(worker.processDuePosts()).resolves.toBe(1);
    expect(aborted).toBe(true);
    expect(messages).toContain("social_publication_claim_lost");
    expect(messages).not.toContain("social_publication_attempt_crashed");
  });

  test("graceful shutdown aborts owned attempts so they release durable claims", async () => {
    const shutdown = new AbortController();
    let observedAbort = false;
    const worker = createSocialPublisherWorker({
      runtime: runtime({
        claims: [owned(1)],
        async execute(_attempt, signal) {
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                resolve();
              },
              { once: true },
            );
          });
          return { kind: "interrupted" };
        },
      }),
      workerId: "worker-test",
      shutdownSignal: shutdown.signal,
      log: () => undefined,
    });

    const processing = worker.processDuePosts();
    await Bun.sleep(0);
    shutdown.abort();
    await expect(processing).resolves.toBe(1);
    expect(observedAbort).toBe(true);
  });

  test("shutdown during claiming never starts newly returned provider work", async () => {
    const shutdown = new AbortController();
    let releaseClaims!: (claims: OwnedPublicationAttempt[]) => void;
    const claimsReady = new Promise<OwnedPublicationAttempt[]>((resolve) => {
      releaseClaims = resolve;
    });
    let executions = 0;
    const worker = createSocialPublisherWorker({
      runtime: {
        ...runtime({
          async execute() {
            executions += 1;
            return { kind: "interrupted" };
          },
        }),
        claimDue: async () => claimsReady,
      } as never,
      workerId: "worker-test",
      shutdownSignal: shutdown.signal,
      log: () => undefined,
    });

    const processing = worker.processDuePosts();
    shutdown.abort();
    releaseClaims([owned(1), owned(2)]);

    await expect(processing).resolves.toBe(0);
    expect(executions).toBe(0);
  });

  test("shutdown stops dequeuing the remainder of an already claimed batch", async () => {
    const shutdown = new AbortController();
    const started: string[] = [];
    const worker = createSocialPublisherWorker({
      runtime: runtime({
        claims: [owned(1), owned(2), owned(3)],
        concurrency: 1,
        async execute(attempt) {
          started.push(attempt.attemptId);
          shutdown.abort();
          return { kind: "interrupted" };
        },
      }),
      workerId: "worker-test",
      shutdownSignal: shutdown.signal,
      log: () => undefined,
    });

    await expect(worker.processDuePosts()).resolves.toBe(1);
    expect(started).toEqual(["attempt-1"]);
  });
});
