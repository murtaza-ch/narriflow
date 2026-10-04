import { randomUUID } from "node:crypto";
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import {
	contentPackSchema,
	PLATFORM_PLAYBOOK_VERSION,
} from "@narriflow/validators";
import {
	createMcpOperationExecutor,
	McpOperationConflictError,
} from "./mcp-operation";
import { prismaMcpOperationPersistence } from "./mcp-operation-runtime";
import { projectService } from "./project.service";
import { AutopilotService } from "./autopilot.service";
import {
	clipExportService,
	ClipExportRevisionConflictError,
} from "./clip-export.service";
import { WorkflowRunLifecycle } from "./workflow-run-lifecycle";

const databaseUrl = process.env.MCP_TEST_DATABASE_URL;
const schema = process.env.MCP_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_MCP_DB_TESTS === "1" && Boolean(databaseUrl);
const describeDb = enabled ? describe : describe.skip;
setDefaultTimeout(180_000);

describeDb("MCP PostgreSQL acceptance invariants", () => {
	let prisma: PrismaClient;
	let pool: Pool;
	let priorPrisma: PrismaClient | undefined;
	const globalPrisma = globalThis as unknown as {
		narriflowPrismaClient?: PrismaClient;
	};
	let actorUserId: string;
	let workspaceId: string;
	const pack = contentPackSchema.parse({
		outputTypes: ["short_clip"],
		clipCountTarget: 5,
		clipDurationSecTarget: 30,
		platformPlaybookVersion: PLATFORM_PLAYBOOK_VERSION,
	});
	const createClip = (projectId: string, workflowRunId: string) =>
		prisma.clip.create({
			data: {
				projectId,
				workflowRunId,
				index: 0,
				startSec: 0,
				endSec: 30,
				hookText: "A reviewed hook",
				reasoning: "Complete story",
				category: "insight",
				transcriptSlice: [],
				viralityScore: 80,
				hookStrengthScore: 80,
				emotionalIntensityScore: 60,
				pacingScore: 70,
				durationOptimalityScore: 90,
				tiktokScore: 80,
				youtubeScore: 80,
				instagramScore: 80,
				llmProvider: "test",
				llmModel: "test",
			},
		});
	async function exportSource(title: string) {
		const project = await prisma.project.create({
			data: {
				workspaceId,
				title,
				sourceMediaUrl: "https://example.test/source.mp4",
				sourceDurationSeconds: 120,
				ingestStatus: "ready",
			},
		});
		const detection = await prisma.workflowRun.create({
			data: {
				projectId: project.id,
				stage: "moment_detection",
				status: "completed",
				idempotencyKey: randomUUID(),
			},
		});
		const clip = await createClip(project.id, detection.id);
		return { project, clip, scope: { actorUserId, workspaceId } };
	}
	async function assignedExportRun(projectId: string, exportIds: string[]) {
		const leaseOwner = `mcp-export-cancel:${randomUUID()}`;
		const attemptId = randomUUID();
		const run = await prisma.workflowRun.create({
			data: {
				projectId,
				stage: "clip_rendering",
				status: "running",
				idempotencyKey: randomUUID(),
				attemptId,
				attemptCount: 1,
				leaseOwner,
				leaseExpiresAt: new Date(Date.now() + 120_000),
			},
		});
		await prisma.clipExport.updateMany({
			where: { id: { in: exportIds } },
			data: { workflowRunId: run.id },
		});
		await prisma.clipRender.updateMany({
			where: { exportVariant: { exportId: { in: exportIds } } },
			data: { workflowRunId: run.id },
		});
		return {
			run,
			attempt: {
				workflowRunId: run.id,
				projectId,
				stage: "clip_rendering" as const,
				attemptId,
				attemptCount: 1,
			},
			lifecycle: new WorkflowRunLifecycle({ prisma, leaseOwner }),
		};
	}

	beforeAll(async () => {
		if (!databaseUrl || !schema || !/^mcp_test_[a-z0-9_]+$/.test(schema))
			throw new Error("MCP DB tests require a disposable mcp_test_ schema");
		pool = new Pool({ connectionString: databaseUrl, max: 10 });
		const selected = await pool.query('SELECT current_schema() AS "schema"');
		if (selected.rows[0]?.schema !== schema)
			throw new Error("MCP test connection selected the wrong schema");
		prisma = new PrismaClient({
			adapter: new PrismaPg(pool, { schema }),
			transactionOptions: { maxWait: 120_000, timeout: 120_000 },
		});
		priorPrisma = globalPrisma.narriflowPrismaClient;
		globalPrisma.narriflowPrismaClient = prisma;
		const actor = await prisma.user.create({
			data: { clerkId: `mcp-test:${randomUUID()}` },
		});
		actorUserId = actor.id;
		const workspace = await prisma.workspace.create({
			data: {
				name: "MCP acceptance",
				ownerUserId: actor.id,
				pricingTier: "business",
				members: { create: { userId: actor.id, role: "owner" } },
			},
		});
		workspaceId = workspace.id;
	});

	afterAll(async () => {
		globalPrisma.narriflowPrismaClient = priorPrisma;
		await prisma?.$disconnect();
		await pool?.end();
	});

	test("concurrent duplicate requests commit one domain record and immutable receipt", async () => {
		const executor = createMcpOperationExecutor(
			prismaMcpOperationPersistence(prisma),
		);
		const identity = {
			workspaceId,
			callerId: actorUserId,
			toolName: "test_acceptance",
			clientIdempotencyKey: randomUUID(),
		};
		const accepted = await Promise.all(
			Array.from({ length: 6 }, () =>
				executor.execute({
					identity,
					input: { title: "Single admission" },
					authorize: async () => {},
					mutate: async (tx) => {
						const row = await tx.project.create({
							data: {
								workspaceId,
								createdByUserId: actorUserId,
								title: "Single admission",
								sourceMediaUrl: "https://example.test/source.mp4",
							},
						});
						return {
							resourceType: "project",
							resourceId: row.id,
							value: { projectId: row.id },
						};
					},
				}),
			),
		);
		expect(new Set(accepted.map((entry) => entry.value.projectId)).size).toBe(
			1,
		);
		expect(
			await prisma.project.count({
				where: { workspaceId, title: "Single admission" },
			}),
		).toBe(1);
		expect(await prisma.mcpOperation.count({ where: identity })).toBe(1);
		await expect(
			executor.execute({
				identity,
				input: { title: "Changed" },
				authorize: async () => {},
				mutate: async () => {
					throw new Error("Must not mutate");
				},
			}),
		).rejects.toBeInstanceOf(McpOperationConflictError);
	});

	test("interrupted acceptance rolls back domain work and survives executor restart", async () => {
		const identity = {
			workspaceId,
			callerId: actorUserId,
			toolName: "test_restart",
			clientIdempotencyKey: randomUUID(),
		};
		const executor = createMcpOperationExecutor(
			prismaMcpOperationPersistence(prisma),
		);
		await expect(
			executor.execute({
				identity,
				input: {},
				authorize: async () => {},
				mutate: async (tx) => {
					await tx.project.create({
						data: {
							workspaceId,
							title: "Interrupted acceptance",
							sourceMediaUrl: "https://example.test/source.mp4",
						},
					});
					throw new Error("Connection interrupted");
				},
			}),
		).rejects.toThrow("Connection interrupted");
		expect(
			await prisma.project.count({
				where: { workspaceId, title: "Interrupted acceptance" },
			}),
		).toBe(0);
		expect(await prisma.mcpOperation.count({ where: identity })).toBe(0);
		const accepted = await executor.execute({
			identity,
			input: {},
			authorize: async () => {},
			mutate: async (tx) => {
				const row = await tx.project.create({
					data: {
						workspaceId,
						title: "Accepted after interruption",
						sourceMediaUrl: "https://example.test/source.mp4",
					},
				});
				return {
					resourceType: "project",
					resourceId: row.id,
					value: { projectId: row.id },
				};
			},
		});
		const restarted = createMcpOperationExecutor(
			prismaMcpOperationPersistence(prisma),
		);
		const replay = await restarted.execute({
			identity,
			input: {},
			authorize: async () => {},
			beforeAccept: async () => {
				throw new Error("Limiter unavailable");
			},
			mutate: async () => {
				throw new Error("Must not mutate");
			},
		});
		expect(replay.operationId).toBe(accepted.operationId);
		expect(replay.value).toEqual(accepted.value);
	});

	test("link intake commits the ingest job and runnable generation settings together", async () => {
		const mutation = {
			clientIdempotencyKey: randomUUID(),
			callerId: "oauth:test",
		};
		const scope = { actorUserId, workspaceId };
		const input = {
			title: "Atomic link",
			url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		};
		const [first, duplicate] = await Promise.all([
			projectService.queueLinkIngest(scope, input, {
				generationContext: { contentPack: pack, languageCode: "en" },
				mutation,
			}),
			projectService.queueLinkIngest(scope, input, {
				generationContext: { contentPack: pack, languageCode: "en" },
				mutation,
			}),
		]);
		expect(duplicate).toEqual(first);
		expect(first.queuedJobId).toBeString();
		const stored = await prisma.project.findUniqueOrThrow({
			where: { id: first.project.id },
			include: { contentPacks: true, ingestJobs: true },
		});
		expect(stored.contentPacks).toHaveLength(1);
		expect(stored.contentPacks[0]?.draft).toBe(false);
		expect(stored.contentPacks[0]?.clipCountTarget).toBe(5);
		expect(stored.languageCode).toBe("en");
		expect(stored.ingestJobs).toHaveLength(1);
		const replay = await projectService.queueLinkIngest(scope, input, {
			generationContext: { contentPack: pack, languageCode: "en" },
			mutation: {
				...mutation,
				beforeAccept: async () => {
					throw new Error("Limiter unavailable");
				},
			},
		});
		expect(replay).toEqual(first);
		await expect(
			projectService.queueLinkIngest(scope, input, {
				generationContext: {
					contentPack: { ...pack, clipCountTarget: 6 },
					languageCode: "en",
				},
				mutation,
			}),
		).rejects.toBeInstanceOf(McpOperationConflictError);
	});

	test("generation reuses only the requested settings and replays accepted work during outages", async () => {
		const project = await prisma.project.create({
			data: {
				workspaceId,
				title: "Generation settings",
				sourceMediaUrl: "https://example.test/generation.mp4",
				sourceDurationSeconds: 60,
				ingestStatus: "ready",
			},
		});
		const scope = { actorUserId, workspaceId };
		const key = randomUUID();
		const request = {
			contentPack: pack,
			languageCode: "en",
			forceRegenerate: false,
		};
		const first = await projectService.triggerGeneration(
			scope,
			project.id,
			request,
			key,
			{ mutation: { clientIdempotencyKey: key } },
		);
		const anotherKey = randomUUID();
		const sameSettings = await projectService.triggerGeneration(
			scope,
			project.id,
			request,
			anotherKey,
			{ mutation: { clientIdempotencyKey: anotherKey } },
		);
		expect(sameSettings.workflowRunId).toBe(first.workflowRunId);
		const changedKey = randomUUID();
		await expect(
			projectService.triggerGeneration(
				scope,
				project.id,
				{ ...request, contentPack: { ...pack, clipCountTarget: 8 } },
				changedKey,
				{ mutation: { clientIdempotencyKey: changedKey } },
			),
		).rejects.toMatchObject({
			code: "generation_settings_conflict",
			kind: "conflict",
		});
		expect(
			await prisma.mcpOperation.count({
				where: { clientIdempotencyKey: changedKey },
			}),
		).toBe(0);
		const pausedKey = randomUUID();
		await expect(
			projectService.triggerGeneration(scope, project.id, request, pausedKey, {
				mutation: {
					clientIdempotencyKey: pausedKey,
					beforeAccept: async () => {
						throw new Error("Limiter unavailable");
					},
				},
			}),
		).rejects.toThrow("Limiter unavailable");
		expect(
			await projectService.triggerGeneration(scope, project.id, request, key, {
				mutation: {
					clientIdempotencyKey: key,
					beforeAccept: async () => {
						throw new Error("Limiter unavailable");
					},
				},
			}),
		).toEqual(first);
		expect(
			await prisma.workflowRun.count({ where: { projectId: project.id } }),
		).toBe(1);
		expect(
			await prisma.contentPack.count({ where: { projectId: project.id } }),
		).toBe(1);
	});

	test("forced generation waits for downstream work and ordinary reuse retains the generation root", async () => {
		const project = await prisma.project.create({
			data: {
				workspaceId,
				title: "Generation overlap",
				sourceMediaUrl: "https://example.test/overlap.mp4",
				sourceDurationSeconds: 60,
				ingestStatus: "ready",
			},
		});
		const scope = { actorUserId, workspaceId };
		const request = {
			contentPack: pack,
			languageCode: "en",
			forceRegenerate: false,
		};
		const key = randomUUID();
		const first = await projectService.triggerGeneration(
			scope,
			project.id,
			request,
			key,
			{ mutation: { clientIdempotencyKey: key } },
		);
		const root = await prisma.workflowRun.update({
			where: { id: first.workflowRunId },
			data: { status: "completed" },
		});
		await prisma.transcript.update({
			where: { projectId: project.id },
			data: { status: "completed" },
		});
		const detection = await prisma.workflowRun.create({
			data: {
				projectId: project.id,
				stage: "moment_detection",
				idempotencyKey: `${key}__moment_detection`,
				contentPackId: root.contentPackId,
				status: "queued",
			},
		});
		const forcedKey = randomUUID();
		const forced = () =>
			projectService.triggerGeneration(
				scope,
				project.id,
				{
					...request,
					forceRegenerate: true,
					contentPack: { ...pack, clipCountTarget: 8 },
				},
				forcedKey,
				{ mutation: { clientIdempotencyKey: forcedKey } },
			);
		await expect(forced()).rejects.toMatchObject({
			code: "project_has_active_workflow",
		});
		await prisma.workflowRun.update({
			where: { id: detection.id },
			data: { status: "completed" },
		});
		const renderRun = await prisma.workflowRun.create({
			data: {
				projectId: project.id,
				stage: "clip_rendering",
				idempotencyKey: `auto-render-${detection.id}`,
				status: "queued",
			},
		});
		await expect(forced()).rejects.toMatchObject({
			code: "project_has_active_workflow",
		});
		const ordinaryKey = randomUUID();
		expect(
			(
				await projectService.triggerGeneration(
					scope,
					project.id,
					request,
					ordinaryKey,
					{ mutation: { clientIdempotencyKey: ordinaryKey } },
				)
			).workflowRunId,
		).toBe(first.workflowRunId);
		expect(
			await projectService.triggerGeneration(scope, project.id, request, key, {
				mutation: { clientIdempotencyKey: key },
			}),
		).toEqual(first);
		await prisma.workflowRun.update({
			where: { id: renderRun.id },
			data: { status: "completed" },
		});
		const clip = await createClip(project.id, detection.id);
		const pending = await prisma.clipRender.create({
			data: { clipId: clip.id, aspectRatio: "ratio_9_16", status: "pending" },
		});
		await expect(forced()).rejects.toMatchObject({
			code: "project_has_active_workflow",
		});
		expect(
			await prisma.mcpOperation.count({
				where: { clientIdempotencyKey: forcedKey },
			}),
		).toBe(0);
		await prisma.clipRender.update({
			where: { id: pending.id },
			data: { status: "completed" },
		});
		const regenerated = await forced();
		expect(regenerated.workflowRunId).not.toBe(first.workflowRunId);
		const newRun = await prisma.workflowRun.findUniqueOrThrow({
			where: { id: regenerated.workflowRunId },
			include: { contentPack: true },
		});
		expect(newRun.contentPack?.clipCountTarget).toBe(8);
	});

	test("RSS creation replays without fetching a now unavailable feed", async () => {
		let feedReads = 0;
		const service = new AutopilotService({
			fetchFeed: async (rssUrl) => {
				feedReads++;
				if (feedReads > 1) throw new Error("Feed disappeared");
				return {
					title: "Daily show",
					finalUrl: rssUrl,
					episodes: [],
					etag: null,
					lastModified: null,
				};
			},
		});
		const mutation = { clientIdempotencyKey: randomUUID() };
		const input = {
			name: "Daily show",
			rssUrl: "https://feeds.example.test/daily.xml",
			contentPack: pack,
		};
		const first = await service.createRule(
			{ actorUserId, workspaceId },
			input,
			mutation,
		);
		const replay = await service.createRule(
			{ actorUserId, workspaceId },
			input,
			mutation,
		);
		expect(replay).toEqual(first);
		expect(feedReads).toBe(1);
		await expect(
			service.createRule(
				{ actorUserId, workspaceId },
				{ ...input, name: "Changed show" },
				mutation,
			),
		).rejects.toBeInstanceOf(McpOperationConflictError);
	});

	test("run-now replays without resetting a later worker claim", async () => {
		const service = new AutopilotService({
			fetchFeed: async (rssUrl) => ({
				title: "Run now",
				finalUrl: rssUrl,
				episodes: [],
				etag: null,
				lastModified: null,
			}),
		});
		const scope = { actorUserId, workspaceId };
		const rule = await service.createRule(scope, {
			name: "Run now",
			rssUrl: "https://feeds.example.test/run-now.xml",
			contentPack: pack,
		});
		const mutation = { clientIdempotencyKey: randomUUID() };
		const first = await service.triggerRuleNow(scope, rule.id, mutation);
		const claimToken = randomUUID();
		const leaseExpiresAt = new Date(Date.now() + 60_000);
		await prisma.autopilotRule.update({
			where: { id: rule.id },
			data: { status: "running", claimToken, leaseExpiresAt },
		});
		expect(await service.triggerRuleNow(scope, rule.id, mutation)).toEqual(
			first,
		);
		const active = await service.triggerRuleNow(scope, rule.id, {
			clientIdempotencyKey: randomUUID(),
		});
		expect(active.status).toBe("running");
		expect(
			await prisma.autopilotRule.findUniqueOrThrow({
				where: { id: rule.id },
				select: { claimToken: true, leaseExpiresAt: true },
			}),
		).toEqual({ claimToken, leaseExpiresAt });
	});

	test("exports replay their accepted revision and conflict on changed key input", async () => {
		const project = await prisma.project.create({
			data: {
				workspaceId,
				title: "Export source",
				sourceMediaUrl: "https://example.test/source.mp4",
				sourceDurationSeconds: 120,
				ingestStatus: "ready",
			},
		});
		const run = await prisma.workflowRun.create({
			data: {
				projectId: project.id,
				stage: "clip_detection",
				idempotencyKey: randomUUID(),
				status: "completed",
			},
		});
		const clip = await createClip(project.id, run.id);
		const scope = { actorUserId, workspaceId };
		const key = randomUUID();
		const format = {
			expectedRevision: 0,
			aspectRatios: ["9:16" as const],
			resolution: "720p" as const,
		};
		const first = await clipExportService.create(
			scope,
			project.id,
			clip.id,
			format,
			key,
		);
		await prisma.clip.update({
			where: { id: clip.id },
			data: { editorRevision: 1 },
		});
		expect(
			await clipExportService.create(scope, project.id, clip.id, format, key),
		).toEqual(first);
		await expect(
			clipExportService.create(
				scope,
				project.id,
				clip.id,
				{ ...format, resolution: "1080p" },
				key,
			),
		).rejects.toBeInstanceOf(McpOperationConflictError);
		await expect(
			clipExportService.create(
				scope,
				project.id,
				clip.id,
				format,
				randomUUID(),
			),
		).rejects.toBeInstanceOf(ClipExportRevisionConflictError);
		expect(await prisma.clipExport.count({ where: { clipId: clip.id } })).toBe(
			1,
		);
	});

	test("export cancellation stops pending variants before a render run is assigned", async () => {
		const project = await prisma.project.create({
			data: {
				workspaceId,
				title: "Unassigned export",
				sourceMediaUrl: "https://example.test/source.mp4",
				sourceDurationSeconds: 120,
				ingestStatus: "ready",
			},
		});
		const detection = await prisma.workflowRun.create({
			data: {
				projectId: project.id,
				stage: "moment_detection",
				status: "completed",
				idempotencyKey: randomUUID(),
			},
		});
		const clip = await createClip(project.id, detection.id);
		const scope = { actorUserId, workspaceId };
		const accepted = await clipExportService.create(
			scope,
			project.id,
			clip.id,
			{
				expectedRevision: 0,
				aspectRatios: ["9:16"],
				resolution: "720p",
			},
			randomUUID(),
		);
		expect(
			await clipExportService.cancelQueuedOperation(scope, accepted.export.id),
		).toBe(true);
		const result = await clipExportService.getWorkspaceOwned(
			scope,
			accepted.export.id,
		);
		expect(result?.status).toBe("failed");
		expect(result?.errorCode).toBe("MCP_CANCELLED");
		expect(
			await prisma.clipRender.count({
				where: {
					exportVariant: { exportId: accepted.export.id },
					status: "pending",
				},
			}),
		).toBe(0);
		expect(
			await clipExportService.cancelQueuedOperation(scope, accepted.export.id),
		).toBe(false);
	});

	test("export cancellation preserves a shared run, another export, and claimed variants", async () => {
		const { project, clip, scope } = await exportSource("Shared export run");
		const first = await clipExportService.create(
			scope,
			project.id,
			clip.id,
			{
				expectedRevision: 0,
				aspectRatios: ["9:16", "1:1"],
				resolution: "720p",
			},
			randomUUID(),
		);
		const second = await clipExportService.create(
			scope,
			project.id,
			clip.id,
			{
				expectedRevision: 0,
				aspectRatios: ["9:16"],
				resolution: "1080p",
			},
			randomUUID(),
		);
		const { run, lifecycle, attempt } = await assignedExportRun(project.id, [
			first.export.id,
			second.export.id,
		]);
		const render = await prisma.clipRender.findFirstOrThrow({
			where: { exportVariant: { exportId: first.export.id } },
		});
		expect(
			await lifecycle.markClipRenderVariantRendering(attempt, render.id),
		).toBe(true);
		expect(
			await clipExportService.cancelQueuedOperation(scope, first.export.id),
		).toBe(true);
		const cancelled = await clipExportService.getWorkspaceOwned(
			scope,
			first.export.id,
		);
		expect(cancelled?.status).toBe("rendering");
		expect(cancelled?.variants.map((variant) => variant.status).sort()).toEqual(
			["failed", "rendering"],
		);
		expect(
			(await clipExportService.getWorkspaceOwned(scope, second.export.id))
				?.status,
		).toBe("queued");
		expect(
			(await prisma.clipRender.findUniqueOrThrow({ where: { id: render.id } }))
				.status,
		).toBe("rendering");
		expect(
			(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }))
				.status,
		).toBe("running");
		await lifecycle.completeClipRenderVariant(attempt, render.id, {
			storageKey: "test/cancel-preserved.mp4",
			sizeBytes: 100,
			durationSec: 30,
		});
		const partial = await prisma.clipExport.findUniqueOrThrow({
			where: { id: first.export.id },
		});
		expect(partial.status).toBe("partial_ready");
		expect(partial.errorCode).toBeNull();
	});

	test("export cancellation and worker claims agree on which pending variant won", async () => {
		for (let i = 0; i < 4; i++) {
			const { project, clip, scope } = await exportSource(
				`Export claim race ${i}`,
			);
			const accepted = await clipExportService.create(
				scope,
				project.id,
				clip.id,
				{
					expectedRevision: 0,
					aspectRatios: ["9:16"],
					resolution: "720p",
				},
				randomUUID(),
			);
			const { run, lifecycle, attempt } = await assignedExportRun(project.id, [
				accepted.export.id,
			]);
			const render = await prisma.clipRender.findFirstOrThrow({
				where: { exportVariant: { exportId: accepted.export.id } },
			});
			const [claimed, cancelled] = await Promise.all([
				lifecycle.markClipRenderVariantRendering(attempt, render.id),
				clipExportService.cancelQueuedOperation(scope, accepted.export.id),
			]);
			expect(cancelled).toBe(!claimed);
			const state = await prisma.clipExport.findUniqueOrThrow({
				where: { id: accepted.export.id },
				include: { variants: { include: { render: true } } },
			});
			expect(state.status).toBe(claimed ? "rendering" : "failed");
			expect(state.variants[0]?.status).toBe(claimed ? "rendering" : "failed");
			expect(state.variants[0]?.render?.status).toBe(
				claimed ? "rendering" : "failed",
			);
			expect(
				(await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }))
					.status,
			).toBe("running");
		}
	});
});
