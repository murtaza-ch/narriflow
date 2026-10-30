import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import {
  RenderGroupAttemptLost,
  RenderGroupLifecycle,
  type RenderGroupAdmission,
} from "./render-group-lifecycle";
import {
  type ClaimedRenderGroupAttempt,
  type RenderGroupAttemptRef,
} from "./render-group-contract";
import { WorkflowAttemptLost, WorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { LayoutEvidenceLifecycle } from "./layout-evidence";

const url = process.env.WORKFLOW_TEST_DATABASE_URL;
const schema = process.env.WORKFLOW_TEST_DATABASE_SCHEMA;
const dbDescribe = process.env.ALLOW_WORKFLOW_DB_TESTS === "1" && url ? describe : describe.skip;
dbDescribe("Render Group PostgreSQL invariants", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  beforeAll(() => {
    if (
      !url ||
      !schema?.startsWith("workflow_lifecycle_test_") ||
      new URL(url).hostname !== "localhost"
    )
      throw new Error("Use db-gate.sh with a disposable workflow schema");
    pool = new Pool({ connectionString: url, max: 8 });
    prisma = new PrismaClient({
      adapter: new PrismaPg(pool, { schema }),
      transactionOptions: { maxWait: 30_000, timeout: 30_000 },
    });
  });
  beforeEach(async () => {
    await prisma.workspace.deleteMany({
      where: { owner: { clerkId: { startsWith: "group-db-test:" } } },
    });
    await prisma.user.deleteMany({ where: { clerkId: { startsWith: "group-db-test:" } } });
  });
  afterAll(async () => {
    if (prisma) {
      await prisma.workspace.deleteMany({
        where: { owner: { clerkId: { startsWith: "group-db-test:" } } },
      });
      await prisma.user.deleteMany({ where: { clerkId: { startsWith: "group-db-test:" } } });
    }
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function fixture(
    count = 2,
    aspects: Array<"ratio_9_16" | "ratio_1_1" | "ratio_16_9"> = ["ratio_9_16"],
    exported = false,
  ) {
    const user = await prisma.user.create({
      data: {
        clerkId: `group-db-test:${randomUUID()}`,
        primaryEmail: `${randomUUID()}@example.test`,
      },
    });
    const workspace = await prisma.workspace.create({
      data: {
        name: "Group tests",
        ownerUserId: user.id,
        personalOwnerUserId: user.id,
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    const project = await prisma.project.create({
      data: {
        title: "Groups",
        sourceMediaUrl: "r2://test/source",
        sourceStorageKey: "test/source",
        sourceDurationSeconds: 10,
        ingestStatus: "ready",
        workspaceId: workspace.id,
      },
    });
    const run = await prisma.workflowRun.create({
      data: {
        projectId: project.id,
        idempotencyKey: randomUUID(),
        stage: "clip_rendering",
        status: "queued",
      },
    });
    const admissions: RenderGroupAdmission[] = [];
    for (let index = 0; index < count; index++) {
      const clip = await prisma.clip.create({
        data: {
          projectId: project.id,
          workflowRunId: run.id,
          index,
          startSec: 0,
          endSec: 10,
          hookText: "test",
          reasoning: "test",
          category: "hook",
          transcriptSlice: [],
          viralityScore: 50,
          hookStrengthScore: 50,
          emotionalIntensityScore: 50,
          pacingScore: 50,
          durationOptimalityScore: 50,
          tiktokScore: 50,
          youtubeScore: 50,
          instagramScore: 50,
          llmProvider: "test",
          llmModel: "test",
          editorRevision: 1,
          previewStorageKey: `preview-${index}`,
          previewStartSec: 0,
          previewDurationSec: 10,
        },
      });
      const variants = [];
      for (const aspectRatio of aspects)
        variants.push(
          await prisma.clipRender.create({
            data: { clipId: clip.id, aspectRatio, resolution: "1080p" },
          }),
        );
      let exportId: string | null = null;
      if (exported) {
        const exp = await prisma.clipExport.create({
          data: {
            projectId: project.id,
            workspaceId: workspace.id,
            clipId: clip.id,
            editorRevision: 1,
            fingerprint: randomUUID(),
            resolution: "1080p",
            watermark: false,
          },
        });
        exportId = exp.id;
        for (const render of variants) {
          const v = await prisma.clipExportVariant.create({
            data: {
              exportId,
              aspectRatio: render.aspectRatio,
              resolution: "1080p",
              watermark: false,
            },
          });
          await prisma.clipRender.update({
            where: { id: render.id },
            data: { exportVariantId: v.id, editorRevision: 1, clipSnapshot: {} },
          });
        }
      }
      admissions.push({
        configuration: {
          clipId: clip.id,
          exportId,
          editorRevision: 1,
          resolution: "1080p",
          watermark: false,
        },
        variantIds: variants.map((v) => v.id),
      });
    }
    const coordinator = new WorkflowRunLifecycle({ prisma, leaseOwner: randomUUID() });
    const attempt = (await coordinator.claim("clip_rendering"))!;
    expect(attempt.workflowRunId).toBe(run.id);
    const refs = await coordinator.admitRenderGroups(attempt, admissions);
    const worker = new RenderGroupLifecycle({
      prisma,
      leaseOwner: randomUUID(),
      releaseGraceMs: 5_000,
    });
    return { project, run, admissions, coordinator, attempt, refs, worker };
  }
  async function start(worker: RenderGroupLifecycle, attempt: RenderGroupAttemptRef) {
    await worker.start({
      ...attempt,
      sourceFingerprint: "sha256:source",
      analysisFingerprint: null,
      toolchainFingerprint: "sha256:tools",
    });
  }
  async function finish(worker: RenderGroupLifecycle, attempt: RenderGroupAttemptRef) {
    return worker.finish({
      ...attempt,
      result: "completed",
      errorCode: null,
      failureDisposition: null,
    });
  }
  async function success(
    worker: RenderGroupLifecycle,
    attempt: ClaimedRenderGroupAttempt,
    captionDiagnostics?: { omittedCodePoints: string[]; skippedEmoji: string[] },
  ) {
    await start(worker, attempt);
    for (const id of attempt.memberIds) {
      expect(await worker.markClipRenderVariantRendering(attempt, id)).toBe(true);
      expect(await worker.markClipRenderVariantRendering(attempt, id)).toBe(true);
      expect(await prisma.workflowEvent.count({ where: { workflowRunId: attempt.workflowRunId, dedupeKey: `${attempt.workflowRunId}:${attempt.token}:variant_started:${id}` } })).toBe(1);
      expect(
        await worker.completeClipRenderVariant(attempt, id, {
          storageKey: `render/${attempt.token}/${id}`,
          sizeBytes: 100,
          durationSec: 10,
          captionDiagnostics,
        }),
      ).toBe(true);
    }
    await finish(worker, attempt);
  }
  async function expire(groupId: string) {
    await prisma.renderGroup.update({
      where: { id: groupId },
      data: { leaseExpiresAt: new Date(0) },
    });
  }
  async function due(groupId: string) {
    await prisma.renderGroup.update({
      where: { id: groupId },
      data: { nextAttemptAt: new Date(0) },
    });
  }

  test("atomic partition admission is idempotent and validates frozen identities", async () => {
    const f = await fixture(2, ["ratio_9_16", "ratio_1_1"]);
    expect(await f.coordinator.admitRenderGroups(f.attempt, f.admissions)).toEqual(f.refs);
    expect(await prisma.renderGroup.count()).toBe(2);
    expect(await prisma.renderGroupMember.count()).toBe(4);
    await expect(f.coordinator.admitRenderGroups(f.attempt, [f.admissions[0]!])).rejects.toThrow(
      "immutable",
    );
    await expect(
      f.coordinator.admitRenderGroups(
        f.attempt,
        f.admissions.map((a) => ({
          ...a,
          configuration: { ...a.configuration, resolution: "720p" },
        })),
      ),
    ).rejects.toThrow("immutable");
    expect("markClipRenderVariantRendering" in f.coordinator).toBe(false);
    expect("completeClipRenderVariant" in f.coordinator).toBe(false);
    expect("failClipRenderVariant" in f.coordinator).toBe(false);
  });

  test("a committed render keeps the caption characters it left out, and nothing when none", async () => {
    const f = await fixture(2, ["ratio_9_16", "ratio_1_1"]);
    await f.coordinator.admitRenderGroups(f.attempt, f.admissions);
    const diagnostics = { omittedCodePoints: ["U+2605"], skippedEmoji: [] as string[] };
    const withOmission = (await f.worker.claim())!;
    await success(f.worker, withOmission, diagnostics);
    const clean = (await f.worker.claim())!;
    await success(f.worker, clean);
    const rows = await prisma.clipRender.findMany({ where: { id: { in: [...withOmission.memberIds, ...clean.memberIds] } } });
    const byId = new Map(rows.map((row) => [row.id, row.captionDiagnostics]));
    for (const id of withOmission.memberIds) expect(byId.get(id)).toEqual(diagnostics);
    for (const id of clean.memberIds) expect(byId.get(id)).toBeNull();
  });

  test("generic parent completion cannot bypass live group settlement", async () => {
    const f = await fixture(1);
    const child = (await f.worker.claim())!;
    await expect(f.coordinator.completeStage(f.attempt)).rejects.toBeInstanceOf(
      WorkflowAttemptLost,
    );
    await f.worker.heartbeat(child);
    expect(await f.coordinator.settleRenderWorkSet(f.attempt)).toMatchObject({ status: "pending" });
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: f.run.id } })).status).toBe(
      "running",
    );
  });

  test("SIGKILL of a real lease-owning process preserves completion and charges only its interrupted group", async () => {
    const f = await fixture(1, ["ratio_9_16", "ratio_1_1"]);
    const child = Bun.spawn(["bun", "-e", `
      import { PrismaPg } from "@prisma/adapter-pg";
      import { PrismaClient } from "@prisma/client";
      import { Pool } from "pg";
      import { RenderGroupLifecycle } from "./src/render-group-lifecycle.ts";
      const pool = new Pool({ connectionString: process.env.WORKFLOW_TEST_DATABASE_URL, max: 2 });
      const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: process.env.WORKFLOW_TEST_DATABASE_SCHEMA }) });
      const lifecycle = new RenderGroupLifecycle({ prisma, leaseOwner: "sigkill-test-child" });
      const group = await lifecycle.claim({ groupId: process.env.NARRIFLOW_CRASH_GROUP_ID });
      if (!group) throw new Error("Crash fixture could not claim");
      await lifecycle.start({ ...group, sourceFingerprint: "crash-fixture", analysisFingerprint: null, toolchainFingerprint: "fixture" });
      await lifecycle.markClipRenderVariantRendering(group, group.memberIds[0]);
      await lifecycle.completeClipRenderVariant(group, group.memberIds[0], { storageKey: "test/sigkill-kept.mp4", sizeBytes: 100, durationSec: 10 });
      await lifecycle.markClipRenderVariantRendering(group, group.memberIds[1]);
      console.log("started");
      setInterval(() => {}, 1000);
    `], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, NARRIFLOW_CRASH_GROUP_ID: f.refs[0]!.groupId }, stdout: "pipe", stderr: "pipe" });
    let readinessTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reader = child.stdout.getReader();
      const first = await Promise.race([reader.read(), new Promise<never>((_, reject) => { readinessTimer = setTimeout(() => reject(new Error("Crash child readiness timed out")), 10_000); })]);
      if (first.done) throw new Error(`Crash child exited before start: ${await new Response(child.stderr).text()}`);
      expect(new TextDecoder().decode(first.value)).toContain("started");
      reader.releaseLock();
      child.kill("SIGKILL");
      expect(await child.exited).not.toBe(0);
      await expire(f.refs[0]!.groupId);
      expect(await f.worker.reapExpired()).toBe(1);
      const group = await prisma.renderGroup.findUniqueOrThrow({ where: { id: f.refs[0]!.groupId }, include: { executions: true } });
      expect(group).toMatchObject({ status: "queued", chargedAttemptCount: 1 });
      expect(group.executions).toHaveLength(1);
      expect(group.executions[0]).toMatchObject({ startedAt: expect.any(Date), result: "interrupted", charged: true });
      expect(await prisma.clipRender.findMany({ where: { workflowRunId: f.run.id }, select: { status: true, storageKey: true }, orderBy: { aspectRatio: "asc" } })).toEqual(expect.arrayContaining([{ status: "completed", storageKey: "test/sigkill-kept.mp4" }, { status: "pending", storageKey: null }]));
      await due(group.id);
      const successor = (await f.worker.claim({ groupId: group.id }))!;
      expect(successor.memberIds).toHaveLength(1);
      await success(f.worker, successor);
      expect(await f.coordinator.settleRenderWorkSet(f.attempt)).toMatchObject({ status: "completed", succeeded: 2 });
    } finally {
      clearTimeout(readinessTimer);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 20_000);

  test("two simultaneous replicas claim distinct groups and duplicate claim has one winner", async () => {
    const f = await fixture(4);
    const second = new RenderGroupLifecycle({ prisma, leaseOwner: "second" });
    const claims = await Promise.all([f.worker.claim(), second.claim()]);
    expect(claims.every(Boolean)).toBe(true);
    expect(new Set(claims.map((c) => c!.groupId)).size).toBe(2);
    const groupId = f.refs.find((r) => !claims.some((c) => c!.groupId === r.groupId))!.groupId;
    const same = await Promise.all([f.worker.claim({ groupId }), second.claim({ groupId })]);
    expect(same.filter(Boolean)).toHaveLength(1);
    expect(await prisma.renderGroupExecution.count()).toBe(3);
  });

  test("coordinator death and reclaim beyond three claims preserves live group token and variant state", async () => {
    const f = await fixture(1);
    const child = (await f.worker.claim())!;
    await start(f.worker, child);
    await f.worker.markClipRenderVariantRendering(child, child.memberIds[0]!);
    for (let n = 0; n < 4; n++) {
      await prisma.workflowRun.update({
        where: { id: f.run.id },
        data: { leaseExpiresAt: new Date(0) },
      });
      expect(await f.coordinator.reapExpiredAttempts()).toBe(1);
      expect(await f.coordinator.claim("clip_rendering")).not.toBeNull();
      await f.worker.heartbeat(child);
      expect(
        (await prisma.clipRender.findUniqueOrThrow({ where: { id: child.memberIds[0]! } })).status,
      ).toBe("rendering");
    }
    expect(
      await f.worker.completeClipRenderVariant(child, child.memberIds[0]!, {
        storageKey: "survived",
        sizeBytes: 3,
        durationSec: 10,
      }),
    ).toBe(true);
    await finish(f.worker, child);
    expect(
      (await prisma.renderGroup.findUniqueOrThrow({ where: { id: child.groupId } }))
        .chargedAttemptCount,
    ).toBe(1);
  });

  test("stale child lease, parent generation and invalidated membership reject every child writer", async () => {
    const f = await fixture(1);
    const child = (await f.worker.claim())!;
    const id = child.memberIds[0]!;
    const wrong = { ...child, workSetGeneration: randomUUID() };
    await expect(f.worker.markClipRenderVariantRendering(wrong, id)).rejects.toBeInstanceOf(
      RenderGroupAttemptLost,
    );
    await expect(
      f.worker.writeLayoutEvidence(wrong, {
        clipId: child.clipId,
        editorRevision: 1,
        previewStorageKey: "preview-0",
        field: "screen",
        evidence: {},
      }),
    ).rejects.toBeInstanceOf(RenderGroupAttemptLost);
    await expire(child.groupId);
    await expect(start(f.worker, child)).rejects.toBeInstanceOf(RenderGroupAttemptLost);
    await expect(f.worker.heartbeat(child)).rejects.toBeInstanceOf(RenderGroupAttemptLost);
    expect(await f.worker.reapExpired()).toBe(1);
    expect(await f.worker.reapExpired()).toBe(0);
    const replacement = (await f.worker.claim())!;
    await expect(
      f.worker.failClipRenderVariant(child, id, "stale", "permanent"),
    ).rejects.toBeInstanceOf(RenderGroupAttemptLost);
    expect(await f.worker.invalidateMembers(child, [id])).toBe(1);
    expect(await f.worker.invalidateMembers(child, [id])).toBe(0);
    await expect(f.worker.markClipRenderVariantRendering(replacement, id)).rejects.toBeInstanceOf(
      RenderGroupAttemptLost,
    );
    expect((await finish(f.worker, replacement))?.status).toBe("superseded");
    const outcome = await f.coordinator.settleRenderWorkSet(f.attempt);
    expect(outcome).toMatchObject({ status: "completed", superseded: 1, succeeded: 0, failed: 0 });
    expect(
      await prisma.workflowEvent.count({
        where: { workflowRunId: f.run.id, notificationRequired: true },
      }),
    ).toBe(0);
  });

  test("poison group exhausts only its charged starts while healthy siblings finish", async () => {
    const f = await fixture(2);
    const poison = (await f.worker.claim({ groupId: f.refs[0]!.groupId }))!;
    const healthy = (await f.worker.claim({ groupId: f.refs[1]!.groupId }))!;
    await success(f.worker, healthy);
    let current = poison;
    for (let n = 1; n <= 3; n++) {
      await start(f.worker, current);
      await start(f.worker, current);
      await f.worker.markClipRenderVariantRendering(current, current.memberIds[0]!);
      await expire(current.groupId);
      expect(await f.worker.reapExpired()).toBe(1);
      const row = await prisma.renderGroup.findUniqueOrThrow({ where: { id: current.groupId } });
      expect(row.chargedAttemptCount).toBe(n);
      if (n < 3) {
        expect(row.status).toBe("queued");
        const ledger = await prisma.renderGroupExecution.findUniqueOrThrow({
          where: { token: current.token },
        });
        expect(row.nextAttemptAt!.getTime() - ledger.finishedAt!.getTime()).toBe(
          n === 1 ? 30_000 : 60_000,
        );
        expect(await f.coordinator.settleRenderWorkSet(f.attempt)).toMatchObject({
          status: "pending",
        });
        expect(await prisma.workflowEvent.count({ where: { notificationRequired: true } })).toBe(0);
        expect(await f.worker.claim({ groupId: current.groupId })).toBeNull();
        await due(current.groupId);
        current = (await f.worker.claim({ groupId: current.groupId }))!;
      } else expect(row.status).toBe("failed");
    }
    expect(
      await prisma.renderGroupExecution.count({
        where: { groupId: poison.groupId, charged: true },
      }),
    ).toBe(3);
    const results = await Promise.all([
      f.coordinator.settleRenderWorkSet(f.attempt),
      f.coordinator.settleRenderWorkSet(f.attempt),
    ]);
    expect(results[0]).toMatchObject({ status: "partial", requested: 2, succeeded: 1, failed: 1 });
    expect(results[1]).toEqual(results[0]);
    expect(
      await prisma.workflowEvent.count({
        where: { workflowRunId: f.run.id, notificationRequired: true },
      }),
    ).toBe(1);
  });

  test("pre-start expiry/rejection and graceful shutdown refund once with drain deferral", async () => {
    const f = await fixture(1);
    let child = (await f.worker.claim())!;
    await expire(child.groupId);
    await f.worker.reapExpired();
    expect(
      (await prisma.renderGroup.findUniqueOrThrow({ where: { id: child.groupId } }))
        .chargedAttemptCount,
    ).toBe(0);
    child = (await f.worker.claim())!;
    expect(await f.worker.release({ ...child, reason: "pre_start_rejection" })).toBe(true);
    expect(await f.worker.release({ ...child, reason: "pre_start_rejection" })).toBe(true);
    child = (await f.worker.claim())!;
    await start(f.worker, child);
    await f.worker.markClipRenderVariantRendering(child, child.memberIds[0]!);
    expect(await f.worker.release({ ...child, reason: "shutdown" })).toBe(true);
    expect(await f.worker.release({ ...child, reason: "shutdown" })).toBe(true);
    const row = await prisma.renderGroup.findUniqueOrThrow({ where: { id: child.groupId } });
    const ledger = await prisma.renderGroupExecution.findUniqueOrThrow({
      where: { token: child.token },
    });
    expect(row.chargedAttemptCount).toBe(0);
    expect(ledger.charged).toBe(false);
    expect(row.nextAttemptAt!.getTime() - ledger.finishedAt!.getTime()).toBe(5_000);
    expect(await f.worker.claim()).toBeNull();
    expect(
      (await prisma.clipRender.findUniqueOrThrow({ where: { id: child.memberIds[0]! } })).status,
    ).toBe("pending");
  });

  test("mixed siblings retain success/permanent outcomes and retry only transient member", async () => {
    const f = await fixture(1, ["ratio_9_16", "ratio_1_1", "ratio_16_9"], true);
    const child = (await f.worker.claim())!;
    await start(f.worker, child);
    const [good, bad, transient] = child.memberIds as [string, string, string];
    for (const id of child.memberIds) await f.worker.markClipRenderVariantRendering(child, id);
    await f.worker.completeClipRenderVariant(child, good, {
      storageKey: "preserved",
      sizeBytes: 10,
      durationSec: 10,
    });
    await f.worker.failClipRenderVariant(child, bad, "corrupt", "permanent");
    await f.worker.failClipRenderVariant(child, transient, "unavailable", "retryable");
    expect((await finish(f.worker, child))?.retryVariantIds).toEqual([transient]);
    expect(
      (
        await prisma.clipExport.findUniqueOrThrow({
          where: { id: f.admissions[0]!.configuration.exportId! },
        })
      ).status,
    ).toBe("rendering");
    expect((await prisma.clipRender.findUniqueOrThrow({ where: { id: good } })).storageKey).toBe(
      "preserved",
    );
    await due(child.groupId);
    const retry = (await f.worker.claim())!;
    expect(retry.memberIds).toEqual([transient]);
    await success(f.worker, retry);
    expect(await f.coordinator.settleRenderWorkSet(f.attempt)).toMatchObject({
      status: "partial",
      succeeded: 2,
      failed: 1,
    });
    expect(
      (
        await prisma.clipExport.findUniqueOrThrow({
          where: { id: f.admissions[0]!.configuration.exportId! },
        })
      ).status,
    ).toBe("partial_ready");
    expect(await prisma.renderGroupVariantOutcome.count({ where: { token: retry.token } })).toBe(1);
  });

  test("duplicate completion reconciles committed bytes after token expiry and parent terminal settlement", async () => {
    const f = await fixture(1);
    const child = (await f.worker.claim())!;
    await success(f.worker, child);
    await f.coordinator.settleRenderWorkSet(f.attempt);
    const id = child.memberIds[0]!;
    expect(
      await f.worker.completeClipRenderVariant(child, id, {
        storageKey: `render/${child.token}/${id}`,
        sizeBytes: 100,
        durationSec: 10,
      }),
    ).toBe(true);
    expect(
      await f.worker.completeClipRenderVariant(child, id, {
        storageKey: "different",
        sizeBytes: 100,
        durationSec: 10,
      }),
    ).toBe(false);
    expect((await f.worker.readVariantOutcome(child, id))?.result).toBe("completed");
    expect(await prisma.renderGroupVariantOutcome.count({ where: { token: child.token } })).toBe(1);
  });

  test("a lost commit acknowledgement retains a queryable durable completion", async () => {
    const f = await fixture(1);
    const child = (await f.worker.claim())!;
    await start(f.worker, child);
    const id = child.memberIds[0]!;
    await f.worker.markClipRenderVariantRendering(child, id);
    let loseAcknowledgement = true;
    const ambiguous = new Proxy(prisma, {
      get(target, key) {
        if (key === "$transaction")
          return async (operation: Parameters<PrismaClient["$transaction"]>[0]) => {
            const result = await target.$transaction(operation);
            if (loseAcknowledgement) {
              loseAcknowledgement = false;
              throw new Error("commit acknowledgement lost");
            }
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const worker = new RenderGroupLifecycle({ prisma: ambiguous });
    const artifact = { storageKey: "committed-despite-lost-ack", sizeBytes: 100, durationSec: 10 };
    await expect(worker.completeClipRenderVariant(child, id, artifact)).rejects.toThrow(
      "acknowledgement lost",
    );
    expect((await worker.readVariantOutcome(child, id))?.result).toBe("completed");
    expect(await worker.completeClipRenderVariant(child, id, artifact)).toBe(true);
    await finish(worker, child);
    expect((await worker.readExecution(child))?.result).toBe("completed");
    expect(await f.coordinator.settleRenderWorkSet(f.attempt)).toMatchObject({
      status: "completed",
      succeeded: 1,
    });
  });

  test("late variants enter exactly one follow-up under duplicate terminal settlement", async () => {
    const f = await fixture(1);
    const child = (await f.worker.claim())!;
    const late = await prisma.clipRender.create({
      data: { clipId: child.clipId, aspectRatio: "ratio_1_1", resolution: "1080p" },
    });
    await success(f.worker, child);
    const outcomes = await Promise.all([
      f.coordinator.settleRenderWorkSet(f.attempt),
      f.coordinator.settleRenderWorkSet(f.attempt),
    ]);
    expect(outcomes[0]!.followUpWorkflowRunId).toBeTruthy();
    expect(outcomes[1]!.followUpWorkflowRunId).toBe(outcomes[0]!.followUpWorkflowRunId);
    const next = (await f.coordinator.claim("clip_rendering"))!;
    expect(next.workflowRunId).toBe(outcomes[0]!.followUpWorkflowRunId!);
    const refs = await f.coordinator.admitRenderGroups(next, [
      { configuration: f.admissions[0]!.configuration, variantIds: [late.id] },
    ]);
    const follow = (await f.worker.claim({ groupId: refs[0]!.groupId }))!;
    await success(f.worker, follow);
    expect(await f.coordinator.settleRenderWorkSet(next)).toMatchObject({
      status: "completed",
      requested: 1,
    });
  });

  test("background layout defers live rendering and resumes after its lease ends", async () => {
    const f = await fixture(1);
    const child = (await f.worker.claim())!;
    const evidence = new LayoutEvidenceLifecycle({ prisma });
    expect(await evidence.claimAutomatic(60_000)).toBeNull();
    expect(
      (await prisma.clip.findUniqueOrThrow({ where: { id: child.clipId } })).autoLayoutAttemptCount,
    ).toBe(0);
    await f.worker.release({ ...child, reason: "pre_start_rejection" });
    expect((await evidence.claimAutomatic(60_000))?.id).toBe(child.clipId);
  });

  test("cancelling queued coordination closes group leases and invalidates current membership", async () => {
    const f = await fixture(1);
    const child = (await f.worker.claim())!;
    await start(f.worker, child);
    await f.coordinator.releaseAttempt(f.attempt);
    expect(
      await f.coordinator.cancelQueuedProjectRuns({
        projectId: f.project.id,
        errorCode: "cancelled",
      }),
    ).toBe(1);
    await expect(f.worker.heartbeat(child)).rejects.toBeInstanceOf(RenderGroupAttemptLost);
    expect(
      (await prisma.renderGroup.findUniqueOrThrow({ where: { id: child.groupId } })).status,
    ).toBe("superseded");
    expect(
      (await prisma.renderGroupExecution.findUniqueOrThrow({ where: { token: child.token } }))
        .result,
    ).toBe("superseded");
    expect(await f.worker.claim()).toBeNull();
  });

  test("DB time after a parent lock wait rejects an expired heartbeat", async () => {
    const f = await fixture(1);
    const child = (await f.worker.claim())!;
    let locked!: () => void;
    let unlock!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const lock = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "WorkflowRun" WHERE "id" = ${f.run.id}::uuid FOR UPDATE`;
      locked();
      await hold;
      await tx.renderGroup.update({
        where: { id: child.groupId },
        data: { leaseExpiresAt: new Date(0) },
      });
    });
    await ready;
    const heartbeat = f.worker.heartbeat(child).catch((error: unknown) => error);
    unlock();
    await lock;
    expect(await heartbeat).toBeInstanceOf(RenderGroupAttemptLost);
  });

  test("deleted automatic members become superseded without stranding healthy membership", async () => {
    const f = await fixture(2);
    await prisma.clipRender.delete({ where: { id: f.admissions[0]!.variantIds[0]! } });
    expect(await f.worker.claim({ groupId: f.refs[0]!.groupId })).toBeNull();
    const child = (await f.worker.claim())!;
    await success(f.worker, child);
    expect(await f.coordinator.settleRenderWorkSet(f.attempt)).toMatchObject({
      status: "completed",
      requested: 2,
      succeeded: 1,
      superseded: 1,
    });
  });
});
