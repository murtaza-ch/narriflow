import { createHash } from "node:crypto";

import {
	applyEditorAction,
	editorDocumentSchema,
	generatedMediaEditorInsertionSchema,
	resolvePricingTier,
	workspaceAllowsCapability,
	type EditorDocument,
	type GeneratedMediaEditorInsertion,
	type GeneratedMediaEditorInsertionInput,
} from "@narriflow/validators";

import type { BrandActorScope } from "./brand-ownership";
import type { GeneratedMediaEventSink, GeneratedMediaJobStatus } from "./generated-media";
import { hasFeature } from "./plan-features";
import { assertProgramWriteEnabled } from "./program-rollout";

export type GeneratedMediaInsertionErrorCode =
	| "generated_media_insertion_forbidden"
	| "generated_media_insertion_not_found"
	| "generated_media_insertion_not_ready"
	| "generated_media_insertion_asset_unavailable"
	| "generated_media_insertion_asset_too_short"
	| "generated_media_insertion_invalid"
	| "generated_media_insertion_revision_conflict"
	| "generated_media_insertion_idempotency_conflict"
	| "generated_media_insertion_scene_entitlement_required";

export class GeneratedMediaInsertionError extends Error {
	constructor(
		readonly code: GeneratedMediaInsertionErrorCode,
		readonly currentRevision?: number,
	) {
		super(code);
		this.name = "GeneratedMediaInsertionError";
	}
}

export interface GeneratedMediaInsertionJobSnapshot {
	id: string;
	workspaceId: string;
	projectId: string;
	clipId: string | null;
	ownerUserId: string | null;
	ownerWorkspaceId: string | null;
	kind: "image" | "video";
	status: GeneratedMediaJobStatus;
	resultAssetId: string | null;
	resultFingerprint: string | null;
	insertionCount: number;
	lastInsertionKind: "broll" | "scene_block" | null;
	lastInsertedAt: Date | null;
}

export interface GeneratedMediaInsertionAssetSnapshot {
	id: string;
	userId: string | null;
	workspaceId: string | null;
	kind: "image" | "video";
	fingerprint: string;
	provenance: "uploaded" | "generated" | "extracted";
	durationSec: number | null;
	deletedAt: Date | null;
}

export interface GeneratedMediaInsertionClipSnapshot {
	id: string;
	projectId: string;
	workspaceId: string;
	revision: number;
	document: EditorDocument;
	original: EditorDocument | null;
	mutableRenders: Array<{ id: string; storageKey: string | null }>;
}

export interface GeneratedMediaInsertionSnapshot {
	job: GeneratedMediaInsertionJobSnapshot;
	asset: GeneratedMediaInsertionAssetSnapshot;
	clip: GeneratedMediaInsertionClipSnapshot;
}

export interface GeneratedMediaInsertionPlan {
	kind: "broll" | "scene_block";
	targetId: string;
	nextDocument: EditorDocument;
}

export interface GeneratedMediaInsertionResult {
	revision: number;
	document: EditorDocument;
	kind: "broll" | "scene_block";
	targetId: string;
	asset: {
		id: string;
		fingerprint: string;
		provenance: "uploaded" | "generated" | "extracted";
		kind: "image" | "video";
	};
	replayed: boolean;
}

export interface GeneratedMediaInsertionStore {
	readonly analyticsDelivery?: "transactional";
	execute(input: {
		scope: BrandActorScope;
		request: GeneratedMediaEditorInsertion;
		requestFingerprint: string;
		now: Date;
		plan: (snapshot: GeneratedMediaInsertionSnapshot) => GeneratedMediaInsertionPlan;
	}): Promise<
		| (GeneratedMediaInsertionResult & {
				job: Pick<
					GeneratedMediaInsertionJobSnapshot,
					"id" | "workspaceId" | "projectId" | "clipId"
				>;
		  })
		| null
	>;
}

