/**
 * Several worker replicas against one project on a disposable PostgreSQL
 * schema: real fenced group leases (`RenderGroupLifecycle`), the real parent
 * coordinator (`WorkflowRunLifecycle`) and the real executor loop. Only the
 * encode is simulated, so the assertions are about claiming, accounting and
 * settlement. Run through `.scratch/api-extraction/db-gate.sh bun run test:workflow:db`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { clipService } from "./clip.service";
import {
	RenderGroupLifecycle,
} from "./render-group-lifecycle";
import type { ClaimedRenderGroupAttempt } from "./render-group-contract";
import { WorkflowRunLifecycle, type ClaimedWorkflowAttempt } from "./workflow-run-lifecycle";
import { coordinateRenderWorkSet, executeNextRenderGroup } from "../../../apps/worker/src/render-group-executor";

const url = process.env.WORKFLOW_TEST_DATABASE_URL;
const schema = process.env.WORKFLOW_TEST_DATABASE_SCHEMA;
const dbDescribe = process.env.ALLOW_WORKFLOW_DB_TESTS === "1" && url ? describe : describe.skip;

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});

dbDescribe("Render group replicas (PostgreSQL)", () => {
	let prisma: PrismaClient;
	let pool: Pool;

	beforeAll(() => {
		if (!url || !schema?.startsWith("workflow_lifecycle_test_") || new URL(url).hostname !== "localhost")
			throw new Error("Use db-gate.sh with a disposable workflow schema");
		pool = new Pool({ connectionString: url, max: 20 });
		prisma = new PrismaClient({
			adapter: new PrismaPg(pool, { schema }),
			transactionOptions: { maxWait: 30_000, timeout: 30_000 },
		});
		// clipService reads through the process-wide client; point it at this schema.
		(globalThis as { narriflowPrismaClient?: PrismaClient }).narriflowPrismaClient = prisma;
	});
	afterAll(async () => {
		await prisma?.workspace.deleteMany({ where: { owner: { clerkId: { startsWith: "replica-db-test:" } } } });
		await prisma?.user.deleteMany({ where: { clerkId: { startsWith: "replica-db-test:" } } });
		(globalThis as { narriflowPrismaClient?: PrismaClient }).narriflowPrismaClient = undefined;
		await prisma?.$disconnect();
		await pool?.end();
	});

	async function project(clipCount: number, aspects = 2) {
		const user = await prisma.user.create({
			data: { clerkId: `replica-db-test:${randomUUID()}`, primaryEmail: `${randomUUID()}@example.test` },
		});
		const workspace = await prisma.workspace.create({
			data: {
				name: "Replicas",
				ownerUserId: user.id,
				personalOwnerUserId: user.id,
				members: { create: { userId: user.id, role: "owner" } },
			},
		});
		const created = await prisma.project.create({
			data: {
				title: "Replicas",
				sourceMediaUrl: "r2://test/source",
				sourceStorageKey: "test/source",
				sourceDurationSeconds: 100,
				ingestStatus: "ready",
				workspaceId: workspace.id,
			},
		});
		const run = await prisma.workflowRun.create({
			data: { projectId: created.id, idempotencyKey: randomUUID(), stage: "clip_rendering", status: "queued" },
		});
		const variantIds: string[] = [];
		for (let index = 0; index < clipCount; index++) {
			const clip = await prisma.clip.create({
				data: {
					projectId: created.id,
					workflowRunId: run.id,
					index,
					startSec: index * 10,
					endSec: index * 10 + 10,
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
			for (const aspectRatio of ["ratio_9_16", "ratio_1_1", "ratio_16_9"].slice(0, aspects) as Array<
				"ratio_9_16" | "ratio_1_1" | "ratio_16_9"
			>) {
				const variant = await prisma.clipRender.create({
					data: { clipId: clip.id, aspectRatio, resolution: "1080p" },
				});
				variantIds.push(variant.id);
			}
		}
		return { project: created, run, variantIds };
	}

	/** One worker process: its own group lifecycle identity and one CPU lane. */
	function replica(name: string, options: { leaseDurationMs?: number; releaseGraceMs?: number; renderMs?: number } = {}) {
		const groups = new RenderGroupLifecycle({
			prisma,
			leaseOwner: `${name}:${randomUUID()}`,
			leaseDurationMs: options.leaseDurationMs ?? 30_000,
			releaseGraceMs: options.releaseGraceMs ?? 50,
		});
		const stop = new AbortController();
		const state = {
			name,
			groups,
			stop,
			rendered: [] as string[],
			spans: [] as Array<{ groupId: string; startMs: number; endMs: number }>,
			/** Variants this replica fails the first time it renders them. */
			failOnce: new Set<string>(),
			permanent: new Set<string>(),
			/** Hang (a dead process) in the second member of whatever group is claimed. */
			hangOnSecondMember: false,
			claimed: [] as ClaimedRenderGroupAttempt[],
			heartbeatIntervalMs: 200,
			async tick() {
				return executeNextRenderGroup({
					groups,
					toolchainFingerprint: "sha256:test-toolchain",
					signal: stop.signal,
					heartbeatIntervalMs: state.heartbeatIntervalMs,
					render: async ({ group, attempt, lifecycle, context }) => {
						const startMs = Date.now();
						const { variantIds } = await lifecycle.beginRenderGroup(attempt);
						state.claimed.push(group);
						for (const id of variantIds) {
							expect(await groups.markClipRenderVariantRendering(group, id)).toBe(true);
							await lifecycle.startExecution(attempt, { sourceFingerprint: "test/source#1" });
							if (state.hangOnSecondMember && id === variantIds[1]) await new Promise(() => {});
							await sleep(options.renderMs ?? 120, context.signal);
							if (state.permanent.has(id)) {
								await groups.failClipRenderVariant(group, id, "render_output_invalid", "permanent");
								continue;
							}
							if (state.failOnce.delete(id)) {
								await groups.failClipRenderVariant(group, id, "upload_unavailable", "retryable");
								continue;
							}
							state.rendered.push(id);
							expect(
								await groups.completeClipRenderVariant(group, id, {
									storageKey: `render/${group.token}/${id}`,
									sizeBytes: 1_000,
									durationSec: 10,
								}),
							).toBe(true);
						}
						state.spans.push({ groupId: group.groupId, startMs, endMs: Date.now() });
						return lifecycle.finishRenderGroup(attempt);
					},
				});
			},
			/** Poll loop: claim, render, repeat. */
			async run() {
				while (!stop.signal.aborted) {
					const processed = await state.tick().catch((error) => {
						console.warn(`replica ${name} tick failed: ${String(error)}`);
						return 0;
					});
					if (!processed) await sleep(25, stop.signal).catch(() => undefined);
				}
			},
		};
		return state;
	}

	function coordinatorLifecycle(options: { leaseDurationMs?: number } = {}) {
		return new WorkflowRunLifecycle({
			prisma,
			leaseOwner: randomUUID(),
			leaseDurationMs: options.leaseDurationMs,
			heartbeatIntervalMs: 100,
		});
	}

	async function coordinate(lifecycle: WorkflowRunLifecycle) {
		const attempt = (await lifecycle.claim("clip_rendering")) as ClaimedWorkflowAttempt & { stage: "clip_rendering" };
		expect(attempt).not.toBeNull();
		const settled = lifecycle.runAttempt(attempt, (context) =>
			coordinateRenderWorkSet({ attempt, context, lifecycle, state: clipService, pollIntervalMs: 50 }),
		);
		return { attempt, settled };
	}

	async function expectEachVariantCompletedOnce(variantIds: string[]) {
		const outcomes = await prisma.renderGroupVariantOutcome.findMany({
			where: { clipRenderId: { in: variantIds }, result: "completed" },
		});
		expect(outcomes).toHaveLength(variantIds.length);
		expect(new Set(outcomes.map((o) => o.clipRenderId)).size).toBe(variantIds.length);
	}

	test("controlled four-group throughput with one and two replicas", async () => {
    for (const count of [1, 2]) {
      const samples: number[] = [];
      for (let sample = 0; sample < 3; sample++) {
        const { variantIds } = await project(4);
        const workers = Array.from({length: count}, (_, i) => replica(`benchmark-${sample}-${i}`));
        const { settled } = await coordinate(coordinatorLifecycle());
        const start = performance.now();
        const loops = workers.map((w) => w.run());
        const outcome = await settled;
        const elapsedMs = performance.now() - start;
        for (const w of workers) w.stop.abort();
        await Promise.all(loops);
        expect(outcome).toMatchObject({status: "completed", succeeded: 8});
        await expectEachVariantCompletedOnce(variantIds);
        samples.push(elapsedMs);
        console.warn(JSON.stringify({ level: "info", message: "render_throughput_sample", replicas: count, sample, groups: 4, variants: 8, elapsedMs,
          busyMs: workers.map((w) => w.spans.reduce((sum, span) => sum + span.endMs - span.startMs, 0)),
          uploadBytes: 8000, repeatedVariants: 0, workload: "real PostgreSQL leases; injected 120ms encode and 1000-byte upload per variant" }));
      }
      const sorted = [...samples].sort((a,b) => a-b);
      console.warn(JSON.stringify({ level: "info", message: "render_throughput_summary", replicas: count, samples: 3, p50Ms: sorted[1], p95Ms: sorted[2] }));
    }
  }, 60_000);

	test("three replicas render the groups of one project concurrently, each exactly once", async () => {
		const { run, variantIds } = await project(6);
		const replicas = [replica("a"), replica("b"), replica("c")];
		const { settled } = await coordinate(coordinatorLifecycle());
		const startedAt = Date.now();
		const loops = replicas.map((r) => r.run());
		const outcome = await settled;
		const elapsedMs = Date.now() - startedAt;
		for (const r of replicas) r.stop.abort();
		await Promise.all(loops);

		expect(outcome).toMatchObject({ status: "completed", requested: 12, succeeded: 12, failed: 0 });
		// Every variant was encoded by exactly one replica, once.
		const rendered = replicas.flatMap((r) => r.rendered);
		expect(rendered.sort()).toEqual([...variantIds].sort());
		await expectEachVariantCompletedOnce(variantIds);
		// One lease and one charge per group; distinct owners shared the work.
		const groups = await prisma.renderGroup.findMany({ where: { workflowRunId: run.id }, include: { executions: true } });
		expect(groups).toHaveLength(6);
		for (const group of groups) {
			expect(group.status).toBe("completed");
			expect(group.chargedAttemptCount).toBe(1);
			expect(group.executions).toHaveLength(1);
			expect(group.executions[0]).toMatchObject({ charged: true, result: "completed" });
		}
		expect(replicas.filter((r) => r.rendered.length > 0).length).toBeGreaterThanOrEqual(2);
		// Replicas overlapped in time; a single replica never ran two groups at once.
		const spans = replicas.flatMap((r) => r.spans);
		expect(spans.some((a) => spans.some((b) => a.groupId !== b.groupId && a.startMs < b.endMs && b.startMs < a.endMs))).toBe(true);
		for (const r of replicas)
			for (const a of r.spans)
				for (const b of r.spans)
					if (a !== b) expect(a.endMs <= b.startMs || b.endMs <= a.startMs).toBe(true);
		// Parent settlement is single: one terminal row and one notification intent.
		const parent = await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } });
		expect(parent).toMatchObject({ status: "completed", requestedCount: 12, succeededCount: 12, failedCount: 0 });
		expect(await prisma.workflowEvent.count({ where: { workflowRunId: run.id, notificationRequired: true } })).toBe(1);
		console.warn(JSON.stringify({ message: "replica_run_elapsed", elapsedMs, perReplica: replicas.map((r) => r.rendered.length) }));
	}, 60_000);

	test("mixed outcomes: a retryable sibling is retried alone; a permanent failure ends the parent partial", async () => {
		const { run, variantIds } = await project(3);
		const [retryVariant, , , permanentVariant] = variantIds;
		const replicas = [replica("a"), replica("b")];
		const failOnce = new Set([retryVariant!]);
		for (const r of replicas) {
			r.failOnce = failOnce;
			r.permanent.add(permanentVariant!);
		}
		const { settled } = await coordinate(coordinatorLifecycle());
		let done = false;
		void settled.then(() => (done = true));
		const loops = replicas.map((r) => r.run());
		// The retry waits out its backoff; the parent must stay open meanwhile.
		const retryGroup = async () =>
			prisma.renderGroup.findFirst({ where: { workflowRunId: run.id, members: { some: { clipRenderId: retryVariant! } } } });
		for (let wait = 0; wait < 100; wait++) {
			if ((await retryGroup())?.nextAttemptAt) break;
			await sleep(50);
		}
		const waiting = await retryGroup();
		expect(waiting).toMatchObject({ status: "queued", chargedAttemptCount: 1 });
		expect(waiting!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 20_000);
		await sleep(500);
		expect(done).toBe(false);
		await prisma.$executeRaw`UPDATE "RenderGroup" SET "nextAttemptAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE "id" = ${waiting!.id}::uuid`;
		const outcome = await settled;
		for (const r of replicas) r.stop.abort();
		await Promise.all(loops);

		expect(outcome).toMatchObject({ status: "partial", requested: 6, succeeded: 5, failed: 1 });
		const rendered = replicas.flatMap((r) => r.rendered);
		// The completed sibling of the retried group was not rendered again.
		const siblingOfRetry = variantIds[1]!;
		expect(rendered.filter((id) => id === siblingOfRetry)).toHaveLength(1);
		expect(rendered.filter((id) => id === retryVariant)).toHaveLength(1);
		expect(rendered).not.toContain(permanentVariant);
		const group = await retryGroup();
		expect(group).toMatchObject({ status: "completed", chargedAttemptCount: 2 });
		expect(await prisma.workflowEvent.count({ where: { workflowRunId: run.id, notificationRequired: true } })).toBe(1);
	}, 60_000);

	test("a replica that dies mid-group is reclaimed by another; only the unfinished member renders again", async () => {
		const { run, variantIds } = await project(2);
		const dead = replica("dead", { leaseDurationMs: 400 });
		dead.heartbeatIntervalMs = 3_600_000;
		const healthy = replica("healthy");
		// The dead replica finishes the first member of its group, then hangs in the second.
		const { settled } = await coordinate(coordinatorLifecycle());
		dead.hangOnSecondMember = true;
		let crashedAttempt: Promise<unknown> = Promise.resolve();
		for (let wait = 0; wait < 100 && dead.claimed.length === 0; wait++) {
			crashedAttempt = dead.tick();
			void crashedAttempt.catch((error) => console.warn(`dead tick failed: ${String(error)}`));
			await sleep(100);
		}
		expect(dead.claimed).toHaveLength(1);
		const claimed = dead.claimed[0]!;
		const healthyLoop = healthy.run();

		// The healthy replica drains every other group while the lease runs out.
		for (let wait = 0; wait < 100; wait++) {
			const group = await prisma.renderGroup.findUniqueOrThrow({ where: { id: claimed.groupId } });
			if (group.leaseExpiresAt && group.leaseExpiresAt.getTime() < Date.now() - 50) break;
			await sleep(50);
		}
		expect(await healthy.groups.reapExpired()).toBe(1);
		const reaped = await prisma.renderGroup.findUniqueOrThrow({ where: { id: claimed.groupId }, include: { executions: true } });
		expect(reaped).toMatchObject({ status: "queued", chargedAttemptCount: 1 });
		expect(reaped.executions[0]).toMatchObject({ charged: true, result: "interrupted" });
		await prisma.$executeRaw`UPDATE "RenderGroup" SET "nextAttemptAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE "id" = ${claimed.groupId}::uuid`;

		const outcome = await settled;
		healthy.stop.abort();
		await healthyLoop;

		expect(outcome).toMatchObject({ status: "completed", requested: 4, succeeded: 4, failed: 0 });
		// The crashed replica's committed variant is not rendered again; the in-flight one is.
		const done = await prisma.renderGroupVariantOutcome.findMany({
			where: { groupId: claimed.groupId, result: "completed" },
		});
		expect(done).toHaveLength(2);
		expect(healthy.rendered.filter((id) => id === claimed.memberIds[0])).toHaveLength(0);
		expect(healthy.rendered).toContain(claimed.memberIds[1]!);
		const group = await prisma.renderGroup.findUniqueOrThrow({ where: { id: claimed.groupId }, include: { executions: true } });
		// The crash was charged once; the successful retry is the second charge.
		expect(group.chargedAttemptCount).toBe(2);
		expect(group.executions.map((e) => e.result).sort()).toEqual(["completed", "interrupted"]);
		await expectEachVariantCompletedOnce(variantIds);

		// The dead replica's late write is fenced by its expired token: not persisted.
		await expect(
			dead.groups.completeClipRenderVariant(claimed, claimed.memberIds[1]!, {
				storageKey: "render/late",
				sizeBytes: 1,
				durationSec: 1,
			}),
		).resolves.toBe(false);
		dead.stop.abort();
		expect(run.id).toBeTruthy();
	}, 60_000);

	test("shutdown drain releases the group without charging it; completed members stay", async () => {
		const { variantIds } = await project(1);
		const draining = replica("draining", { renderMs: 400 });
		const successor = replica("successor", { releaseGraceMs: 50 });
		const { settled } = await coordinate(coordinatorLifecycle());
		const ticks: Array<Promise<number>> = [];
		// First member completes (~400ms); abort while the second encodes.
		for (let wait = 0; wait < 200 && draining.rendered.length < 1; wait++) {
			if (draining.claimed.length === 0) ticks.push(draining.tick());
			await sleep(25);
		}
		expect(draining.rendered).toHaveLength(1);
		draining.stop.abort(new DOMException("shutdown", "AbortError"));
		expect(await Promise.all(ticks)).toEqual(ticks.map(() => 0));

		const group = await prisma.renderGroup.findFirstOrThrow({
			where: { members: { some: { clipRenderId: variantIds[0]! } } },
			include: { executions: true },
		});
		expect(group).toMatchObject({ status: "queued", chargedAttemptCount: 0 });
		expect(group.executions).toHaveLength(1);
		expect(group.executions[0]).toMatchObject({ result: "released", charged: false });
		const kept = await prisma.clipRender.findUniqueOrThrow({ where: { id: draining.rendered[0]! } });
		expect(kept.status).toBe("completed");

		const loop = successor.run();
		const outcome = await settled;
		successor.stop.abort();
		await loop;
		expect(outcome).toMatchObject({ status: "completed", requested: 2, succeeded: 2 });
		expect(successor.rendered).toEqual(variantIds.filter((id) => id !== draining.rendered[0]));
		await expectEachVariantCompletedOnce(variantIds);
	}, 60_000);

	test("a dead coordinator is replaced while healthy replicas keep their group leases", async () => {
		const { run, variantIds } = await project(4);
		const first = coordinatorLifecycle({ leaseDurationMs: 300 });
		const attempt = (await first.claim("clip_rendering")) as ClaimedWorkflowAttempt & { stage: "clip_rendering" };
		await first.beginRenderWorkSet(attempt);
		await first.admitRenderGroups(attempt, (await clipService.planRenderGroups(attempt.projectId, attempt.workflowRunId))!);
		// The first coordinator never heartbeats again: its lease lapses mid-render.
		const worker = replica("w", { renderMs: 250 });
		const loop = worker.run();
		await sleep(700);
		expect(await coordinatorLifecycle().reapExpiredAttempts()).toBe(1);
		await prisma.$executeRaw`UPDATE "WorkflowRun" SET "nextAttemptAt" = NULL WHERE "id" = ${run.id}::uuid`;

		const { settled } = await coordinate(coordinatorLifecycle());
		const outcome = await settled;
		worker.stop.abort();
		await loop;
		expect(outcome).toMatchObject({ status: "completed", requested: 8, succeeded: 8 });
		await expectEachVariantCompletedOnce(variantIds);
		// The group partition was admitted once; the replacement only waited.
		expect(await prisma.renderGroup.count({ where: { workflowRunId: run.id } })).toBe(4);
		expect(await prisma.workflowEvent.count({ where: { workflowRunId: run.id, notificationRequired: true } })).toBe(1);
	}, 60_000);
});
