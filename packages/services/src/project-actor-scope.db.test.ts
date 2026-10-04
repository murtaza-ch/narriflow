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
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import type { ActorScope } from "./actor-scope";
import {
	ProjectAccessDeniedError,
	ProjectNotFoundError,
	projectService,
} from "./project.service";
import { workspaceService } from "./workspace.service";
import { workspaceLibraryService } from "./workspace-library.service";
import {
	contentPackSchema,
	parseStoredContentPack,
} from "@narriflow/validators";

const databaseUrl = process.env.WORKFLOW_TEST_DATABASE_URL;
const schema = process.env.WORKFLOW_TEST_DATABASE_SCHEMA;
const enabled =
	process.env.ALLOW_WORKFLOW_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;
setDefaultTimeout(180_000);

dbDescribe("Project Actor Scope PostgreSQL interface", () => {
	let prisma: PrismaClient;
	let pool: Pool;
	let priorPrisma: PrismaClient | undefined;
	const users: string[] = [];
	const workspaces: string[] = [];
	const prismaGlobal = globalThis as unknown as {
		narriflowPrismaClient?: PrismaClient;
	};

	beforeAll(() => {
		if (!schema?.startsWith("workflow_lifecycle_test_")) {
			throw new Error("Project Actor Scope tests require a disposable schema");
		}
		pool = new Pool({ connectionString: databaseUrl, max: 4 });
		prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
		priorPrisma = prismaGlobal.narriflowPrismaClient;
		prismaGlobal.narriflowPrismaClient = prisma;
	});
	afterEach(async () => {
		await prisma.workspace.deleteMany({
			where: { id: { in: workspaces.splice(0) } },
		});
		await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
	});
	afterAll(async () => {
		prismaGlobal.narriflowPrismaClient = priorPrisma;
		await prisma.$disconnect();
		await pool.end();
	});

	async function user(label: string) {
		const suffix = randomUUID();
		const row = await prisma.user.create({
			data: {
				clerkId: `actor-scope:${label}:${suffix}`,
				primaryEmail: `${suffix}@example.test`,
			},
		});
		users.push(row.id);
		return row;
	}
	async function fixture() {
		const [owner, editor, viewer] = await Promise.all([
			user("owner"),
			user("editor"),
			user("viewer"),
		]);
		const workspace = await prisma.workspace.create({
			data: {
				name: "Shared Workspace",
				ownerUserId: owner.id,
				pricingTier: "pro",
				members: {
					create: [
						{ userId: owner.id, role: "owner" },
						{ userId: editor.id, role: "editor" },
						{ userId: viewer.id, role: "viewer" },
					],
				},
			},
		});
		workspaces.push(workspace.id);
		const scope = (actorUserId: string): ActorScope => ({
			actorUserId,
			workspaceId: workspace.id,
		});
		return { owner, editor, viewer, workspace, scope };
	}
	async function project(scope: ActorScope, title = "Shared project") {
		return projectService.createProject(scope, {
			title,
			sourceMediaUrl: "https://example.test/source.mp4",
		});
	}

	test("a non-owner editor creates, reads and changes shared content as themselves", async () => {
		const { owner, editor, viewer, workspace, scope } = await fixture();
		const created = await project(scope(editor.id));
		expect(created).toMatchObject({
			workspaceId: workspace.id,
			createdByUserId: editor.id,
		});
		expect(created).not.toHaveProperty("userId");
		const actor = await workspaceService.requireActor(
			editor.id,
			workspace.id,
			"content.edit",
		);
		expect(actor).toMatchObject({
			actorUserId: editor.id,
			workspaceOwnerUserId: owner.id,
		});
		expect(actor).not.toHaveProperty("userId");
		expect(
			await projectService.getProjectAccess(scope(viewer.id), created.id),
		).toBe("owned");
		expect(
			(await workspaceLibraryService.listProjects(scope(owner.id))).items.map(
				(row) => row.id,
			),
		).toEqual([created.id]);

		await projectService.setProjectNotifyPreference(
			scope(editor.id),
			created.id,
			false,
		);
		expect(
			await prisma.project.findUniqueOrThrow({ where: { id: created.id } }),
		).toMatchObject({
			createdByUserId: editor.id,
			updatedByUserId: editor.id,
			languageCode: null,
			notifyOnComplete: false,
		});
		await projectService.assertProjectGenerationAllowed(
			scope(editor.id),
			created.id,
		);
	});

	test("viewer, removed and deleted principals cannot mutate or consume processing", async () => {
		const { editor, viewer, workspace, scope } = await fixture();
		const created = await project(scope(editor.id));
		await expect(project(scope(viewer.id))).rejects.toMatchObject({
			code: "workspace_access_denied",
		});
		await expect(
			projectService.setProjectNotifyPreference(
				scope(viewer.id),
				created.id,
				false,
			),
		).rejects.toMatchObject({ code: "workspace_access_denied" });
		await expect(
			projectService.assertProjectGenerationAllowed(
				scope(viewer.id),
				created.id,
			),
		).rejects.toMatchObject({ code: "workspace_access_denied" });
		await prisma.workspaceMember.delete({
			where: {
				workspaceId_userId: { workspaceId: workspace.id, userId: editor.id },
			},
		});
		await expect(
			projectService.getProjectSnapshot(scope(editor.id), created.id),
		).rejects.toMatchObject({ code: "workspace_access_denied" });
		await expect(
			projectService.setProjectNotifyPreference(
				scope(editor.id),
				created.id,
				false,
			),
		).rejects.toMatchObject({ code: "workspace_access_denied" });
		await prisma.user.update({
			where: { id: viewer.id },
			data: { deletedAt: new Date() },
		});
		await expect(
			workspaceLibraryService.listProjects(scope(viewer.id)),
		).rejects.toMatchObject({ code: "workspace_access_denied" });
		expect(
			await prisma.project.findUniqueOrThrow({ where: { id: created.id } }),
		).toMatchObject({ languageCode: null, createdByUserId: editor.id });
	});

	test("foreign and inaccessible Projects expose no detail, transcript, pack or workflow state", async () => {
		const first = await fixture();
		const second = await fixture();
		const created = await project(first.scope(first.editor.id));
		await prisma.transcript.create({
			data: {
				projectId: created.id,
				status: "completed",
				text: "Private transcript",
			},
		});
		const pack = await prisma.contentPack.create({
			data: {
				projectId: created.id,
				outputTypes: ["short_clip"],
				clipCountTarget: 3,
				clipDurationSecTarget: 45,
				toneConstraints: [],
				captionPreset: "brand_default",
				platformPlaybookVersion: "test",
			},
		});
		const run = await prisma.workflowRun.create({
			data: {
				projectId: created.id,
				contentPackId: pack.id,
				stage: "stt",
				status: "queued",
				idempotencyKey: randomUUID(),
			},
		});
		const foreignScope = second.scope(second.editor.id);
		const empty = {
			project: null,
			progress: null,
			activeRun: null,
			lastSeq: 0,
			ingestAttemptCount: 0,
		};
		expect(
			await projectService.getProjectAccess(foreignScope, created.id),
		).toBe("forbidden");
		expect(
			await projectService.getProjectSnapshot(foreignScope, created.id),
		).toEqual(empty);
		expect(
			await projectService.getTranscriptSnapshot(foreignScope, created.id),
		).toBeNull();
		expect(
			await projectService.getLatestContentPack(foreignScope, created.id),
		).toBeNull();
		expect(
			await projectService.getWorkflowRun(foreignScope, created.id, run.id),
		).toEqual({ run: null, lastSeq: 0 });
		await expect(
			projectService.deleteProject(foreignScope, created.id),
		).rejects.toBeInstanceOf(ProjectAccessDeniedError);
		await expect(
			projectService.assertProjectGenerationAllowed(foreignScope, created.id),
		).rejects.toBeInstanceOf(ProjectNotFoundError);
		await expect(
			projectService.setProjectNotifyPreference(
				foreignScope,
				created.id,
				false,
			),
		).rejects.toBeInstanceOf(ProjectNotFoundError);
		expect(
			(await prisma.project.findUniqueOrThrow({ where: { id: created.id } }))
				.languageCode,
		).toBeNull();
		for (const lifecycle of [
			{ expiresAt: new Date(0) },
			{ expiresAt: null, purgeStartedAt: new Date() },
		]) {
			await prisma.project.update({
				where: { id: created.id },
				data: lifecycle,
			});
			expect(
				await projectService.getProjectSnapshot(
					first.scope(first.editor.id),
					created.id,
				),
			).toEqual(empty);
			expect(
				await projectService.getTranscriptSnapshot(
					first.scope(first.editor.id),
					created.id,
				),
			).toBeNull();
			expect(
				await projectService.getWorkflowRun(
					first.scope(first.editor.id),
					created.id,
					run.id,
				),
			).toEqual({ run: null, lastSeq: 0 });
			expect(
				(
					await workspaceLibraryService.listProjects(
						first.scope(first.editor.id),
					)
				).items,
			).toEqual([]);
		}
	});

	test("filtering and pagination operate on shared Workspace content", async () => {
		const { owner, editor, scope } = await fixture();
		await project(scope(editor.id), "Zebra interview");
		await project(scope(editor.id), "Alpha launch");
		await project(scope(owner.id), "Alpha follow-up");
		const first = await workspaceLibraryService.listProjects(scope(editor.id), {
			query: "alpha",
			sort: "title",
			limit: 1,
		});
		expect(first.items.map((row) => row.title)).toEqual(["Alpha follow-up"]);
		expect(first.totalCount).toBe(2);
		expect(first.statusCounts.all).toBe(2);
		const second = await workspaceLibraryService.listProjects(scope(owner.id), {
			query: "alpha",
			sort: "title",
			limit: 1,
			cursor: first.nextCursor,
		});
		expect(second.items.map((row) => row.title)).toEqual(["Alpha launch"]);
		expect(second.nextCursor).toBeNull();
	});

	test("a current editor can delete shared content and receives a missing result on repetition", async () => {
		const { owner, editor, viewer, scope } = await fixture();
		const created = await project(scope(owner.id));
		await expect(
			projectService.deleteProject(scope(viewer.id), created.id),
		).rejects.toMatchObject({ code: "workspace_access_denied" });
		await projectService.deleteProject(scope(editor.id), created.id);
		expect(
			await projectService.getProjectAccess(scope(owner.id), created.id),
		).toBe("missing");
		await expect(
			projectService.deleteProject(scope(editor.id), created.id),
		).rejects.toBeInstanceOf(ProjectNotFoundError);
	});

	test("removing the creator clears attribution and preserves Project and workflow history", async () => {
		const { owner, editor, scope } = await fixture();
		const created = await project(scope(editor.id));
		const run = await prisma.workflowRun.create({
			data: {
				projectId: created.id,
				stage: "stt",
				status: "completed",
				idempotencyKey: randomUUID(),
			},
		});
		await prisma.transcript.create({
			data: {
				projectId: created.id,
				status: "completed",
				text: "Retained transcript",
			},
		});
		await prisma.user.delete({ where: { id: editor.id } });
		expect(
			await prisma.project.findUniqueOrThrow({ where: { id: created.id } }),
		).toMatchObject({ createdByUserId: null });
		expect(
			(await projectService.getProjectSnapshot(scope(owner.id), created.id))
				.project?.createdByUserId,
		).toBeNull();
		expect(
			(await projectService.getWorkflowRun(scope(owner.id), created.id, run.id))
				.run?.workflowRunId,
		).toBe(run.id);
		expect(
			(await projectService.getTranscriptSnapshot(scope(owner.id), created.id))
				?.text,
		).toBe("Retained transcript");
		await projectService.assertProjectGenerationAllowedForWorker(
			created.id,
			scope(owner.id).workspaceId,
		);
	});

	test("owner deletion is explicit and an ownership transfer preserves existing content", async () => {
		const { owner, editor, workspace, scope } = await fixture();
		const created = await project(scope(owner.id));
		const run = await prisma.workflowRun.create({
			data: {
				projectId: created.id,
				stage: "stt",
				status: "completed",
				idempotencyKey: randomUUID(),
			},
		});
		await expect(
			Promise.resolve(prisma.user.delete({ where: { id: owner.id } })),
		).rejects.toMatchObject({ code: "P2003" });
		expect(await prisma.project.count({ where: { id: created.id } })).toBe(1);
		await prisma.$transaction([
			prisma.workspace.update({
				where: { id: workspace.id },
				data: { ownerUserId: editor.id },
			}),
			prisma.workspaceMember.update({
				where: {
					workspaceId_userId: { workspaceId: workspace.id, userId: owner.id },
				},
				data: { role: "editor" },
			}),
			prisma.workspaceMember.update({
				where: {
					workspaceId_userId: { workspaceId: workspace.id, userId: editor.id },
				},
				data: { role: "owner" },
			}),
		]);
		await prisma.user.delete({ where: { id: owner.id } });
		expect(
			(await projectService.getProjectSnapshot(scope(editor.id), created.id))
				.project?.createdByUserId,
		).toBeNull();
		expect(
			(
				await projectService.getWorkflowRun(
					scope(editor.id),
					created.id,
					run.id,
				)
			).run?.workflowRunId,
		).toBe(run.id);
		expect(
			(await workspaceService.requireActor(editor.id, workspace.id))
				.workspaceOwnerUserId,
		).toBe(editor.id);
		await prisma.workspace.update({
			where: { id: workspace.id },
			data: { status: "restricted" },
		});
		await expect(
			projectService.assertProjectGenerationAllowedForWorker(
				created.id,
				workspace.id,
			),
		).rejects.toBeInstanceOf(ProjectAccessDeniedError);
	});

	test("a personal owner cannot be deleted while the personal Workspace still exists", async () => {
		const { owner, editor, workspace } = await fixture();
		await prisma.workspace.update({
			where: { id: workspace.id },
			data: { personalOwnerUserId: owner.id, ownerUserId: editor.id },
		});
		await expect(
			Promise.resolve(prisma.user.delete({ where: { id: owner.id } })),
		).rejects.toMatchObject({ code: "P2003" });
		expect(await prisma.workspace.count({ where: { id: workspace.id } })).toBe(
			1,
		);
	});

	test("bound Content Packs never fall through to a newer, foreign, draft or missing pack", async () => {
		const { editor, scope } = await fixture();
		const created = await project(scope(editor.id));
		const foreign = await project(scope(editor.id), "Different project");
		const settings = contentPackSchema.parse({
			outputTypes: ["short_clip"],
			clipCountTarget: 4,
			clipDurationSecTarget: 45,
			captionPreset: "brand_default",
			platformPlaybookVersion: "binding-test",
		});
		const bound = await prisma.contentPack.create({
			data: { projectId: created.id, ...settings },
		});
		const run = await prisma.workflowRun.create({
			data: {
				projectId: created.id,
				contentPackId: bound.id,
				stage: "moment_detection",
				status: "completed",
				idempotencyKey: randomUUID(),
			},
		});
		await prisma.contentPack.create({
			data: {
				projectId: created.id,
				...settings,
				clipCountTarget: 9,
				createdAt: new Date(Date.now() + 1_000),
			},
		});
		expect((await projectService.getContentPackForRun(run))?.id).toBe(bound.id);
		const draft = await prisma.contentPack.create({
			data: { projectId: created.id, ...settings, draft: true },
		});
		const foreignPack = await prisma.contentPack.create({
			data: { projectId: foreign.id, ...settings },
		});
		for (const contentPackId of [
			draft.id,
			foreignPack.id,
			randomUUID(),
			null,
		]) {
			expect(
				await projectService.getContentPackForRun({
					projectId: created.id,
					contentPackId,
				}),
			).toBeNull();
		}
		await prisma.contentPack.delete({ where: { id: bound.id } });
		expect(await projectService.getContentPackForRun(run)).toBeNull();
	});

	test("draft, configure, fresh generation and RSS writes preserve every canonical Content Pack setting", async () => {
		const { editor, scope } = await fixture();
		const actor = scope(editor.id);
		const created = await project(actor);
		await prisma.project.update({
			where: { id: created.id },
			data: { ingestStatus: "queued" },
		});
		const settings = contentPackSchema.parse({
			outputTypes: ["short_clip"],
			clipGenerationMode: "best",
			clipCountTarget: 7,
			clipDurationSecTarget: 90,
			minDurationSec: 55,
			preferredMinDurationSec: 60,
			preferredMaxDurationSec: 120,
			maxDurationSec: 130,
			platformTargets: ["facebook_reels"],
			toneConstraints: ["concise"],
			captionPreset: "brand_default",
			platformPlaybookVersion: "roundtrip-test",
			mode: "caption_only",
			autoHook: false,
			specificMoments: "Closing argument",
			processingStartSec: 10,
			processingEndSec: 200,
			clipLengthPreset: "60_to_120s",
			defaultAspectRatio: "4:5",
		});
		const metadata = {
			...settings,
			id: randomUUID(),
			projectId: randomUUID(),
			draft: false,
			createdAt: new Date(0),
		};
		expect(
			await projectService.saveGenerationDraft(
				actor,
				created.id,
				metadata,
				"en",
			),
		).toBe(true);
		const draft = await prisma.contentPack.findFirstOrThrow({
			where: { projectId: created.id },
		});
		expect(parseStoredContentPack(draft)).toEqual(settings);
		expect(draft).toMatchObject({ projectId: created.id, draft: true });
		expect(draft.id).not.toBe(metadata.id);
		expect(
			await projectService.finalizeGenerationSetup(
				actor,
				created.id,
				metadata,
				"fr",
			),
		).toMatchObject({ started: false });
		const committed = await prisma.contentPack.findUniqueOrThrow({
			where: { id: draft.id },
		});
		expect(committed.draft).toBe(false);
		expect(parseStoredContentPack(committed)).toEqual(settings);
		const ready = await project(actor, "Fresh admission");
		const admission = await projectService.triggerGeneration(
			actor,
			ready.id,
			{ contentPack: metadata, forceRegenerate: true, languageCode: "en" },
			randomUUID(),
		);
		const run = await prisma.workflowRun.findUniqueOrThrow({
			where: { id: admission.workflowRunId },
		});
		expect(
			parseStoredContentPack(await projectService.getContentPackForRun(run)),
		).toEqual(settings);
		const rss = await projectService.importResolvedRssEpisodes(
			actor,
			{
				rssUrl: "https://example.test/feed.xml",
				episodes: [
					{
						id: "episode-one",
						title: "RSS episode",
						enclosureUrl: "https://example.test/rss.mp4",
						durationSeconds: 300,
						publishedAt: null,
					},
				],
			},
			{ generationContext: { contentPack: metadata, languageCode: "en" } },
		);
		const rssPack = await prisma.contentPack.findFirstOrThrow({
			where: { projectId: rss.projects[0]!.project.id },
		});
		expect(parseStoredContentPack(rssPack)).toEqual(settings);
		expect(rssPack.draft).toBe(false);
	});

	test("equal-time terminal runs select the same id in library, detail and ingest progress", async () => {
		const { editor, scope } = await fixture();
		const actor = scope(editor.id);
		const created = await project(actor);
		const updatedAt = new Date("2026-10-01T00:00:00.000Z");
		await prisma.workflowRun.createMany({
			data: [
				{
					id: "10000000-0000-4000-8000-000000000011",
					projectId: created.id,
					stage: "moment_detection",
					status: "completed",
					updatedAt,
					idempotencyKey: randomUUID(),
				},
				{
					id: "10000000-0000-4000-8000-000000000022",
					projectId: created.id,
					stage: "dubbing",
					status: "failed",
					updatedAt,
					idempotencyKey: randomUUID(),
				},
			],
		});
		const page = await workspaceLibraryService.listProjects(actor, {
			status: "failed",
		});
		const detail = await projectService.getProjectSnapshot(actor, created.id);
		const ingest = await projectService.getIngestSnapshot(actor, created.id);
		expect(detail.activeRun?.workflowRunId).toBe(
			"10000000-0000-4000-8000-000000000022",
		);
		expect(ingest?.activeRun?.workflowRunId).toBe(
			detail.activeRun?.workflowRunId,
		);
		expect(page.statusCounts.failed).toBe(1);
		expect(detail.progress).toEqual({
			status: "failed",
			label: "Dubbing failed",
			active: false,
		});
		expect(page.items[0]?.progress).toEqual(detail.progress);
		expect(ingest?.progress).toEqual(detail.progress);
	});
});
