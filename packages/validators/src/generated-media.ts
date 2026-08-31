import { z } from "zod";
import { editorDocumentSchema } from "./editor-document";

export const generatedMediaKindSchema = z.enum(["image", "video"]);
export const generatedMediaAspectRatioSchema = z.enum(["9:16", "1:1", "16:9", "4:5"]);
export const generatedMediaStyleSchema = z.enum([
	"photographic",
	"editorial",
	"illustrated",
	"graphic",
	"minimal",
]);
export const generatedMediaPromptOriginSchema = z
	.strictObject({
		kind: z.enum(["manual", "transcript_selection", "broll_cue"]),
		sourceIds: z.array(z.string().trim().min(1).max(160)).max(64).default([]),
	})
	.superRefine((origin, context) => {
		if (origin.kind !== "manual" && origin.sourceIds.length === 0) {
			context.addIssue({
				code: "custom",
				path: ["sourceIds"],
				message: "Prompt-derived generation requires at least one source identifier",
			});
		}
		if (origin.kind === "manual" && origin.sourceIds.length > 0) {
			context.addIssue({
				code: "custom",
				path: ["sourceIds"],
				message: "Manual generation cannot claim derived prompt sources",
			});
		}
	});

const generatedMediaRequestShape = {
	idempotencyKey: z.string().uuid(),
	projectId: z.string().uuid(),
	clipId: z.string().uuid().nullable().default(null),
	kind: generatedMediaKindSchema,
	prompt: z.string().trim().min(1).max(4_000),
	promptOrigin: generatedMediaPromptOriginSchema,
	aspectRatio: generatedMediaAspectRatioSchema,
	style: generatedMediaStyleSchema,
	durationSec: z.number().finite().positive().max(120).nullable().default(null),
	title: z.string().trim().min(1).max(160).nullable().default(null),
} as const;

const generatedMediaResolvedSubmitBaseSchema = z.strictObject({
	...generatedMediaRequestShape,
	derivedContext: z.string().trim().min(1).max(4_000).nullable().default(null),
});

const generatedMediaPublicSubmitBaseSchema = z.strictObject({
	...generatedMediaRequestShape,
	includeDerivedContext: z.boolean().default(true),
});

function refineGeneratedMediaRequest(
	request: Pick<
		z.output<typeof generatedMediaResolvedSubmitBaseSchema>,
		"kind" | "durationSec" | "promptOrigin" | "clipId"
	>,
	context: z.RefinementCtx,
) {
		if (request.kind === "image" && request.durationSec !== null) {
			context.addIssue({
				code: "custom",
				path: ["durationSec"],
				message: "Still-image generation does not accept a duration",
			});
		}
		if (request.kind === "video" && request.durationSec === null) {
			context.addIssue({
				code: "custom",
				path: ["durationSec"],
				message: "Short-video generation requires a duration",
			});
		}
		if (request.promptOrigin.kind !== "manual" && request.clipId === null) {
			context.addIssue({
				code: "custom",
				path: ["clipId"],
				message: "Prompt-derived generation requires a Clip",
			});
		}
		if (request.promptOrigin.kind !== "manual" && request.clipId !== null) {
			const sourceKind =
				request.promptOrigin.kind === "transcript_selection"
					? "transcript"
					: "broll";
			const expectedPrefix = `clip:${request.clipId}:${sourceKind}:`;
			for (const [index, sourceId] of request.promptOrigin.sourceIds.entries()) {
				if (
					!sourceId.startsWith(expectedPrefix) ||
					sourceId.length === expectedPrefix.length
				) {
					context.addIssue({
						code: "custom",
						path: ["promptOrigin", "sourceIds", index],
						message: "Prompt source does not belong to the authorized Clip",
					});
				}
			}
		}
	}

const refinePublicGeneratedMediaRequest: Parameters<
	typeof generatedMediaPublicSubmitBaseSchema.superRefine
