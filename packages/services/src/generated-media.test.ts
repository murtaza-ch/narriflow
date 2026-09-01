import { describe, expect, test } from "bun:test";
import {
  GeneratedMediaProviderError,
  createGeneratedMediaModule,
  createInMemoryGeneratedMediaStore,
  type GeneratedImageProvider,
  type GeneratedMediaPublisher,
  type GeneratedMediaStore,
  type GenerationUsageLedger,
} from "./generated-media";
import { GeneratedMediaPublicationError } from "./generated-media-publisher";

const scope = {
  actorUserId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  workspaceOwnerUserId: "00000000-0000-4000-8000-000000000001",
  role: "owner" as const,
  status: "active" as const,
  pricingTier: "creator",
  isPersonalWorkspace: true,
};

const request = {
  projectId: "00000000-0000-4000-8000-000000000010",
  clipId: "00000000-0000-4000-8000-000000000011",
  idempotencyKey: "studio-generate-001",
  prompt: "Editorial photograph of a software engineer leaving a glass office tower",
  promptOrigin: "transcript_selection" as const,
  aspectRatio: "9:16" as const,
  style: "editorial" as const,
  sourceStartSec: 12,
  sourceEndSec: 15,
};

function harness(overrides: {
  provider?: GeneratedImageProvider;
  publisher?: GeneratedMediaPublisher;
  store?: GeneratedMediaStore;
  ids?: () => string;
  now?: () => Date;
  maxAttempts?: number;
} = {}) {
  const usageEvents: string[] = [];
  const usage: GenerationUsageLedger = {
    async reserve({ jobId }) {
      usageEvents.push(`reserve:${jobId}`);
      return { reservationId: `reservation:${jobId}` };
    },
    async finalize({ jobId }) {
      usageEvents.push(`finalize:${jobId}`);
    },
    async release({ jobId }) {
      usageEvents.push(`release:${jobId}`);
    },
  };
  const provider = overrides.provider ?? {
    async submit() {
      return { kind: "completed" as const, providerRef: "openai:image:1", usage: { images: 1 } };
    },
    async poll() {
      return { kind: "completed" as const, providerRef: "openai:image:1", usage: { images: 1 } };
    },
    async cancel() {
      return { kind: "cancelled" as const };
    },
    async result() {
      return {
        contentType: "image/png" as const,
        bytes: new Uint8Array([137, 80, 78, 71]),
      };
    },
  } satisfies GeneratedImageProvider;
  const publisher = overrides.publisher ?? {
    async publish({ jobId }) {
      return {
        id: "00000000-0000-4000-8000-000000000003",
        title: "Leaving big tech",
        kind: "image" as const,
        contentType: "image/png" as const,
        sizeBytes: 4,
        width: 1080,
        height: 1920,
        durationSec: null,
        fingerprint: `sha256:${jobId}`,
        provenance: "generated" as const,
        accessUrl: "https://media.example.test/generated.png",
        replayed: false,
        createdAt: "2026-09-01T00:00:00.000Z",
      };
    },
  } satisfies GeneratedMediaPublisher;
  const module = createGeneratedMediaModule({
    store: overrides.store ?? createInMemoryGeneratedMediaStore(),
    provider,
    publisher,
    usage,
    promptProtection: {
      protect: (value) => `protected:${value}`,
      reveal: (value) => value.slice("protected:".length),
      fingerprint: (value) => `fingerprint:${value.length}`,
    },
    ids: overrides.ids ?? (() => {
      let value = 0;
      return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
    })(),
    now: overrides.now ?? (() => new Date("2026-09-01T00:00:00.000Z")),
    maxAttempts: overrides.maxAttempts,
  });
  return { module, usageEvents };
}

