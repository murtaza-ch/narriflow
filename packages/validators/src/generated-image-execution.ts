import { z } from "zod";
import { nativeValidationEvidenceSchema } from "./native-validation";
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const identity = {
	jobId: z.string().uuid(),
	requestId: z.string().uuid(),
	inputHash: sha,
};
const dimensions = z.enum(["9:16", "16:9", "1:1"]);
export const generatedImageCommandSchema = z.discriminatedUnion("mode", [
	z.strictObject({
		kind: z.literal("generated_image"),
		mode: z.literal("generate"),
		...identity,
		prompt: z.string().min(3).max(20000),
		aspectRatio: dimensions,
		style: z.enum(["editorial", "cinematic", "photoreal", "illustration"]),
		model: z.string().trim().min(1).max(160),
		quality: z.enum(["low", "medium", "high"]),
		maxOutputBytes: z.number().int().min(1000000).max(100000000),
	}),
	z.strictObject({
		kind: z.literal("generated_image"),
		mode: z.literal("recover"),
		...identity,
		providerRef: z.string().min(1).max(2048),
		maxOutputBytes: z.number().int().min(1000000).max(100000000),
		expected: z.strictObject({
			sha256: sha,
			byteLength: z.number().int().positive().max(100000000),
			contentType: z.literal("image/png"),
		}),
	}),
]);
const code = z.enum([
	"generated_media_provider_not_configured",
	"generated_media_provider_validation",
	"generated_media_provider_rate_limited",
	"generated_media_provider_unavailable",
	"generated_media_safety_rejected",
	"generated_media_provider_malformed_output",
	"generated_media_provider_output_too_large",
	"generated_media_provider_outcome_unknown",
	"generated_media_output_invalid",
	"generated_media_publication_reconciliation_required",
]);
const image = nativeValidationEvidenceSchema.refine(
	(value) =>
		value.kind === "visual" &&
		value.mediaKind === "image" &&
		value.contentType === "image/png" &&
		value.byteLength <= 100000000,
);
export const generatedImageEvidenceSchema = z.discriminatedUnion("outcome", [
	z.strictObject({
		version: z.literal(1),
		kind: z.literal("generated_image"),
		...identity,
		outcome: z.literal("completed"),
		providerRef: z.string().min(1).max(2048),
		usageImages: z.literal(1),
		binaryArtifactId: z.string().uuid(),
		image,
	}),
	z.strictObject({
		version: z.literal(1),
		kind: z.literal("generated_image"),
		...identity,
		outcome: z.enum(["failed", "rejected", "unknown"]),
		code,
		retryable: z.boolean(),
		retryAfterMs: z.number().int().nonnegative().max(86400000).nullable(),
		providerRef: z.string().min(1).max(2048).nullable(),
	}),
]);
export type GeneratedImageCommand = z.infer<typeof generatedImageCommandSchema>;
export type GeneratedImageEvidence = z.infer<
	typeof generatedImageEvidenceSchema
>;
