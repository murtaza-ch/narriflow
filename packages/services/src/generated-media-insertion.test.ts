import { describe, expect, test } from "bun:test";
import {
	DEFAULT_CAPTION_PRESET,
	editorDocumentSchema,
	studioEditsSchema,
} from "@narriflow/validators";

import {
	GeneratedMediaInsertionError,
	GeneratedMediaInsertionService,
	createInMemoryGeneratedMediaInsertionStore,
} from "./generated-media-insertion";
import type { GeneratedMediaEventSink } from "./generated-media";

const ids = {
	actor: "00000000-0000-4000-8000-000000000001",
	workspace: "00000000-0000-4000-8000-000000000002",
	project: "00000000-0000-4000-8000-000000000003",
	clip: "00000000-0000-4000-8000-000000000004",
	job: "00000000-0000-4000-8000-000000000005",
	asset: "00000000-0000-4000-8000-000000000006",
	idempotency: "00000000-0000-4000-8000-000000000007",
	placement: "00000000-0000-4000-8000-000000000008",
	scene: "00000000-0000-4000-8000-000000000009",
};

const scope = {
	actorUserId: ids.actor,
	workspaceId: ids.workspace,
	workspaceOwnerUserId: ids.actor,
	role: "owner" as const,
	status: "active" as const,
	pricingTier: "creator",
	isPersonalWorkspace: true,
};