describe("Generated Media Job", () => {
  test("reserves before submission, publishes once, and finalizes usage once", async () => {
    const { module, usageEvents } = harness();
    const created = await module.create(scope, request);

    expect(created).toMatchObject({ status: "queued", promptOrigin: "transcript_selection" });
    expect(created).not.toHaveProperty("prompt");
    expect(usageEvents).toEqual([`reserve:${created.id}`]);

    const completed = await module.process(created.id);
    expect(completed).toMatchObject({
      status: "completed",
      provider: "openai",
      providerRef: "openai:image:1",
      resultAsset: { id: "00000000-0000-4000-8000-000000000003" },
      usageStatus: "finalized",
    });
    expect(usageEvents).toEqual([
      `reserve:${created.id}`,
      `finalize:${created.id}`,
    ]);

    await module.process(created.id);
    expect(usageEvents.filter((event) => event.startsWith("finalize:"))).toHaveLength(1);
  });

  test("replays an idempotent create without reserving twice and rejects a conflicting payload", async () => {
    const { module, usageEvents } = harness();
    const first = await module.create(scope, request);
    const replay = await module.create(scope, request);

    expect(replay.id).toBe(first.id);
    expect(replay.replayed).toBe(true);
    expect(usageEvents).toEqual([`reserve:${first.id}`]);
    await expect(module.create(scope, { ...request, prompt: "A different image" })).rejects.toMatchObject({
      code: "generated_media_idempotency_conflict",
    });
  });

  test.each([
    ["rejected", "safety_rejection"],
    ["failed", "invalid_request"],
    ["cancelled", "provider_cancelled"],
  ] as const)("releases usage for known terminal %s outcomes", async (kind, code) => {
    const { module, usageEvents } = harness({
      provider: {
        async submit() {
          if (kind === "rejected") return { kind, code };
          if (kind === "cancelled") return { kind };
          return { kind, code, retryable: false };
        },
        async poll() {
          throw new Error("not reached");
        },
        async cancel() {
          return { kind: "cancelled" as const };
        },
        async result() {
          throw new Error("not reached");
        },
      },
    });
    const job = await module.create(scope, { ...request, idempotencyKey: `terminal-${kind}` });
    const terminal = await module.process(job.id);
    expect(terminal.status).toBe(kind === "rejected" ? "rejected" : kind === "cancelled" ? "cancelled" : "failed");
    expect(terminal.usageStatus).toBe("released");
    expect(usageEvents.at(-1)).toBe(`release:${job.id}`);
  });

  test("keeps usage reserved for an unknown provider outcome and reconciles before retry or refund", async () => {
    let submissions = 0;
    const { module, usageEvents } = harness({
      provider: {
        async submit() {
          submissions += 1;
          throw new GeneratedMediaProviderError("provider_outcome_unknown", {
            outcomeUnknown: true,
          });
        },
        async poll() {
          return { kind: "waiting" as const, providerRef: "openai:image:unknown" };
        },
        async cancel() {
          return { kind: "cancelled" as const };
        },
        async result() {
          throw new Error("not reached");
        },
      },
    });
    const job = await module.create(scope, { ...request, idempotencyKey: "unknown-1" });
    const waiting = await module.process(job.id);

    expect(waiting).toMatchObject({ status: "waiting", usageStatus: "reserved", outcomeUnknown: true });
    expect(usageEvents).toEqual([`reserve:${job.id}`]);
    await module.process(job.id);
    expect(submissions).toBe(1);

    await module.reconcile(job.id, { kind: "retry" });
    await module.process(job.id);
    expect(submissions).toBe(2);
  });

  test("keeps completed publication idempotent across a duplicate completion", async () => {
    let publications = 0;
    const { module, usageEvents } = harness({
      publisher: {
        async publish({ jobId }) {
          publications += 1;
          return {
            id: "00000000-0000-4000-8000-000000000003",
            title: "Generated",
            kind: "image" as const,
            contentType: "image/png" as const,
            sizeBytes: 4,
            width: 1080,
            height: 1920,
            durationSec: null,
            fingerprint: `sha256:${jobId}`,
            provenance: "generated" as const,
            accessUrl: null,
            replayed: publications > 1,
            createdAt: "2026-09-01T00:00:00.000Z",
          };
        },
      },
    });
    const job = await module.create(scope, { ...request, idempotencyKey: "duplicate-completion" });
    await module.process(job.id);
    await module.process(job.id);
    expect(publications).toBe(1);
    expect(usageEvents.filter((event) => event.startsWith("finalize:"))).toHaveLength(1);
  });

  test("persists a waiting provider reference and completes it through polling", async () => {
    let polls = 0;
    const { module, usageEvents } = harness({
      provider: {
        async submit() {
          return { kind: "waiting" as const, providerRef: "provider:async:1" };
        },
        async poll() {
          polls += 1;
          return { kind: "completed" as const, providerRef: "provider:async:1", usage: { images: 1 } };
        },
        async cancel() {
          return { kind: "cancelled" as const };
        },
        async result() {
          return { contentType: "image/png" as const, bytes: new Uint8Array([137, 80, 78, 71]) };
        },
      },
    });
    const job = await module.create(scope, { ...request, idempotencyKey: "provider-waiting" });

    expect(await module.process(job.id)).toMatchObject({ status: "waiting", providerRef: "provider:async:1" });
    expect(await module.process(job.id)).toMatchObject({ status: "completed", moderationStatus: "approved" });
    expect(polls).toBe(1);
    expect(usageEvents.at(-1)).toBe(`finalize:${job.id}`);
  });

  test("cancels a submitted waiting job and releases its reservation", async () => {
    let cancellations = 0;
    const { module, usageEvents } = harness({
      provider: {
        async submit() {
          return { kind: "waiting" as const, providerRef: "provider:async:cancel" };
        },
        async poll() {
          return { kind: "waiting" as const, providerRef: "provider:async:cancel" };
        },
        async cancel() {
          cancellations += 1;
          return { kind: "cancelled" as const };
        },
        async result() {
          throw new Error("not reached");
        },
      },
    });
    const job = await module.create(scope, { ...request, idempotencyKey: "provider-cancel" });
    await module.process(job.id);

    expect(await module.cancel(scope, job.id)).toMatchObject({ status: "cancelled", usageStatus: "released" });
    expect(cancellations).toBe(1);
    expect(usageEvents.at(-1)).toBe(`release:${job.id}`);
  });

  test("does not release usage while a synchronous provider request is in flight", async () => {
    const store = createInMemoryGeneratedMediaStore();
    const { module, usageEvents } = harness({ store });
    const job = await module.create(scope, { ...request, idempotencyKey: "provider-in-flight" });
    await store.claim(job.id, "active-worker", new Date("2026-09-01T00:00:00.000Z"), 300_000);
    await store.update(job.id, { status: "running" });

    await expect(module.cancel(scope, job.id)).rejects.toMatchObject({
      code: "generated_media_cancellation_pending",
    });
    expect(usageEvents).toEqual([`reserve:${job.id}`]);
  });

  test("requires explicit reconciliation instead of cancelling an unknown provider outcome", async () => {
    const { module, usageEvents } = harness({
      provider: {
        async submit() {
          throw new GeneratedMediaProviderError("provider_outcome_unknown", { outcomeUnknown: true });
        },
        async poll() {
          throw new Error("not reached");
        },
        async cancel() {
          throw new Error("not reached");
        },
        async result() {
          throw new Error("not reached");
        },
      },
    });
    const job = await module.create(scope, { ...request, idempotencyKey: "unknown-cancel" });
    await module.process(job.id);

    await expect(module.cancel(scope, job.id)).rejects.toMatchObject({
      code: "generated_media_reconciliation_required",
    });
    expect(usageEvents).toEqual([`reserve:${job.id}`]);
  });

  test("holds usage for reconciliation when publication fails after a provider completion", async () => {
    let submissions = 0;
    const { module, usageEvents } = harness({
      provider: {
        async submit() {
          submissions += 1;
          return {
            kind: "completed" as const,
            providerRef: "openai:image:charged",
            usage: { images: 1 },
            result: { contentType: "image/png" as const, bytes: new Uint8Array([137, 80, 78, 71]) },
          };
        },
        async poll() {
          throw new Error("not reached");
        },
        async cancel() {
          return { kind: "cancelled" as const };
        },
        async result() {
          throw new Error("not reached");
        },
      },
      publisher: {
        async publish() {
          throw new GeneratedMediaPublicationError("generated_media_attempt_unavailable");
        },
      },
    });
    const job = await module.create(scope, { ...request, idempotencyKey: "publication-reconciliation" });

    const waiting = await module.process(job.id);
    expect(waiting).toMatchObject({
      status: "waiting",
      providerRef: "openai:image:charged",
      usageStatus: "reserved",
      outcomeUnknown: true,
      errorCode: "generated_media_publication_reconciliation_required",
    });
    await module.process(job.id);
    expect(submissions).toBe(1);
    expect(usageEvents).toEqual([`reserve:${job.id}`]);
  });

  test("resumes a staged provider result without submitting or charging twice", async () => {
    let timestamp = new Date("2026-09-01T00:00:00.000Z");
    let submissions = 0;
    let publications = 0;
    const { module, usageEvents } = harness({
      now: () => timestamp,
      provider: {
        async submit() {
          submissions += 1;
          return {
            kind: "completed" as const,
            providerRef: "openai:image:staged",
            usage: { images: 1 },
            result: { contentType: "image/png" as const, bytes: new Uint8Array([137, 80, 78, 71]) },
          };
        },
        async poll() {
          throw new Error("not reached");
        },
        async cancel() {
          return { kind: "cancelled" as const };
        },
        async result() {
          throw new Error("not reached");
        },
      },
      publisher: {
        async publish(input) {
          publications += 1;
          if (publications === 1) throw new Error("database_unavailable");
          expect(input.result).toBeUndefined();
          return {
            id: "00000000-0000-4000-8000-000000000003",
            title: "Recovered image",
            kind: "image" as const,
            contentType: "image/png" as const,
            sizeBytes: 4,
            width: 1024,
            height: 1536,
            durationSec: null,
            fingerprint: "sha256:recovered",
            provenance: "generated" as const,
            accessUrl: null,
            replayed: false,
            createdAt: timestamp.toISOString(),
          };
        },
      },
    });
    const job = await module.create(scope, { ...request, idempotencyKey: "publication-resume" });

    expect(await module.process(job.id)).toMatchObject({
      status: "queued",
      errorCode: "generated_media_publication_retrying",
      outcomeUnknown: false,
    });
    timestamp = new Date(timestamp.getTime() + 5_000);
    expect(await module.process(job.id)).toMatchObject({ status: "completed", usageStatus: "finalized" });
    expect(submissions).toBe(1);
    expect(publications).toBe(2);
    expect(usageEvents.filter((event) => event.startsWith("finalize:"))).toHaveLength(1);
  });

  test("bounds retryable provider attempts and releases usage on exhaustion", async () => {
    let timestamp = new Date("2026-09-01T00:00:00.000Z");
    let submissions = 0;
    const { module, usageEvents } = harness({
      now: () => timestamp,
      maxAttempts: 2,
      provider: {
        async submit() {
          submissions += 1;
          return { kind: "failed" as const, code: "provider_busy", retryable: true, retryAfterMs: 1 };
        },
        async poll() {
          throw new Error("not reached");
        },
        async cancel() {
          return { kind: "cancelled" as const };
        },
        async result() {
          throw new Error("not reached");
        },
      },
    });
    const job = await module.create(scope, { ...request, idempotencyKey: "bounded-retries" });

    expect(await module.process(job.id)).toMatchObject({ status: "queued", attempt: 1 });
    timestamp = new Date(timestamp.getTime() + 1);
    expect(await module.process(job.id)).toMatchObject({
      status: "failed",
      usageStatus: "released",
      errorCode: "generated_media_retry_exhausted",
    });
    expect(submissions).toBe(2);
    expect(usageEvents.at(-1)).toBe(`release:${job.id}`);
  });

  test("classifies a thrown safety refusal as rejected", async () => {
    const { module, usageEvents } = harness({
      provider: {
        async submit() {
          throw new GeneratedMediaProviderError("generated_media_safety_rejected");
        },
        async poll() {
          throw new Error("not reached");
        },
        async cancel() {
          return { kind: "cancelled" as const };
        },
        async result() {
          throw new Error("not reached");
        },
      },
    });
    const job = await module.create(scope, { ...request, idempotencyKey: "thrown-safety-refusal" });

    expect(await module.process(job.id)).toMatchObject({
      status: "rejected",
      moderationStatus: "rejected",
      usageStatus: "released",
    });
    expect(usageEvents.at(-1)).toBe(`release:${job.id}`);
  });

  test("releases a reservation when durable job admission fails", async () => {
    const store = createInMemoryGeneratedMediaStore();
    const { module, usageEvents } = harness({
      store: {
        ...store,
        async create() {
          throw new Error("database_unavailable");
        },
      },
    });

    await expect(module.create(scope, { ...request, idempotencyKey: "admission-failure" })).rejects.toThrow(
      "database_unavailable",
    );
    expect(usageEvents).toEqual([
      "reserve:00000000-0000-4000-8000-000000000001",
      "release:00000000-0000-4000-8000-000000000001",
    ]);
  });

  test("collapses a concurrent idempotent admission race and releases the losing reservation", async () => {
    const store = createInMemoryGeneratedMediaStore();
    const { module, usageEvents } = harness({
      store: {
        ...store,
        async create(record) {
          const existing = await store.findByIdempotency(record.scope.workspaceId, record.idempotencyKey);
          return existing ?? store.create(record);
        },
      },
    });
    const first = await module.create(scope, { ...request, idempotencyKey: "concurrent-admission" });
    const originalFind = store.findByIdempotency;
    let forceMiss = true;
    const racingStore: GeneratedMediaStore = {
      ...store,
      async findByIdempotency(workspaceId, key) {
        if (forceMiss) {
          forceMiss = false;
          return null;
        }
        return originalFind(workspaceId, key);
      },
      async create() {
        return (await originalFind(scope.workspaceId, "concurrent-admission"))!;
      },
    };
    const secondHarness = harness({
      store: racingStore,
      ids: () => "00000000-0000-4000-8000-000000000999",
    });
    const replay = await secondHarness.module.create(scope, { ...request, idempotencyKey: "concurrent-admission" });

    expect(replay.id).toBe(first.id);
    expect(replay.replayed).toBe(true);
    expect(secondHarness.usageEvents).toEqual([
      "reserve:00000000-0000-4000-8000-000000000999",
      "release:00000000-0000-4000-8000-000000000999",
    ]);
    expect(usageEvents).toHaveLength(1);
  });

  test("a stale worker cannot publish transitions after claim takeover", async () => {
    const store = createInMemoryGeneratedMediaStore();
    let jobId = "";
    const { module, usageEvents } = harness({
      store,
      provider: {
        async submit() {
          await store.update(jobId, {
            claimId: "00000000-0000-4000-8000-000000009999",
            claimExpiresAt: new Date("2026-09-01T00:10:00.000Z"),
          });
          return { kind: "completed", providerRef: "provider:new-owner", usage: { images: 1 } };
        },
        async poll() { return { kind: "failed", code: "not-used", retryable: false }; },
        async cancel() { return { kind: "cancelled" }; },
        async result() {
          return { contentType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) };
        },
      },
    });
    const job = await module.create(scope, { ...request, idempotencyKey: "stale-worker-takeover" });
    jobId = job.id;

    await expect(module.process(job.id)).rejects.toMatchObject({ code: "generated_media_claim_lost" });
    expect((await store.get(job.id))?.claimId).toBe("00000000-0000-4000-8000-000000009999");
    expect(usageEvents).toEqual([`reserve:${job.id}`]);
  });
});
