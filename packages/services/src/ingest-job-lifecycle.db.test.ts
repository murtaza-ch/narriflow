import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@prisma/client";
import { Pool } from "pg";
import {
  IngestJobClaimLost,
  IngestJobLifecycle,
  IngestNotFailedError,
  IngestRetryLimitExceededError,
  type IngestJobLifecycleDependencies,
} from "./ingest-job-lifecycle";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { autoTriggerIdempotencyKey } from "./generation-sequencing";
import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";

const url = process.env.WORKFLOW_TEST_DATABASE_URL;
const schema = process.env.WORKFLOW_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_WORKFLOW_DB_TESTS === "1" && Boolean(url);
const dbDescribe = enabled ? describe : describe.skip;

setDefaultTimeout(180_000);

dbDescribe("Ingest Job lifecycle PostgreSQL interface", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let clock = Date.now();
  const users: string[] = [];
  beforeAll(() => {
    if (!schema?.startsWith("workflow_lifecycle_test_"))
      throw new Error("Ingest tests require a disposable schema");
    pool = new Pool({ connectionString: url, max: 4 });
    prisma = new PrismaClient({
      adapter: new PrismaPg(pool, { schema }),
      transactionOptions: { timeout: 30_000 },
    });
  });
  afterEach(async () => {
    const userIds = users.splice(0);
    await prisma.workspace.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
  function lifecycle(overrides: Partial<IngestJobLifecycleDependencies> = {}) {
    return new IngestJobLifecycle({
      prisma,
      workflow: new WorkflowRunLifecycle({ prisma }),
      now: () => new Date(clock),
      requireRetryActor: async () => {},
      assertGenerationAllowed: async () => {},
      sourceBucket: "ingest-test",
      ...overrides,
    });
  }
  async function fixture(
    status: "queued" | "ready" | "failed" = "queued",
    payload = {},
  ) {
    clock = Date.now();
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: {
        clerkId: `ingest-db:${suffix}`,
        primaryEmail: `ingest-${suffix}@example.test`,
      },
    });
    users.push(user.id);
    const workspace = await prisma.workspace.create({
      data: {
        name: "Ingest lifecycle",
        ownerUserId: user.id,
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    const project = await prisma.project.create({
      data: {
        title: "Ingest",
        sourceMediaUrl: "r2://pending",
        workspaceId: workspace.id,
        createdByUserId: user.id,
        ingestStatus: status,
      },
    });
    const job = await prisma.ingestJob.create({
      data: {
        projectId: project.id,
        jobType: "link_import",
        payload,
        status:
          status === "ready"
            ? "completed"
            : status === "failed"
              ? "failed"
              : "queued",
        completedAt: status === "ready" ? new Date(clock) : null,
      },
    });
    return { project, job, user, workspace };
  }
  async function committedPack(projectId: string) {
    return prisma.contentPack.create({
      data: {
        projectId,
        outputTypes: ["short_clip"],
        clipGenerationMode: "viral_moments",
        clipCountTarget: 10,
        clipDurationSecTarget: 45,
        platformTargets: ["tiktok"],
        toneConstraints: [],
        captionPreset: "brand_default",
        platformPlaybookVersion: "2026-07-01",
      },
    });
  }
  function transactionFault(
    method: "create" | "updateMany",
    table: "ingestJob" | "workflowEvent",
    condition?: (args: unknown) => boolean,
  ): PrismaClient {
    return new Proxy(prisma, {
      get(target, property) {
        if (property !== "$transaction") return Reflect.get(target, property);
        return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction((tx) =>
            work(
              new Proxy(tx, {
                get(inner, field) {
                  if (field !== table) return Reflect.get(inner, field);
                  return new Proxy(Reflect.get(inner, field), {
                    get(model, name) {
                      if (name !== method) return Reflect.get(model, name);
                      return (args: unknown) => {
                        if (!condition || condition(args))
                          throw new Error("injected persistence failure");
                        return Reflect.get(model, name).call(model, args);
                      };
                    },
                  });
                },
              }),
            ),
          );
      },
    }) as PrismaClient;
  }

  test("every stale claim command rejects without changing Project or events", async () => {
    const { project, job } = await fixture();
    const module = lifecycle();
    const claim = (await module.claim())!;
    expect(claim.id).toBe(job.id);
    await prisma.ingestJob.update({
      where: { id: claim.id },
      data: { claimId: randomUUID() },
    });
    await expect(module.renew(claim)).rejects.toBeInstanceOf(
      IngestJobClaimLost,
    );
    await expect(module.progress(claim, "downloading")).rejects.toBeInstanceOf(
      IngestJobClaimLost,
    );
    await expect(
      module.fail(claim, "worker_unhandled_error", "stale"),
    ).rejects.toBeInstanceOf(IngestJobClaimLost);
    await expect(
      module.complete(claim, { sourceStorageKey: "new.mp4" }),
    ).rejects.toBeInstanceOf(IngestJobClaimLost);
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } }))
        .ingestStatus,
    ).toBe("queued");
    expect(
      await prisma.workflowEvent.count({ where: { projectId: project.id } }),
    ).toBe(0);
  });
  test("expired unreaped claims cannot report progress or settle", async () => {
    await fixture();
    const module = lifecycle();
    const claim = (await module.claim())!;
    clock += 10 * 60_000;
    await expect(module.renew(claim)).rejects.toBeInstanceOf(
      IngestJobClaimLost,
    );
    await expect(module.progress(claim, "normalizing")).rejects.toBeInstanceOf(
      IngestJobClaimLost,
    );
    await expect(
      module.fail(claim, "remote_url_unsafe", "expired"),
    ).rejects.toBeInstanceOf(IngestJobClaimLost);
    await expect(
      module.complete(claim, { sourceStorageKey: "new.mp4" }),
    ).rejects.toBeInstanceOf(IngestJobClaimLost);
  });
  test("transient failure requeues with backoff; permanent failure stores notification intent", async () => {
    const { project, job } = await fixture();
    const module = lifecycle();
    const first = (await module.claim())!;
    expect(await module.fail(first, "remote_fetch_timeout", "timeout")).toEqual(
      { outcome: "requeue" },
    );
    expect(await module.claim()).toBeNull();
    clock += 30_001;
    const second = (await module.claim())!;
    expect(second.id).toBe(job.id);
    expect(second.attemptCount).toBe(2);
    expect(await module.fail(second, "remote_url_unsafe", "unsafe")).toEqual({
      outcome: "permanent",
      terminalErrorCode: "remote_url_unsafe",
    });
    const event = await prisma.workflowEvent.findFirstOrThrow({
      where: { projectId: project.id, status: "failed" },
    });
    expect(event.notificationRequired).toBe(true);
    expect(event.workflowRunId).toBeNull();
    expect(event.ingestJobId).toBe(job.id);
    expect(event.payload).toMatchObject({
      ingestJobId: job.id,
      notification: { kind: "ingest.failed", ingestJobId: job.id },
    });
    const notifications: unknown[] = [];
    const dispatcher = new WorkflowRunLifecycle({
      prisma,
      handoffNotification: async (payload) => {
        notifications.push(payload);
      },
    });
    await prisma.workflowEvent.update({
      where: { id: event.id },
      data: { nextDeliveryAt: new Date(Date.now() - 1) },
    });
    await dispatcher.dispatchEvents();
    await dispatcher.dispatchEvents();
    expect(notifications).toEqual([
      { kind: "ingest.failed", projectId: project.id, ingestJobId: job.id },
    ]);
    expect(
      (
        await prisma.workflowEvent.findUniqueOrThrow({
          where: { id: event.id },
        })
      ).notificationDeliveredAt,
    ).not.toBeNull();
  });
  test("outbox insertion failure rolls back source acceptance and progress", async () => {
    const { project, job } = await fixture();
    const normal = lifecycle();
    const claim = (await normal.claim())!;
    const broken = lifecycle({
      prisma: transactionFault("create", "workflowEvent"),
    });
    await expect(broken.progress(claim, "normalizing")).rejects.toThrow(
      "injected",
    );
    await expect(
      broken.complete(claim, { sourceStorageKey: "new.mp4" }),
    ).rejects.toThrow("injected");
    await expect(
      broken.fail(claim, "remote_url_unsafe", "unsafe"),
    ).rejects.toThrow("injected");
    clock += 10 * 60_000;
    await expect(broken.reapExpired()).rejects.toThrow("injected");
    expect(
      (await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } }))
        .status,
    ).toBe("running");
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } }))
        .sourceStorageKey,
    ).toBeNull();
  });
  test("source acceptance keeps the storage URI and pending handoff durable", async () => {
    const { project, job } = await fixture();
    const module = lifecycle();
    const claim = (await module.claim())!;
    await module.complete(claim, {
      sourceStorageKey: "projects/source.mp4",
      sourceSizeBytes: 42,
    });
    const accepted = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
    });
    expect(accepted.sourceMediaUrl).toBe(
      "r2://ingest-test/projects/source.mp4",
    );
    expect(accepted.sourceSizeBytes).toBe(42n);
    expect(accepted.ingestStatus).toBe("ready");
    expect(
      (await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } }))
        .generationHandoffAt,
    ).toBeNull();
    expect(
      (
        await prisma.workflowEvent.findFirstOrThrow({
          where: { ingestJobId: job.id },
        })
      ).stage,
    ).toBe("ingest_ready");
  });
  test("manual retry rolls back queued Project if job insertion fails", async () => {
    const { project, workspace, user } = await fixture("failed");
    const module = lifecycle({
      prisma: transactionFault("create", "ingestJob"),
    });
    await expect(
      module.retry({
        projectId: project.id,
        workspaceId: workspace.id,
        actorUserId: user.id,
      }),
    ).rejects.toThrow("injected");
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } }))
        .ingestStatus,
    ).toBe("failed");
    expect(
      await prisma.ingestJob.count({ where: { projectId: project.id } }),
    ).toBe(1);
    expect(
      await prisma.workflowEvent.count({ where: { projectId: project.id } }),
    ).toBe(0);
  });
  test("concurrent manual retries create one fresh job, with a separate manual budget", async () => {
    const { project, job, workspace, user } = await fixture("failed");
    await prisma.ingestJob.update({
      where: { id: job.id },
      data: { attemptCount: 3 },
    });
    const module = lifecycle();
    const input = {
      projectId: project.id,
      workspaceId: workspace.id,
      actorUserId: user.id,
    };
    const results = await Promise.allSettled([
      module.retry(input),
      module.retry(input),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (
        results.find(
          (result) => result.status === "rejected",
        ) as PromiseRejectedResult
      ).reason,
    ).toBeInstanceOf(IngestNotFailedError);
    expect(
      await prisma.ingestJob.count({ where: { projectId: project.id } }),
    ).toBe(2);
    for (let used = 2; used < 5; used++) {
      await prisma.project.update({
        where: { id: project.id },
        data: { ingestStatus: "failed" },
      });
      expect((await module.retry(input)).attemptsUsed).toBe(used + 1);
    }
    await prisma.project.update({
      where: { id: project.id },
      data: { ingestStatus: "failed" },
    });
    await expect(module.retry(input)).rejects.toBeInstanceOf(
      IngestRetryLimitExceededError,
    );
  });
  test("reaper preserves renewed leases, retries expired claims, then fails with durable intent at cap", async () => {
    const { project, job } = await fixture();
    const module = lifecycle();
    const first = (await module.claim())!;
    clock += 9 * 60_000;
    await module.renew(first);
    clock += 2 * 60_000;
    expect(await module.reapExpired()).toBe(0);
    clock += 9 * 60_000;
    expect(await module.reapExpired()).toBe(1);
    await expect(
      module.fail(first, "worker_unhandled_error", "late"),
    ).rejects.toBeInstanceOf(IngestJobClaimLost);
    clock += 30_001;
    const second = (await module.claim())!;
    clock += 10 * 60_000;
    expect(await module.reapExpired()).toBe(1);
    clock += 60_001;
    const third = (await module.claim())!;
    expect(second.attemptCount).toBe(2);
    expect(third.attemptCount).toBe(3);
    clock += 10 * 60_000;
    expect(await module.reapExpired()).toBe(1);
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } }))
        .ingestErrorCode,
    ).toBe("ingest_retries_exhausted");
    expect(
      await prisma.workflowEvent.count({
        where: { ingestJobId: job.id, notificationRequired: true },
      }),
    ).toBe(1);
  });
  test("repeated graceful deploy releases do not consume automatic retries", async () => {
    const { job } = await fixture();
    const module = lifecycle();
    for (let deploy = 0; deploy < 6; deploy++) {
      const claim = (await module.claim())!;
      expect(claim.attemptCount).toBe(1);
      await module.progress(claim, "downloading");
      await module.release(claim);
    }
    const row = await prisma.ingestJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(row.status).toBe("queued");
    expect(row.attemptCount).toBe(0);
  });
  test("an admitted ingest handoff survives creator removal without impersonating the Workspace owner", async () => {
    const { project, job, workspace } = await fixture("ready");
    const creator = await prisma.user.create({ data: { clerkId: `ingest-creator:${randomUUID()}` } });
    users.push(creator.id);
    await prisma.project.update({ where: { id: project.id }, data: { createdByUserId: creator.id } });
    await committedPack(project.id);
    await prisma.user.delete({ where: { id: creator.id } });
    const admittedScopes: unknown[][] = [];
    const module = lifecycle({
      assertGenerationAllowed: async (...args) => { admittedScopes.push(args); },
    });
    expect(await module.processGenerationHandoffs(1, job.id)).toBe(1);
    expect(admittedScopes).toEqual([[project.id, workspace.id]]);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).createdByUserId).toBeNull();
    expect(await prisma.workflowRun.count({ where: { projectId: project.id, stage: "stt" } })).toBe(1);
  });
  test("permanent handoff rejection atomically fails Project/job and leaves actionable notification", async () => {
    const { project, job } = await fixture("ready");
    await committedPack(project.id);
    const module = lifecycle({
      assertGenerationAllowed: async () => {
        throw new ExpectedDomainFailureError({
          code: "upload_too_long",
          kind: "payment_required",
          message: "Source exceeds this plan's upload length",
        });
      },
    });
    expect(await module.processGenerationHandoffs(1, job.id)).toBe(0);
    const row = await prisma.ingestJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(row.status).toBe("failed");
    expect(row.generationHandoffAt).not.toBeNull();
    expect(row.generationHandoffRetryAt).toBeNull();
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } }))
        .ingestErrorCode,
    ).toBe("upload_too_long");
    expect(
      await prisma.workflowEvent.count({
        where: { ingestJobId: job.id, notificationRequired: true },
      }),
    ).toBe(1);
    expect(await module.processGenerationHandoffs(1, job.id)).toBe(0);
  });
  test("handoff retry is durable, fair to due retries and exactly-once at admission", async () => {
    const { project, job } = await fixture("ready");
    const pack = await committedPack(project.id);
    let calls = 0;
    const module = lifecycle({
      assertGenerationAllowed: async () => {
        if (++calls === 1) throw new Error("temporary admission outage");
      },
    });
    await module.processGenerationHandoffs(1, job.id);
    expect(
      (await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } }))
        .generationHandoffRetryAt,
    ).not.toBeNull();
    clock += 60_001;
    const newProject = await prisma.project.create({
      data: {
        title: "New draft",
        workspaceId: project.workspaceId,
        sourceMediaUrl: "r2://pending",
        ingestStatus: "ready",
      },
    });
    await prisma.ingestJob.create({
      data: {
        projectId: newProject.id,
        jobType: "link_import",
        payload: {},
        status: "completed",
        completedAt: new Date(clock),
      },
    });
    expect(await module.processGenerationHandoffs(1)).toBe(1);
    expect(
      (await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } }))
        .generationHandoffAt,
    ).not.toBeNull();
    expect(
      await prisma.workflowRun.count({
        where: {
          projectId: project.id,
          idempotencyKey: autoTriggerIdempotencyKey(project.id, pack.id),
        },
      }),
    ).toBe(1);
    expect(
      (
        await prisma.transcript.findUniqueOrThrow({
          where: { projectId: project.id },
        })
      ).status,
    ).toBe("queued");
    expect(await module.processGenerationHandoffs(1, job.id)).toBe(0);
  });
  test("a manually admitted same-pack run acknowledges handoff after its stage advances", async () => {
    const { project, job } = await fixture("ready");
    const pack = await committedPack(project.id);
    const workflow = new WorkflowRunLifecycle({ prisma });
    const manual = await workflow.admitTranscript({
      projectId: project.id,
      idempotencyKey: `manual:${randomUUID()}`,
      contentPackId: pack.id,
      transcriptProvider: "assemblyai",
      transcriptProviderModel: "test",
    });
    await prisma.workflowRun.update({
      where: { id: manual.id },
      data: { status: "completed" },
    });
    const module = lifecycle({
      assertGenerationAllowed: async () => {
        throw new Error("existing admission should skip quota");
      },
    });
    expect(await module.processGenerationHandoffs(1, job.id)).toBe(1);
    expect(
      await prisma.workflowRun.count({
        where: { projectId: project.id, stage: "stt" },
      }),
    ).toBe(1);
    expect(
      (await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } }))
        .generationHandoffAt,
    ).not.toBeNull();
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } }))
        .ingestStatus,
    ).toBe("ready");
  });
  test("a same-pack admission during quota assertion wins over the stale permanent error", async () => {
    const { project, job } = await fixture("ready");
    const pack = await committedPack(project.id);
    const workflow = new WorkflowRunLifecycle({ prisma });
    const module = lifecycle({
      assertGenerationAllowed: async () => {
        await workflow.admitTranscript({
          projectId: project.id,
          idempotencyKey: `manual:${randomUUID()}`,
          contentPackId: pack.id,
          transcriptProvider: "assemblyai",
          transcriptProviderModel: "test",
        });
        throw new ExpectedDomainFailureError({
          code: "quota_exceeded",
          kind: "payment_required",
          message: "quota changed after admission",
        });
      },
    });
    expect(await module.processGenerationHandoffs(1, job.id)).toBe(1);
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } }))
        .ingestStatus,
    ).toBe("ready");
    expect(
      (await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } }))
        .status,
    ).toBe("completed");
    expect(
      await prisma.workflowEvent.count({
        where: { projectId: project.id, notificationRequired: true },
      }),
    ).toBe(0);
  });
  test("a manual stage completing during admission rolls back the extra automatic run", async () => {
    const { project, job } = await fixture("ready");
    const pack = await committedPack(project.id);
    const workflow = new WorkflowRunLifecycle({ prisma });
    const module = lifecycle({
      assertGenerationAllowed: async () => {
        const run = await workflow.admitTranscript({
          projectId: project.id,
          idempotencyKey: `manual:${randomUUID()}`,
          contentPackId: pack.id,
          transcriptProvider: "assemblyai",
          transcriptProviderModel: "test",
        });
        await prisma.workflowRun.update({
          where: { id: run.id },
          data: { status: "completed" },
        });
      },
    });
    expect(await module.processGenerationHandoffs(1, job.id)).toBe(1);
    expect(
      await prisma.workflowRun.count({
        where: { projectId: project.id, stage: "stt" },
      }),
    ).toBe(1);
    expect(
      await prisma.workflowEvent.count({ where: { projectId: project.id } }),
    ).toBe(1);
    expect(
      (await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } }))
        .generationHandoffAt,
    ).not.toBeNull();
  });
  test("lost handoff guard rolls back its newly admitted run and outbox", async () => {
    const { project, job } = await fixture("ready");
    await committedPack(project.id);
    const module = lifecycle({
      assertGenerationAllowed: async () => {
        await prisma.ingestJob.update({
          where: { id: job.id },
          data: { generationHandoffAt: new Date(clock) },
        });
      },
    });
    expect(await module.processGenerationHandoffs(1, job.id)).toBe(0);
    expect(
      await prisma.workflowRun.count({ where: { projectId: project.id } }),
    ).toBe(0);
    expect(
      await prisma.workflowEvent.count({ where: { projectId: project.id } }),
    ).toBe(0);
    expect(
      await prisma.transcript.count({ where: { projectId: project.id } }),
    ).toBe(0);
  });
  test("unavailable YouTube skips its current link payload while other intake claims", async () => {
    const { project, job } = await fixture("queued", {
      provider: "youtube",
      url: "https://youtube.test/a",
    });
    const direct = await prisma.ingestJob.create({
      data: {
        projectId: project.id,
        jobType: "link_import",
        payload: { provider: "dropbox", url: "https://dropbox.test/b" },
      },
    });
    expect((await lifecycle().claim({ youtubeAvailable: false }))?.id).toBe(
      direct.id,
    );
    const youtube = await prisma.ingestJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(youtube.status).toBe("queued");
    expect(youtube.attemptCount).toBe(0);
  });
});
