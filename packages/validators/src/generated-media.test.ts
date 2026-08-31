import { describe, expect, test } from "bun:test";

import {
	generatedMediaBrollPlaybackSchema,
	generatedMediaEditorInsertionSchema,
	generatedMediaAutomationSubmitSchema,
	generatedMediaStudioSubmitSchema,
	generatedMediaStudioListResultSchema,
	generatedMediaSubmitSchema,
} from "./generated-media";

const clipId = "00000000-0000-4000-8000-000000000003";
const request = {
	idempotencyKey: "00000000-0000-4000-8000-000000000001",
	projectId: "00000000-0000-4000-8000-000000000002",
	clipId,
	kind: "image" as const,
	prompt: "A quiet studio",
	derivedContext: "The speaker describes a calm morning.",
	promptOrigin: {
		kind: "transcript_selection" as const,
		sourceIds: [`clip:${clipId}:transcript:utterance-4`],
	},
	aspectRatio: "9:16" as const,
	style: "editorial" as const,
	durationSec: null,
	seed: null,
	title: null,
};

describe("generated media request validation", () => {
	test("accepts only sanitized Studio job, asset-state, and usage projections", () => {
		const result = {
			jobs: [{
				id: "00000000-0000-4000-8000-000000000010",
				kind: "image",
				status: "reconciliation_required",
				aspectRatio: "9:16",
				style: "editorial",
				durationSec: null,
				insertionCount: 0,
				lastInsertionKind: null,
				lastInsertedAt: null,
				errorCode: "generated_media_provider_outcome_unknown",
				moderationOutcome: "pending",
				createdAt: "2026-08-31T12:00:00.000Z",
				updatedAt: "2026-08-31T12:01:00.000Z",
				assetAvailability: "not_ready",
				savedToActiveBrandProfile: false,
				asset: null,
			}],
			capabilities: {
				imageAvailable: true,
				videoAvailable: false,
				supportedImageRatios: ["9:16"],
				supportedVideoRatios: [],
				supportedVideoDurations: [],
			},
			activeBrandProfile: null,
			usage: {
				image: {
					policy: "trial_metered",
					allowance: {
						period: "lifetime",
						limitUnits: 1,
						committedUnits: 1,
						availableUnits: 0,
						resetsAt: null,
					},
					dailyAbuse: {
						limitUnits: 40,
						admittedUnits: 1,
						availableUnits: 39,
						resetsAt: "2026-09-01T00:00:00.000Z",
					},
					settlement: {
						reservedUnits: 1,
						finalizedUnits: 0,
						releasedUnits: 0,
					},
				},
				video: {
					policy: "metered",
					allowance: {
						period: "calendar_day_utc",
						limitUnits: 60,
						committedUnits: 0,
						availableUnits: 60,
						resetsAt: "2026-09-01T00:00:00.000Z",
					},
					dailyAbuse: {
						limitUnits: 120,
						admittedUnits: 0,
						availableUnits: 120,
						resetsAt: "2026-09-01T00:00:00.000Z",
					},
					settlement: {
						reservedUnits: 0,
						finalizedUnits: 0,
						releasedUnits: 0,
					},
				},
			},
		};
		expect(generatedMediaStudioListResultSchema.safeParse(result).success).toBe(true);
		expect(generatedMediaStudioListResultSchema.safeParse({
			...result,
			jobs: [{ ...result.jobs[0], providerPayload: { prompt: "secret" } }],
		}).success).toBe(false);
	});

	test("binds playback reads to an exact immutable document reference", () => {
		const playback = {
			projectId: request.projectId,
			clipId,
			assetId: "00000000-0000-4000-8000-000000000013",
			fingerprint: "a".repeat(64),
			mediaKind: "image" as const,
		};
		expect(generatedMediaBrollPlaybackSchema.safeParse(playback).success).toBe(true);
		expect(
			generatedMediaBrollPlaybackSchema.safeParse({
				...playback,
				fingerprint: "not-a-fingerprint",
			}).success,
		).toBe(false);
		expect(
			generatedMediaBrollPlaybackSchema.safeParse({
				...playback,
				accessUrl: "https://attacker.invalid/persisted.mp4",
			}).success,
		).toBe(false);
	});

	test("accepts only high-level idempotent editor insertion commands", () => {
		const insertion = {
			idempotencyKey: "00000000-0000-4000-8000-000000000010",
			jobId: "00000000-0000-4000-8000-000000000011",
			projectId: request.projectId,
			clipId,
			baseRevision: 3,
			action: {
				kind: "insert_broll" as const,
				placementId: "00000000-0000-4000-8000-000000000012",
				startSec: 3,
				endSec: 6,
			},
		};
		expect(generatedMediaEditorInsertionSchema.safeParse(insertion).success).toBe(true);
		expect(generatedMediaEditorInsertionSchema.safeParse({
			...insertion,
			assetId: "00000000-0000-4000-8000-000000000013",
		}).success).toBe(false);
		expect(generatedMediaEditorInsertionSchema.safeParse({
			...insertion,
			action: { ...insertion.action, endSec: 3 },
		}).success).toBe(false);
	});

	test("accepts prompt-source identifiers scoped to the authorized Clip", () => {
		expect(generatedMediaSubmitSchema.safeParse(request).success).toBe(true);
	});

	test("keeps public automation submissions free of asserted context and provider controls", () => {
		const publicRequest = {
			idempotencyKey: request.idempotencyKey,
			projectId: request.projectId,
			clipId: request.clipId,
			kind: request.kind,
			prompt: request.prompt,
			includeDerivedContext: true,
			promptOrigin: {
				kind: "transcript_selection" as const,
				sourceIds: [`clip:${clipId}:transcript:4:1`],
			},
			aspectRatio: request.aspectRatio,
			style: request.style,
			durationSec: null,
			title: null,
		};
		expect(generatedMediaAutomationSubmitSchema.safeParse(publicRequest).success)
			.toBe(true);
		expect(generatedMediaAutomationSubmitSchema.safeParse({
			...publicRequest,
			derivedContext: "client asserted transcript text",
		}).success).toBe(false);
		expect(generatedMediaAutomationSubmitSchema.safeParse({
			...publicRequest,
			seed: 3,
		}).success).toBe(false);
	});

	test("revision-fences derived Studio prompt sources without changing automation", () => {
		const derived = {
			idempotencyKey: request.idempotencyKey,
			projectId: request.projectId,
			clipId: request.clipId,
			kind: request.kind,
			prompt: request.prompt,
			includeDerivedContext: true,
			promptOrigin: {
				kind: "transcript_selection" as const,
				sourceIds: [`clip:${clipId}:transcript:4:1`],
			},
			aspectRatio: request.aspectRatio,
			style: request.style,
			durationSec: null,
			title: null,
		};

		expect(generatedMediaStudioSubmitSchema.safeParse(derived).success).toBe(false);
		expect(generatedMediaStudioSubmitSchema.safeParse({
			...derived,
			sourceRevision: 7,
		}).success).toBe(true);
		expect(generatedMediaAutomationSubmitSchema.safeParse(derived).success).toBe(true);
	});

	test("requires manual public prompts to omit derived context", () => {
		expect(generatedMediaAutomationSubmitSchema.safeParse({
			idempotencyKey: request.idempotencyKey,
			projectId: request.projectId,
			clipId: null,
			kind: "image",
			prompt: "A quiet studio",
			includeDerivedContext: false,
			promptOrigin: { kind: "manual", sourceIds: [] },
			aspectRatio: "9:16",
			style: "editorial",
			durationSec: null,
			title: null,
		}).success).toBe(true);
		expect(generatedMediaAutomationSubmitSchema.safeParse({
			idempotencyKey: request.idempotencyKey,
			projectId: request.projectId,
			clipId: null,
			kind: "image",
			prompt: "A quiet studio",
			includeDerivedContext: true,
			promptOrigin: { kind: "manual", sourceIds: [] },
			aspectRatio: "9:16",
			style: "editorial",
			durationSec: null,
			title: null,
		}).success).toBe(false);
	});

	test("rejects a prompt-source identifier from another Clip", () => {
		expect(
			generatedMediaSubmitSchema.safeParse({
				...request,
				promptOrigin: {
					...request.promptOrigin,
					sourceIds: [
						"clip:00000000-0000-4000-8000-000000000099:transcript:utterance-4",
					],
				},
			}).success,
		).toBe(false);
	});

	test("rejects B-roll identifiers presented as transcript provenance", () => {
		expect(
			generatedMediaSubmitSchema.safeParse({
				...request,
				promptOrigin: {
					...request.promptOrigin,
					sourceIds: [`clip:${clipId}:broll:cue-1`],
				},
			}).success,
		).toBe(false);
	});

	test("keeps manual provenance free of derived source identifiers", () => {
		expect(
			generatedMediaSubmitSchema.safeParse({
				...request,
				promptOrigin: { kind: "manual", sourceIds: ["external-source"] },
			}).success,
		).toBe(false);
	});
});
