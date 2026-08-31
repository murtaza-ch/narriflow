import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import {
	DEFAULT_CAPTION_PRESET,
	editorDocumentSchema,
	studioEditsSchema,
} from "@narriflow/validators";

import {
	GeneratedMediaInsertionError,
	GeneratedMediaInsertionService,
} from "./generated-media-insertion";
import {
	createPrismaGeneratedMediaInsertionStore,
	generatedMediaInsertionAnalyticsEventId,
} from "./generated-media-insertion.prisma";

const ids = {
	actor: "00000000-0000-4000-8000-000000000001",
	workspace: "00000000-0000-4000-8000-000000000002",
	project: "00000000-0000-4000-8000-000000000003",
	clip: "00000000-0000-4000-8000-000000000004",
	job: "00000000-0000-4000-8000-000000000005",
	asset: "00000000-0000-4000-8000-000000000006",
	idempotency: "00000000-0000-4000-8000-000000000007",
	placement: "00000000-0000-4000-8000-000000000008",
};

const document = editorDocumentSchema.parse({
	version: 2,
	clipStartSec: 10,
	clipEndSec: 30,
	captionPreset: DEFAULT_CAPTION_PRESET,
	transcriptSlice: [],
	studioEdits: studioEditsSchema.parse(undefined),
	brollUrl: null,
	brollPlacements: [],
	deletedRanges: [],
	sceneBlocks: [],
	censorSegments: [],
	mediaMotions: [],
});