function requestFingerprint(request: GeneratedMediaEditorInsertion): string {
	return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function assertSnapshot(
	snapshot: GeneratedMediaInsertionSnapshot,
	request: GeneratedMediaEditorInsertion,
): void {
	if (
		snapshot.job.status !== "completed" ||
		!snapshot.job.resultAssetId ||
		snapshot.job.resultAssetId !== snapshot.asset.id
	) {
		throw new GeneratedMediaInsertionError("generated_media_insertion_not_ready");
	}
	if (
		snapshot.job.projectId !== request.projectId ||
		(snapshot.job.clipId !== null && snapshot.job.clipId !== request.clipId) ||
		snapshot.clip.projectId !== request.projectId ||
		snapshot.job.kind !== snapshot.asset.kind
	) {
		throw new GeneratedMediaInsertionError("generated_media_insertion_not_found");
	}
	if (
		snapshot.asset.deletedAt !== null ||
		(snapshot.asset.provenance !== "uploaded" &&
			snapshot.asset.provenance !== "generated") ||
		!snapshot.job.resultFingerprint ||
		snapshot.job.resultFingerprint !== snapshot.asset.fingerprint ||
		snapshot.job.ownerUserId !== snapshot.asset.userId ||
		snapshot.job.ownerWorkspaceId !== snapshot.asset.workspaceId
	) {
		throw new GeneratedMediaInsertionError(
			"generated_media_insertion_asset_unavailable",
		);
	}
	if (snapshot.clip.revision !== request.baseRevision) {
		throw new GeneratedMediaInsertionError(
			"generated_media_insertion_revision_conflict",
			snapshot.clip.revision,
		);
	}
}

function generatedAssetRef(asset: GeneratedMediaInsertionAssetSnapshot) {
	return {
		kind: "visual_asset" as const,
		id: asset.id,
		fingerprint: asset.fingerprint,
	};
}

function planInsertion(
	snapshot: GeneratedMediaInsertionSnapshot,
	request: GeneratedMediaEditorInsertion,
	assertSceneWrite: (kind: "image" | "video") => void,
): GeneratedMediaInsertionPlan {
	assertSnapshot(snapshot, request);
	const document = editorDocumentSchema.parse(snapshot.clip.document);
	const asset = snapshot.asset;
	const assetRef = generatedAssetRef(asset);
	const action = request.action;
	if (action.kind === "insert_broll") {
		const durationSec = action.endSec - action.startSec;
		if (
			asset.kind === "video" &&
			(asset.durationSec === null || asset.durationSec + 0.001 < durationSec)
		) {
			throw new GeneratedMediaInsertionError(
				"generated_media_insertion_asset_too_short",
			);
		}
		const nextDocument = applyEditorAction(document, {
			type: "insertBrollPlacement",
			placement: {
				id: action.placementId,
				asset: assetRef,
				provenance: asset.provenance,
				mediaKind: asset.kind,
				startSec: action.startSec,
				endSec: action.endSec,
				sourceStartSec: asset.kind === "video" ? 0 : null,
				sourceEndSec: asset.kind === "video" ? durationSec : null,
			},
		});
		if (nextDocument === document) {
			throw new GeneratedMediaInsertionError("generated_media_insertion_invalid");
		}
		return { kind: "broll", targetId: action.placementId, nextDocument };
	}
	if (action.kind === "replace_broll") {
		const current = document.brollPlacements.find(
			(placement) => placement.id === action.targetPlacementId,
		);
		if (!current) {
			throw new GeneratedMediaInsertionError("generated_media_insertion_invalid");
		}
		const durationSec = current.endSec - current.startSec;
		if (
			asset.kind === "video" &&
			(asset.durationSec === null || asset.durationSec + 0.001 < durationSec)
		) {
			throw new GeneratedMediaInsertionError(
				"generated_media_insertion_asset_too_short",
			);
		}
		const nextDocument = applyEditorAction(document, {
			type: "replaceBrollPlacement",
			id: current.id,
			asset: assetRef,
			provenance: asset.provenance,
			mediaKind: asset.kind,
			sourceStartSec: asset.kind === "video" ? 0 : null,
			sourceEndSec: asset.kind === "video" ? durationSec : null,
		});
		if (nextDocument === document) {
			throw new GeneratedMediaInsertionError("generated_media_insertion_invalid");
		}
		return { kind: "broll", targetId: current.id, nextDocument };
	}

	if (
		asset.kind === "video" &&
		(asset.durationSec === null || asset.durationSec + 0.001 < action.durationSec)
	) {
		throw new GeneratedMediaInsertionError(
			"generated_media_insertion_asset_too_short",
		);
	}
	assertSceneWrite(asset.kind);
	const nextDocument = applyEditorAction(document, {
		type: "insertSceneBlock",
		scene: {
			schemaVersion: 1,
			id: action.sceneBlockId,
			anchorSec: action.anchorSec,
			durationSec: action.durationSec,
			content:
				asset.kind === "video"
					? {
							kind: "video",
							asset: assetRef,
							sourceStartSec: 0,
							sourceEndSec: action.durationSec,
							fit: "cover",
							backgroundColor: "#000000",
							muted: false,
							volume: 100,
						}
					: {
							kind: "image",
							asset: assetRef,
							fit: "cover",
							backgroundColor: "#000000",
						},
			motion: { entrance: "none", exit: "none" },
			templateSnapshot: null,
		},
	});
	if (nextDocument === document) {
		throw new GeneratedMediaInsertionError("generated_media_insertion_invalid");
	}
	return { kind: "scene_block", targetId: action.sceneBlockId, nextDocument };
}

export class GeneratedMediaInsertionService {
	private readonly now: () => Date;

	constructor(
		private readonly dependencies: {
			store: GeneratedMediaInsertionStore;
			events?: GeneratedMediaEventSink;
			now?: () => Date;
			assertSceneWrite?: (kind: "image" | "video") => void;
		},
	) {
		this.now = dependencies.now ?? (() => new Date());
	}

	async insert(scope: BrandActorScope, input: GeneratedMediaEditorInsertionInput) {
		if (
			!workspaceAllowsCapability(
				{ role: scope.role, status: scope.status },
				"content.edit",
			)
		) {
			throw new GeneratedMediaInsertionError("generated_media_insertion_forbidden");
		}
		const request = generatedMediaEditorInsertionSchema.parse(input);
		if (
			request.action.kind === "insert_scene_block" &&
			!hasFeature(scope.pricingTier, "brand.scenes")
		) {
			throw new GeneratedMediaInsertionError(
				"generated_media_insertion_scene_entitlement_required",
			);
		}
		const result = await this.dependencies.store.execute({
			scope,
			request,
			requestFingerprint: requestFingerprint(request),
			now: this.now(),
			plan: (snapshot) =>
				planInsertion(snapshot, request, (kind) =>
					this.dependencies.assertSceneWrite
						? this.dependencies.assertSceneWrite(kind)
						: assertProgramWriteEnabled(
								kind === "image" ? "scene_images" : "scene_videos",
							),
				),
		});
		if (!result) {
			throw new GeneratedMediaInsertionError("generated_media_insertion_not_found");
		}
		if (!result.replayed && this.dependencies.store.analyticsDelivery !== "transactional") {
			await this.dependencies.events
				?.recordInserted({
					jobId: result.job.id,
					workspaceId: result.job.workspaceId,
					projectId: request.projectId,
					clipId: request.clipId,
					insertionAction: result.kind,
					planTier: resolvePricingTier(scope.pricingTier),
					outcome: "succeeded",
				});
		}
		const { job: _job, ...publicResult } = result;
		return publicResult;
	}
}

type InMemoryInput = {
	jobs: GeneratedMediaInsertionJobSnapshot[];
	assets: GeneratedMediaInsertionAssetSnapshot[];
	clips: GeneratedMediaInsertionClipSnapshot[];
};

export function createInMemoryGeneratedMediaInsertionStore(input: InMemoryInput) {
	const jobs = new Map(input.jobs.map((job) => [job.id, structuredClone(job)]));
	const assets = new Map(input.assets.map((asset) => [asset.id, structuredClone(asset)]));
	const clips = new Map(input.clips.map((clip) => [clip.id, structuredClone(clip)]));
	const commands = new Map<
		string,
		{
			requestFingerprint: string;
			result: Awaited<ReturnType<GeneratedMediaInsertionStore["execute"]>>;
		}
	>();
	const key = (workspaceId: string, idempotencyKey: string) =>
		`${workspaceId}:${idempotencyKey}`;

	const store: GeneratedMediaInsertionStore & {
		inspectClip(id: string): GeneratedMediaInsertionClipSnapshot | null;
		inspectJob(id: string): GeneratedMediaInsertionJobSnapshot | null;
		replaceClipDocument(id: string, document: EditorDocument): void;
	} = {
		async execute(execution) {
			const commandKey = key(
				execution.scope.workspaceId,
				execution.request.idempotencyKey,
			);
			const replay = commands.get(commandKey);
			if (replay) {
				if (replay.requestFingerprint !== execution.requestFingerprint) {
					throw new GeneratedMediaInsertionError(
						"generated_media_insertion_idempotency_conflict",
					);
				}
				return replay.result
					? { ...structuredClone(replay.result), replayed: true }
					: null;
			}
			const job = jobs.get(execution.request.jobId);
			const clip = clips.get(execution.request.clipId);
			const asset = job?.resultAssetId
				? assets.get(job.resultAssetId)
				: undefined;
			if (
				!job ||
				!clip ||
				!asset ||
				job.workspaceId !== execution.scope.workspaceId ||
				clip.workspaceId !== execution.scope.workspaceId
			) {
				return null;
			}
			const plan = execution.plan({
				job: structuredClone(job),
				asset: structuredClone(asset),
				clip: structuredClone(clip),
			});
			const revision = clip.revision + 1;
			clip.original ??= structuredClone(clip.document);
			clip.document = structuredClone(plan.nextDocument);
			clip.revision = revision;
			clip.mutableRenders = [];
			job.insertionCount += 1;
			job.lastInsertionKind = plan.kind;
			job.lastInsertedAt = execution.now;
			const result = {
				revision,
				document: structuredClone(plan.nextDocument),
				kind: plan.kind,
				targetId: plan.targetId,
				asset: {
					id: asset.id,
					fingerprint: asset.fingerprint,
					provenance: asset.provenance,
					kind: asset.kind,
				},
				replayed: false,
				job: {
					id: job.id,
					workspaceId: job.workspaceId,
					projectId: job.projectId,
					clipId: job.clipId,
				},
			};
			commands.set(commandKey, {
				requestFingerprint: execution.requestFingerprint,
				result: structuredClone(result),
			});
			return result;
		},
		inspectClip(id) {
			const clip = clips.get(id);
			return clip ? structuredClone(clip) : null;
		},
		inspectJob(id) {
			const job = jobs.get(id);
			return job ? structuredClone(job) : null;
		},
		replaceClipDocument(id, document) {
			const clip = clips.get(id);
			if (!clip) throw new Error("clip not found");
			clip.document = structuredClone(document);
		},
	};
	return store;
}
