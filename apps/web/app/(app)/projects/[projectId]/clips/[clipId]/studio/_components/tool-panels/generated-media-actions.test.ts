import { describe, expect, test } from "bun:test";

import {
	buildGeneratedMediaInsertionIntent,
	editorActionForGeneratedMediaInsertion,
	resolveGeneratedMediaSubmissionIdentity,
} from "./generated-media-actions";

describe("generated media insertion intents", () => {
	test("reuses an idempotency key only while retrying the same generation draft", () => {
		let nextKey = 0;
		const createIdempotencyKey = () => `key-${++nextKey}`;
		const first = resolveGeneratedMediaSubmissionIdentity({
			previous: null,
			signature: "draft-a",
			createIdempotencyKey,
		});
		const retry = resolveGeneratedMediaSubmissionIdentity({
			previous: first,
			signature: "draft-a",
			createIdempotencyKey,
		});
		const edited = resolveGeneratedMediaSubmissionIdentity({
			previous: retry,
			signature: "draft-b",
			createIdempotencyKey,
		});

		expect(retry).toEqual(first);
		expect(edited.idempotencyKey).not.toBe(first.idempotencyKey);
		expect(nextKey).toBe(2);
	});

	test("builds an explicit image Scene Block at the playhead", () => {
		expect(
			buildGeneratedMediaInsertionIntent({
				action: "scene_block",
				basePlayheadSec: 4.25,
				baseDurationSec: 20,
				compositePlayheadSec: 4.25,
				compositeDurationSec: 20,
				asset: {
					jobId: "job-1",
					assetId: "asset-1",
					fingerprint: "fingerprint-1",
					kind: "image",
					durationSec: null,
				},
			}),
		).toEqual({
			kind: "scene_block",
			jobId: "job-1",
			anchorSec: 4.25,
			durationSec: 3,
		});
	});

	test("uses the visible composite playhead for a Scene after inserted footage", () => {
		expect(
			buildGeneratedMediaInsertionIntent({
				action: "scene_block",
				basePlayheadSec: 4.25,
				baseDurationSec: 20,
				compositePlayheadSec: 7.25,
				compositeDurationSec: 23,
				asset: {
					jobId: "job-1",
					assetId: "asset-1",
					fingerprint: "fingerprint-1",
					kind: "image",
					durationSec: null,
				},
			}),
		).toEqual({
			kind: "scene_block",
			jobId: "job-1",
			anchorSec: 7.25,
			durationSec: 3,
		});
	});

	test("bounds video B-roll to the available timeline without making it source media", () => {
		expect(
			buildGeneratedMediaInsertionIntent({
				action: "broll",
				basePlayheadSec: 8,
				baseDurationSec: 10,
				compositePlayheadSec: 11,
				compositeDurationSec: 13,
				asset: {
					jobId: "job-2",
					assetId: "asset-2",
					fingerprint: "fingerprint-2",
					kind: "video",
					durationSec: 6,
				},
			}),
		).toEqual({
			kind: "broll",
			jobId: "job-2",
			startSec: 8,
			endSec: 10,
			replacePlacementId: null,
		});
	});

	test("keeps replacement explicit", () => {
		const intent = buildGeneratedMediaInsertionIntent({
			action: "replace_broll",
			basePlayheadSec: 2,
			baseDurationSec: 12,
			compositePlayheadSec: 5,
			compositeDurationSec: 15,
			selectedBrollPlacementId: "00000000-0000-4000-8000-000000000009",
			asset: {
				jobId: "job-3",
				assetId: "asset-3",
				fingerprint: "fingerprint-3",
				kind: "image",
				durationSec: null,
			},
		});
		expect(intent).toMatchObject({
			kind: "broll",
			replacePlacementId: "00000000-0000-4000-8000-000000000009",
		});
	});

	test("derives the adopted edit from the server document and exact target", () => {
		const placementId = "00000000-0000-4000-8000-000000000009";
		const assetId = "00000000-0000-4000-8000-000000000010";
		const fingerprint = "a".repeat(64);
		const placement = {
			id: placementId,
			asset: { kind: "visual_asset" as const, id: assetId, fingerprint },
			provenance: "generated" as const,
			mediaKind: "image" as const,
			startSec: 2,
			endSec: 5,
			sourceStartSec: null,
			sourceEndSec: null,
		};
		const action = editorActionForGeneratedMediaInsertion(
			{
				kind: "broll",
				jobId: "job-1",
				startSec: 2,
				endSec: 5,
				replacePlacementId: null,
			},
			{
				revision: 4,
				document: {
					version: 2,
					clipStartSec: 0,
					clipEndSec: 10,
					captionPreset: {} as never,
					transcriptSlice: [],
					studioEdits: {} as never,
					brollUrl: null,
					brollPlacements: [placement],
					deletedRanges: [],
					sceneBlocks: [],
					censorSegments: [],
					mediaMotions: [],
				},
				kind: "broll",
				targetId: placementId,
				asset: {
					id: assetId,
					fingerprint,
					provenance: "generated",
					kind: "image",
				},
				replayed: false,
			},
		);
		expect(action).toEqual({ type: "insertBrollPlacement", placement });
	});
});