describe("Prisma generated-media insertion store", () => {
	test("uses one deterministic analytics identity and declares transactional delivery", () => {
		const first = generatedMediaInsertionAnalyticsEventId(
			ids.workspace,
			ids.idempotency,
		);
		expect(first).toMatch(/^[a-f0-9-]{36}$/);
		expect(generatedMediaInsertionAnalyticsEventId(
			ids.workspace,
			ids.idempotency,
		)).toBe(first);
		expect(generatedMediaInsertionAnalyticsEventId(
			crypto.randomUUID(),
			ids.idempotency,
		)).not.toBe(first);
		expect(createPrismaGeneratedMediaInsertionStore({} as PrismaClient).analyticsDelivery)
			.toBe("transactional");
	});

	test("reports the fresh tenant-scoped revision after a select/save race", async () => {
		let clipReadCount = 0;
		let analyticsCreates = 0;
		const clip = {
			id: ids.clip,
			projectId: ids.project,
			editorRevision: 3,
			editorOriginal: null,
			startSec: document.clipStartSec,
			endSec: document.clipEndSec,
			captionPreset: document.captionPreset,
			transcriptSlice: document.transcriptSlice,
			studioEdits: document.studioEdits,
			brollUrl: document.brollUrl,
			brollPlacements: document.brollPlacements,
			deletedRanges: document.deletedRanges,
			editorDocumentVersion: document.version,
			sceneBlocks: document.sceneBlocks,
			censorSegments: document.censorSegments,
			mediaMotions: document.mediaMotions,
			viralityScore: 70,
			status: "detected",
			previewStorageKey: null,
			previewStartSec: null,
			previewDurationSec: null,
			layoutAnalysis: null,
			autoLayoutAnalysis: null,
			splitLayoutAnalysis: null,
			durationOptimalityScore: 80,
			tiktokScore: 80,
			youtubeScore: 70,
			instagramScore: 75,
			project: {
				userId: ids.actor,
				workspaceId: ids.workspace,
				sourceDurationSeconds: 60,
				sourceStorageKey: `projects/${ids.project}/source.mp4`,
				transcript: { utterancesJson: [] },
			},
			renders: [],
		};
		const generatedMediaInsertion = { findUnique: async () => null };
		const fake = {
			generatedMediaInsertion,
			generatedMediaJob: {
				findFirst: async () => ({
					id: ids.job,
					workspaceId: ids.workspace,
					projectId: ids.project,
					clipId: ids.clip,
					ownerUserId: ids.actor,
					ownerWorkspaceId: null,
					kind: "image",
					status: "completed",
					resultAssetId: ids.asset,
					stagedFingerprint: "a".repeat(64),
					insertionCount: 0,
					lastInsertionKind: null,
					lastInsertedAt: null,
					resultAsset: {
						id: ids.asset,
						userId: ids.actor,
						workspaceId: null,
						kind: "image",
						fingerprint: "a".repeat(64),
						provenance: "generated",
						durationSec: null,
						deletedAt: null,
					},
				}),
			},
			clip: {
				findFirst: async () => {
					clipReadCount += 1;
					return clipReadCount === 1 ? clip : { ...clip, editorRevision: 9 };
				},
				updateMany: async () => ({ count: 0 }),
			},
			clipRender: { deleteMany: async () => ({ count: 0 }) },
			mediaCleanupObligation: {},
			projectAnalyticsEvent: {
				create: async () => {
					analyticsCreates += 1;
					return {};
				},
			},
			$transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
				operation(fake),
		} as unknown as PrismaClient;
		const service = new GeneratedMediaInsertionService({
			store: createPrismaGeneratedMediaInsertionStore(fake),
		});

		try {
			await service.insert(
				{
					actorUserId: ids.actor,
					workspaceId: ids.workspace,
					workspaceOwnerUserId: ids.actor,
					role: "owner",
					status: "active",
					pricingTier: "creator",
					isPersonalWorkspace: true,
				},
				{
					idempotencyKey: ids.idempotency,
					jobId: ids.job,
					projectId: ids.project,
					clipId: ids.clip,
					baseRevision: 3,
					action: {
						kind: "insert_broll",
						placementId: ids.placement,
						startSec: 2,
						endSec: 5,
					},
				},
			);
			throw new Error("expected revision conflict");
		} catch (error) {
			expect(error).toBeInstanceOf(GeneratedMediaInsertionError);
			expect(error).toMatchObject({
				code: "generated_media_insertion_revision_conflict",
				currentRevision: 9,
			});
		}
		expect(analyticsCreates).toBe(0);
	});

	test("inherits canonical preview and evidence invalidation inside its transaction", async () => {
		let clipUpdateData: Record<string, unknown> | null = null;
		let cleanupClasses: string[] = [];
		let analyticsTarget: { projectId: string; clipId: string | null } | null = null;
		const clip = {
			id: ids.clip,
			projectId: ids.project,
			editorRevision: 3,
			editorOriginal: null,
			startSec: document.clipStartSec,
			endSec: document.clipEndSec,
			captionPreset: document.captionPreset,
			transcriptSlice: document.transcriptSlice,
			studioEdits: document.studioEdits,
			brollUrl: document.brollUrl,
			brollPlacements: document.brollPlacements,
			deletedRanges: document.deletedRanges,
			editorDocumentVersion: document.version,
			sceneBlocks: document.sceneBlocks,
			censorSegments: document.censorSegments,
			mediaMotions: document.mediaMotions,
			viralityScore: 70,
			status: "detected",
			previewStorageKey: `projects/${ids.project}/clips/${ids.clip}/preview.mp4`,
			previewStartSec: 10,
			previewDurationSec: 20,
			layoutAnalysis: { version: 1 },
			autoLayoutAnalysis: { version: 1 },
			splitLayoutAnalysis: { version: 1 },
			durationOptimalityScore: 80,
			tiktokScore: 80,
			youtubeScore: 70,
			instagramScore: 75,
			project: {
				userId: ids.actor,
				workspaceId: ids.workspace,
				sourceDurationSeconds: 60,
				sourceStorageKey: `projects/${ids.project}/source.mp4`,
				transcript: { utterancesJson: [] },
			},
			renders: [{
				id: crypto.randomUUID(),
				storageKey: `projects/${ids.project}/renders/stale.mp4`,
			}],
		};
		const job = {
			id: ids.job,
			workspaceId: ids.workspace,
			projectId: ids.project,
			clipId: null,
			ownerUserId: ids.actor,
			ownerWorkspaceId: null,
			kind: "image",
			status: "completed",
			resultAssetId: ids.asset,
			stagedFingerprint: "a".repeat(64),
			insertionCount: 0,
			lastInsertionKind: null,
			lastInsertedAt: null,
			provider: "test-provider",
			model: "configured-model",
			createdAt: new Date("2026-08-31T11:59:00.000Z"),
			attemptCount: 1,
			moderationOutcome: "passed",
			usage: null,
			resultAsset: {
				id: ids.asset,
				userId: ids.actor,
				workspaceId: null,
				kind: "image",
				fingerprint: "a".repeat(64),
				provenance: "generated",
				durationSec: null,
				deletedAt: null,
			},
		};
		const fake = {
			generatedMediaInsertion: {
				findUnique: async () => null,
				create: async () => ({}),
			},
			generatedMediaJob: {
				findFirst: async () => job,
				update: async () => job,
			},
			clip: {
				findFirst: async () => clip,
				count: async () => 1,
				updateMany: async ({ data }: { data: Record<string, unknown> }) => {
					clipUpdateData = data;
					return { count: 1 };
				},
				findUniqueOrThrow: async () => ({
					...clip,
					editorRevision: 4,
					startSec: 12,
					endSec: 32,
					editorOriginal: document,
					previewStorageKey: null,
					previewStartSec: null,
					previewDurationSec: null,
					layoutAnalysis: null,
					autoLayoutAnalysis: null,
					splitLayoutAnalysis: null,
					renders: [],
				}),
			},
			clipRender: { deleteMany: async () => ({ count: 1 }) },
			mediaCleanupObligation: {
				createMany: async ({ data }: { data: Array<{ cleanupClass: string }> }) => {
					cleanupClasses = data.map((item) => item.cleanupClass);
					return { count: data.length };
				},
			},
			projectAnalyticsEvent: {
				create: async ({ data }: {
					data: { projectId: string; clipId: string | null };
				}) => {
					analyticsTarget = {
						projectId: data.projectId,
						clipId: data.clipId,
					};
					return {};
				},
			},
			$transaction: async (operation: (transaction: unknown) => Promise<unknown>) =>
				operation(fake),
		} as unknown as PrismaClient;
		const store = createPrismaGeneratedMediaInsertionStore(fake);

		await store.execute({
			scope: {
				actorUserId: ids.actor,
				workspaceId: ids.workspace,
				workspaceOwnerUserId: ids.actor,
				role: "owner",
				status: "active",
				pricingTier: "creator",
				isPersonalWorkspace: true,
			},
			request: {
				idempotencyKey: ids.idempotency,
				jobId: ids.job,
				projectId: ids.project,
				clipId: ids.clip,
				baseRevision: 3,
				action: {
					kind: "insert_broll",
					placementId: ids.placement,
					startSec: 2,
					endSec: 5,
				},
			},
			requestFingerprint: "b".repeat(64),
			now: new Date("2026-08-31T12:00:00.000Z"),
			plan: (snapshot) => ({
				kind: "broll",
				targetId: ids.placement,
				nextDocument: {
					...snapshot.clip.document,
					clipStartSec: 12,
					clipEndSec: 32,
				},
			}),
		});

		expect(clipUpdateData).toMatchObject({
			previewStorageKey: null,
			layoutAnalysis: expect.anything(),
			autoLayoutAnalysis: expect.anything(),
			splitLayoutAnalysis: expect.anything(),
		});
		expect(cleanupClasses.sort()).toEqual([
			"mutable_render",
			"preview_peaks",
			"preview_proxy",
		]);
		expect(analyticsTarget).toEqual({
			projectId: ids.project,
			clipId: ids.clip,
		});
	});
});