const baseDocument = editorDocumentSchema.parse({
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

function setup(options: {
	assetKind?: "image" | "video";
	assetDurationSec?: number | null;
	assetDeleted?: boolean;
	assetProvenance?: "uploaded" | "generated" | "extracted";
	assetOwnerUserId?: string | null;
	jobResultFingerprint?: string;
	assertSceneWrite?: (kind: "image" | "video") => void;
} = {}) {
	const store = createInMemoryGeneratedMediaInsertionStore({
		jobs: [{
			id: ids.job,
			workspaceId: ids.workspace,
			projectId: ids.project,
			clipId: ids.clip,
			ownerUserId: ids.actor,
			ownerWorkspaceId: null,
			kind: options.assetKind ?? "image",
			status: "completed",
			resultAssetId: ids.asset,
			resultFingerprint: options.jobResultFingerprint ?? "a".repeat(64),
			insertionCount: 0,
			lastInsertionKind: null,
			lastInsertedAt: null,
		}],
		assets: [{
			id: ids.asset,
			userId:
				options.assetOwnerUserId === undefined
					? ids.actor
					: options.assetOwnerUserId,
			workspaceId: null,
			kind: options.assetKind ?? "image",
			fingerprint: "a".repeat(64),
			provenance: options.assetProvenance ?? "generated",
			durationSec: options.assetDurationSec ?? null,
			deletedAt: options.assetDeleted ? new Date("2026-08-30T00:00:00.000Z") : null,
		}],
		clips: [{
			id: ids.clip,
			projectId: ids.project,
			workspaceId: ids.workspace,
			revision: 3,
			document: baseDocument,
			original: null,
			mutableRenders: [{
				id: "00000000-0000-4000-8000-000000000010",
				storageKey: "projects/private/render.mp4",
			}],
		}],
	});
	const insertedEvents: Array<Parameters<GeneratedMediaEventSink["recordInserted"]>[0]> = [];
	const service = new GeneratedMediaInsertionService({
		store,
		events: {
			async recordCompleted() {},
			async recordInserted(event) {
				insertedEvents.push(event);
			},
		},
		now: () => new Date("2026-08-31T12:00:00.000Z"),
		assertSceneWrite: options.assertSceneWrite ?? (() => undefined),
	});
	return { store, service, insertedEvents };
}

const insertBrollRequest = {
	idempotencyKey: ids.idempotency,
	jobId: ids.job,
	projectId: ids.project,
	clipId: ids.clip,
	baseRevision: 3,
	action: {
		kind: "insert_broll" as const,
		placementId: ids.placement,
		startSec: 3,
		endSec: 6,
	},
};

describe("GeneratedMediaInsertionService", () => {
	test("atomically inserts exact image B-roll, retires renders, and replays a lost response", async () => {
		const { service, store, insertedEvents } = setup();

		const first = await service.insert(scope, insertBrollRequest);
		const replay = await service.insert(scope, insertBrollRequest);

		expect(first).toMatchObject({
			revision: 4,
			replayed: false,
			kind: "broll",
			targetId: ids.placement,
			asset: {
				id: ids.asset,
				fingerprint: "a".repeat(64),
				provenance: "generated",
				kind: "image",
			},
		});
		expect(first.document.brollPlacements).toEqual([{
			id: ids.placement,
			asset: {
				kind: "visual_asset",
				id: ids.asset,
				fingerprint: "a".repeat(64),
			},
			provenance: "generated",
			mediaKind: "image",
			startSec: 3,
			endSec: 6,
			sourceStartSec: null,
			sourceEndSec: null,
		}]);
		expect(first.document.clipEndSec - first.document.clipStartSec).toBe(20);
		expect(replay).toEqual({ ...first, replayed: true });
		expect(store.inspectClip(ids.clip)).toMatchObject({
			revision: 4,
			original: baseDocument,
			mutableRenders: [],
		});
		expect(store.inspectJob(ids.job)).toMatchObject({
			insertionCount: 1,
			lastInsertionKind: "broll",
		});
		expect(insertedEvents).toHaveLength(1);
		expect(JSON.stringify(insertedEvents)).not.toContain("private");
	});

	test("inserts an uploaded collision but rejects an extracted collision", async () => {
		await expect(
			setup({ assetProvenance: "uploaded" }).service.insert(
				scope,
				insertBrollRequest,
			),
		).resolves.toMatchObject({
			asset: { id: ids.asset, provenance: "uploaded" },
		});
		await expect(
			setup({ assetProvenance: "extracted" }).service.insert(
				scope,
				insertBrollRequest,
			),
		).rejects.toMatchObject({
			code: "generated_media_insertion_asset_unavailable",
		});
	});

	test("rejects a stale fingerprint or owner on the exact result asset", async () => {
		await expect(
			setup({ jobResultFingerprint: "b".repeat(64) }).service.insert(
				scope,
				insertBrollRequest,
			),
		).rejects.toMatchObject({
			code: "generated_media_insertion_asset_unavailable",
		});
		await expect(
			setup({ assetOwnerUserId: crypto.randomUUID() }).service.insert(
				scope,
				insertBrollRequest,
			),
		).rejects.toMatchObject({
			code: "generated_media_insertion_asset_unavailable",
		});
	});

	test("does not duplicate a transactionally recorded insertion event at the service boundary", async () => {
		const { store } = setup();
		const insertedEvents: unknown[] = [];
		const service = new GeneratedMediaInsertionService({
			store: {
				analyticsDelivery: "transactional",
				execute: store.execute,
			},
			events: {
				async recordCompleted() {},
				async recordInserted(event) {
					insertedEvents.push(event);
				},
			},
			now: () => new Date("2026-08-31T12:00:00.000Z"),
		});

		await service.insert(scope, insertBrollRequest);
		await service.insert(scope, insertBrollRequest);
		expect(insertedEvents).toHaveLength(0);
	});

	test("rejects an idempotency key reused for a different insertion", async () => {
		const { service } = setup();
		await service.insert(scope, insertBrollRequest);

		await expect(service.insert(scope, {
			...insertBrollRequest,
			action: { ...insertBrollRequest.action, endSec: 5 },
		})).rejects.toEqual(
			expect.objectContaining({
				code: "generated_media_insertion_idempotency_conflict",
			}),
		);
	});

	test("replaces only the selected placement and preserves its bounded range", async () => {
		const { service, store } = setup({ assetKind: "video", assetDurationSec: 8 });
		store.replaceClipDocument(ids.clip, editorDocumentSchema.parse({
			...baseDocument,
			brollPlacements: [{
				id: ids.placement,
				asset: {
					kind: "visual_asset",
					id: "00000000-0000-4000-8000-000000000011",
					fingerprint: "b".repeat(64),
				},
				provenance: "uploaded",
				mediaKind: "image",
				startSec: 3,
				endSec: 6,
				sourceStartSec: null,
				sourceEndSec: null,
			}],
		}));

		const result = await service.insert(scope, {
			...insertBrollRequest,
			action: { kind: "replace_broll", targetPlacementId: ids.placement },
		});

		expect(result.document.brollPlacements[0]).toMatchObject({
			id: ids.placement,
			startSec: 3,
			endSec: 6,
			mediaKind: "video",
			sourceStartSec: 0,
			sourceEndSec: 3,
		});
	});

	test("inserts an image Scene Block that extends the composition duration", async () => {
		const { service } = setup();
		const result = await service.insert(scope, {
			...insertBrollRequest,
			action: {
				kind: "insert_scene_block",
				sceneBlockId: ids.scene,
				anchorSec: 4,
				durationSec: 3,
			},
		});

		expect(result).toMatchObject({ kind: "scene_block", targetId: ids.scene });
		expect(result.document.sceneBlocks[0]).toMatchObject({
			id: ids.scene,
			anchorSec: 4,
			durationSec: 3,
			content: { kind: "image", asset: { id: ids.asset } },
		});
		expect(
			result.document.clipEndSec - result.document.clipStartSec +
				result.document.sceneBlocks.reduce((sum, scene) => sum + scene.durationSec, 0),
		).toBe(23);
	});

	test("keeps B-roll readable/editable after downgrade but blocks new Scene insertion", async () => {
		const { service } = setup();
		await expect(
			service.insert({ ...scope, pricingTier: "free" }, {
				...insertBrollRequest,
				action: {
					kind: "insert_scene_block",
					sceneBlockId: ids.scene,
					anchorSec: 4,
					durationSec: 3,
				},
			}),
		).rejects.toMatchObject({
			code: "generated_media_insertion_scene_entitlement_required",
		});
		await expect(
			service.insert(
				{ ...scope, pricingTier: "free" },
				insertBrollRequest,
			),
		).resolves.toMatchObject({ kind: "broll" });
	});

	test("enforces the media-kind Scene rollout inside the service transaction", async () => {
		const assertedKinds: string[] = [];
		const { service } = setup({
			assertSceneWrite(kind) {
				assertedKinds.push(kind);
				throw Object.assign(new Error("disabled"), {
					code: "program_write_disabled",
				});
			},
		});
		await expect(service.insert(scope, {
			...insertBrollRequest,
			action: {
				kind: "insert_scene_block",
				sceneBlockId: ids.scene,
				anchorSec: 4,
				durationSec: 3,
			},
		})).rejects.toMatchObject({ code: "program_write_disabled" });
		expect(assertedKinds).toEqual(["image"]);
	});

	test("fails closed for workspace mismatch, stale revision, or a deleted result asset", async () => {
		const wrongWorkspace = { ...scope, workspaceId: crypto.randomUUID() };
		await expect(setup().service.insert(wrongWorkspace, insertBrollRequest)).rejects.toBeInstanceOf(
			GeneratedMediaInsertionError,
		);
		await expect(setup().service.insert(scope, {
			...insertBrollRequest,
			baseRevision: 2,
		})).rejects.toEqual(expect.objectContaining({
			code: "generated_media_insertion_revision_conflict",
			currentRevision: 3,
		}));
		await expect(setup({ assetDeleted: true }).service.insert(
			scope,
			insertBrollRequest,
		)).rejects.toEqual(expect.objectContaining({
			code: "generated_media_insertion_asset_unavailable",
		}));
	});
});
