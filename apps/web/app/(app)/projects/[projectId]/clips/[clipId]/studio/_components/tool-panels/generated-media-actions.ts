import type {
	EditorAction,
	GeneratedMediaEditorInsertionResult,
} from "@narriflow/validators";

export interface GeneratedMediaInsertionAsset {
	jobId: string;
	assetId: string;
	fingerprint: string;
	kind: "image" | "video";
	durationSec: number | null;
}

export interface GeneratedMediaSubmissionIdentity {
	signature: string;
	idempotencyKey: string;
}

export function resolveGeneratedMediaSubmissionIdentity(input: {
	previous: GeneratedMediaSubmissionIdentity | null;
	signature: string;
	createIdempotencyKey: () => string;
}): GeneratedMediaSubmissionIdentity {
	if (input.previous?.signature === input.signature) return input.previous;
	return {
		signature: input.signature,
		idempotencyKey: input.createIdempotencyKey(),
	};
}

export type GeneratedMediaInsertionIntent =
	| {
			kind: "broll";
			jobId: string;
			startSec: number;
			endSec: number;
			replacePlacementId: string | null;
	  }
	| {
			kind: "scene_block";
			jobId: string;
			anchorSec: number;
			durationSec: number;
	  };

export type GeneratedMediaEditorAction = Extract<
	EditorAction,
	{
		type:
			| "insertBrollPlacement"
			| "replaceBrollPlacement"
			| "insertSceneBlock";
	}
>;

export function buildGeneratedMediaInsertionIntent(input: {
	action: "broll" | "replace_broll" | "scene_block";
	asset: GeneratedMediaInsertionAsset;
	basePlayheadSec: number;
	baseDurationSec: number;
	compositePlayheadSec: number;
	compositeDurationSec: number;
	selectedBrollPlacementId?: string | null;
}): GeneratedMediaInsertionIntent {
	if (!input.asset.assetId || !input.asset.fingerprint || !input.asset.jobId) {
		throw new Error("A finalized generated Visual Asset is required");
	}
	const sceneInsertion = input.action === "scene_block";
	const clipDurationSec = Math.max(
		0.1,
		sceneInsertion ? input.compositeDurationSec : input.baseDurationSec,
	);
	const anchorSec = Math.min(
		Math.max(
			0,
			sceneInsertion ? input.compositePlayheadSec : input.basePlayheadSec,
		),
		Math.max(0, clipDurationSec - 0.1),
	);
	const availableDuration = Math.max(0.1, clipDurationSec - anchorSec);
	const mediaDuration =
		input.asset.kind === "video"
			? Math.max(0.1, input.asset.durationSec ?? 0.1)
			: 3;
	const durationSec = Math.min(mediaDuration, availableDuration);

	if (input.action !== "scene_block") {
		if (input.action === "replace_broll" && !input.selectedBrollPlacementId) {
			throw new Error("Select a B-roll placement before replacing it");
		}
		return {
			kind: "broll",
			jobId: input.asset.jobId,
			startSec: anchorSec,
			endSec: anchorSec + durationSec,
			replacePlacementId:
				input.action === "replace_broll"
					? (input.selectedBrollPlacementId ?? null)
					: null,
		};
	}

	return {
		kind: "scene_block",
		jobId: input.asset.jobId,
		anchorSec,
		durationSec,
	};
}

export function editorActionForGeneratedMediaInsertion(
	intent: GeneratedMediaInsertionIntent,
	result: GeneratedMediaEditorInsertionResult,
): GeneratedMediaEditorAction {
	if (intent.kind === "scene_block") {
		if (result.kind !== "scene_block") {
			throw new Error("Generated media insertion kind changed");
		}
		const scene = result.document.sceneBlocks.find(
			(candidate) => candidate.id === result.targetId,
		);
		if (!scene) throw new Error("Inserted Scene Block is missing");
		return { type: "insertSceneBlock", scene };
	}

	if (result.kind !== "broll") {
		throw new Error("Generated media insertion kind changed");
	}
	const placement = result.document.brollPlacements.find(
		(candidate) => candidate.id === result.targetId,
	);
	if (
		!placement ||
		placement.asset.id !== result.asset.id ||
		placement.asset.fingerprint !== result.asset.fingerprint ||
		placement.mediaKind !== result.asset.kind ||
		placement.provenance !== result.asset.provenance
	) {
		throw new Error("Inserted B-roll identity is inconsistent");
	}
	if (intent.replacePlacementId) {
		if (result.targetId !== intent.replacePlacementId) {
			throw new Error("Generated media replaced a different B-roll placement");
		}
		return {
			type: "replaceBrollPlacement",
			id: placement.id,
			asset: placement.asset,
			provenance: placement.provenance,
			mediaKind: placement.mediaKind,
			sourceStartSec: placement.sourceStartSec,
			sourceEndSec: placement.sourceEndSec,
		};
	}
	return { type: "insertBrollPlacement", placement };
}