>[0] = (request, context) => {
	refineGeneratedMediaRequest(request, context);
	if (request.promptOrigin.kind === "manual" && request.includeDerivedContext) {
		context.addIssue({
			code: "custom",
			path: ["includeDerivedContext"],
			message: "Manual generation has no derived context to include",
		});
	}
	const suffixPattern =
		request.promptOrigin.kind === "transcript_selection"
			? /^\d+:\d+$/
			: /^\d+$/;
	if (request.promptOrigin.kind !== "manual" && request.clipId) {
		const sourceKind =
			request.promptOrigin.kind === "transcript_selection"
				? "transcript"
				: "broll";
		const prefix = `clip:${request.clipId}:${sourceKind}:`;
		for (const [index, sourceId] of request.promptOrigin.sourceIds.entries()) {
			if (!suffixPattern.test(sourceId.slice(prefix.length))) {
				context.addIssue({
					code: "custom",
					path: ["promptOrigin", "sourceIds", index],
					message: "Prompt source identifier is not an exact Clip source",
				});
			}
		}
		if (new Set(request.promptOrigin.sourceIds).size !== request.promptOrigin.sourceIds.length) {
			context.addIssue({
				code: "custom",
				path: ["promptOrigin", "sourceIds"],
				message: "Prompt source identifiers must be unique",
			});
		}
	}
};

/**
 * Public automation deliberately omits provider-tuning inputs. The shared
 * service validator still supplies the current high-level default.
 */
export const generatedMediaAutomationSubmitSchema =
	generatedMediaPublicSubmitBaseSchema.superRefine(
		refinePublicGeneratedMediaRequest,
	);

export const generatedMediaStudioSubmitSchema =
	generatedMediaPublicSubmitBaseSchema
		.extend({
			sourceRevision: z.number().int().nonnegative().nullable(),
		})
		.superRefine((request, context) => {
			refinePublicGeneratedMediaRequest(request, context);
			if (
				(request.promptOrigin.kind === "manual") !==
				(request.sourceRevision === null)
			) {
				context.addIssue({
					code: "custom",
					path: ["sourceRevision"],
					message:
						request.promptOrigin.kind === "manual"
							? "Manual generation has no source revision"
							: "Prompt-derived generation requires the reviewed Clip revision",
				});
			}
		});

export const generatedMediaSubmitSchema =
	generatedMediaResolvedSubmitBaseSchema
		.extend({
			seed: z.number().int().min(0).max(2_147_483_647).nullable().default(null),
		})
		.superRefine(refineGeneratedMediaRequest);

export const generatedMediaListSchema = z.strictObject({
	projectId: z.string().uuid(),
	clipId: z.string().uuid().nullable().optional(),
	limit: z.number().int().min(1).max(100).default(40),
});

export const generatedMediaStudioListQuerySchema = z.strictObject({
	id: z.string().uuid(),
	clipId: z.string().uuid().optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * Resolves one immutable asset reference already stored in a Clip document.
 * The short-lived access URL is server-produced and intentionally absent
 * from this request shape.
 */
export const generatedMediaBrollPlaybackSchema = z.strictObject({
	projectId: z.string().uuid(),
	clipId: z.string().uuid(),
	assetId: z.string().uuid(),
	fingerprint: z.string().regex(/^[a-f0-9]{32,128}$/i),
	mediaKind: generatedMediaKindSchema,
});

export const generatedMediaBrollPlaybackResultSchema = z
	.strictObject({
		assetId: z.string().uuid(),
		fingerprint: z.string().regex(/^[a-f0-9]{32,128}$/i),
		mediaKind: generatedMediaKindSchema,
		state: z.enum([
			"available",
			"deleted",
			"missing",
			"fingerprint_stale",
			"storage_unavailable",
		]),
		accessUrl: z.string().url().nullable(),
	})
	.superRefine((result, context) => {
		const shouldHaveAccess =
			result.state === "available" || result.state === "deleted";
		if (shouldHaveAccess !== (result.accessUrl !== null)) {
			context.addIssue({
				code: "custom",
				path: ["accessUrl"],
				message: "Playback availability and access URL must agree",
			});
		}
	});

export const generatedMediaCancelSchema = z.strictObject({
	jobId: z.string().uuid(),
});

export const generatedMediaInsertionSchema = z.strictObject({
	jobId: z.string().uuid(),
	kind: z.enum(["broll", "scene_block"]),
	clipId: z.string().uuid(),
});

const insertGeneratedBrollSchema = z
	.strictObject({
		kind: z.literal("insert_broll"),
		placementId: z.string().uuid(),
		startSec: z.number().finite().nonnegative(),
		endSec: z.number().finite().positive(),
	})
	.refine((action) => action.endSec > action.startSec, {
		path: ["endSec"],
		message: "endSec must be greater than startSec",
	});

export const generatedMediaEditorInsertionSchema = z.strictObject({
	idempotencyKey: z.string().uuid(),
	jobId: z.string().uuid(),
	projectId: z.string().uuid(),
	clipId: z.string().uuid(),
	baseRevision: z.number().int().nonnegative(),
	action: z.union([
		insertGeneratedBrollSchema,
		z.strictObject({
			kind: z.literal("replace_broll"),
			targetPlacementId: z.string().uuid(),
		}),
		z.strictObject({
			kind: z.literal("insert_scene_block"),
			sceneBlockId: z.string().uuid(),
			anchorSec: z.number().finite().nonnegative(),
			durationSec: z.number().finite().min(0.1).max(120),
		}),
	]),
});

export const generatedMediaEditorInsertionResultSchema = z.strictObject({
	revision: z.number().int().nonnegative(),
	document: editorDocumentSchema,
	kind: z.enum(["broll", "scene_block"]),
	targetId: z.string().uuid(),
	asset: z.strictObject({
		id: z.string().uuid(),
		fingerprint: z.string().regex(/^[a-f0-9]{32,128}$/i),
		provenance: z.enum(["uploaded", "generated", "extracted"]),
		kind: generatedMediaKindSchema,
	}),
	replayed: z.boolean(),
});

export const generatedMediaJobStatusSchema = z.enum([
	"queued",
	"running",
	"waiting",
	"reconciliation_required",
	"completed",
	"failed",
	"rejected",
	"cancelled",
]);

export const generatedMediaStudioAssetAvailabilitySchema = z.enum([
	"available",
	"deleted",
	"missing",
	"storage_unavailable",
	"not_ready",
]);

export const generatedMediaStudioAssetSchema = z.strictObject({
	jobId: z.string().uuid(),
	assetId: z.string().uuid(),
	fingerprint: z.string().regex(/^[a-f0-9]{32,128}$/i),
	provenance: z.enum(["uploaded", "generated", "extracted"]),
	kind: generatedMediaKindSchema,
	durationSec: z.number().finite().positive().nullable(),
	title: z.string().trim().min(1).max(160),
	accessUrl: z.string().url(),
});

export const generatedMediaDownloadResultSchema = z.strictObject({
	accessUrl: z.string().url(),
});

export const generatedMediaStudioJobSchema = z.strictObject({
	id: z.string().uuid(),
	kind: generatedMediaKindSchema,
	status: generatedMediaJobStatusSchema,
	aspectRatio: generatedMediaAspectRatioSchema,
	style: generatedMediaStyleSchema,
	durationSec: z.number().finite().positive().nullable(),
	insertionCount: z.number().int().nonnegative(),
	lastInsertionKind: z.enum(["broll", "scene_block"]).nullable(),
	lastInsertedAt: z.string().datetime().nullable(),
	errorCode: z.string().trim().min(1).max(160).nullable(),
	moderationOutcome: z.enum(["pending", "passed", "rejected"]),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	assetAvailability: generatedMediaStudioAssetAvailabilitySchema,
	savedToActiveBrandProfile: z.boolean(),
	asset: generatedMediaStudioAssetSchema.nullable(),
}).superRefine((job, context) => {
	if ((job.assetAvailability === "available") !== (job.asset !== null)) {
		context.addIssue({
			code: "custom",
			path: ["asset"],
			message: "Only an available job result may expose an access URL",
		});
	}
});

const generationUsageAvailabilitySchema = z.strictObject({
	policy: z.enum(["trial_metered", "metered"]),
	allowance: z.strictObject({
		period: z.enum(["lifetime", "calendar_day_utc"]),
		limitUnits: z.number().int().nonnegative(),
		committedUnits: z.number().int().nonnegative(),
		availableUnits: z.number().int().nonnegative(),
		resetsAt: z.string().datetime().nullable(),
	}),
	dailyAbuse: z.strictObject({
		limitUnits: z.number().int().nonnegative(),
		admittedUnits: z.number().int().nonnegative(),
		availableUnits: z.number().int().nonnegative(),
		resetsAt: z.string().datetime(),
	}),
	settlement: z.strictObject({
		reservedUnits: z.number().int().nonnegative(),
		finalizedUnits: z.number().int().nonnegative(),
		releasedUnits: z.number().int().nonnegative(),
	}),
});

export const generatedMediaStudioListResultSchema = z.strictObject({
	jobs: z.array(generatedMediaStudioJobSchema),
	capabilities: z.strictObject({
		imageAvailable: z.boolean(),
		videoAvailable: z.boolean(),
		supportedImageRatios: z.array(generatedMediaAspectRatioSchema),
		supportedVideoRatios: z.array(generatedMediaAspectRatioSchema),
		supportedVideoDurations: z.array(z.number().finite().positive()),
	}),
	activeBrandProfile: z.strictObject({
		id: z.string().uuid(),
		name: z.string().trim().min(1).max(160),
	}).nullable(),
	usage: z.strictObject({
		image: generationUsageAvailabilitySchema,
		video: generationUsageAvailabilitySchema,
	}),
});

export type GeneratedMediaKind = z.infer<typeof generatedMediaKindSchema>;
export type GeneratedMediaAspectRatio = z.infer<typeof generatedMediaAspectRatioSchema>;
export type GeneratedMediaStyle = z.infer<typeof generatedMediaStyleSchema>;
export type GeneratedMediaPromptOrigin = z.infer<typeof generatedMediaPromptOriginSchema>;
export type GeneratedMediaSubmitInput = z.input<typeof generatedMediaSubmitSchema>;
export type GeneratedMediaSubmit = z.output<typeof generatedMediaSubmitSchema>;
export type GeneratedMediaAutomationSubmit = z.output<
	typeof generatedMediaAutomationSubmitSchema
>;
export type GeneratedMediaStudioSubmitInput = z.input<
	typeof generatedMediaStudioSubmitSchema
>;
export type GeneratedMediaStudioSubmit = z.output<
	typeof generatedMediaStudioSubmitSchema
>;
export type GeneratedMediaListInput = z.input<typeof generatedMediaListSchema>;
export type GeneratedMediaBrollPlaybackInput = z.input<
	typeof generatedMediaBrollPlaybackSchema
>;
export type GeneratedMediaBrollPlaybackResult = z.output<
	typeof generatedMediaBrollPlaybackResultSchema
>;
export type GeneratedMediaInsertionInput = z.input<typeof generatedMediaInsertionSchema>;
export type GeneratedMediaEditorInsertionInput = z.input<
	typeof generatedMediaEditorInsertionSchema
>;
export type GeneratedMediaEditorInsertion = z.output<
	typeof generatedMediaEditorInsertionSchema
>;
export type GeneratedMediaEditorInsertionResult = z.output<
	typeof generatedMediaEditorInsertionResultSchema
>;
export type GeneratedMediaJobStatus = z.output<
	typeof generatedMediaJobStatusSchema
>;
export type GeneratedMediaStudioAssetAvailability = z.output<
	typeof generatedMediaStudioAssetAvailabilitySchema
>;
export type GeneratedMediaStudioAsset = z.output<
	typeof generatedMediaStudioAssetSchema
>;
export type GeneratedMediaDownloadResult = z.output<
	typeof generatedMediaDownloadResultSchema
>;
export type GeneratedMediaStudioJob = z.output<
	typeof generatedMediaStudioJobSchema
>;
export type GeneratedMediaStudioListResult = z.output<
	typeof generatedMediaStudioListResultSchema
>;
