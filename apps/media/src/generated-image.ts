import { createHash } from "node:crypto";
import { lstat, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	generatedImageCommandSchema,
	generatedImageEvidenceSchema,
	type GeneratedImageEvidence,
} from "@narriflow/validators/generated-image-execution";
import {
	createOpenAiImageProvider,
	GeneratedMediaProviderError,
} from "@narriflow/services/openai-image-provider";
import { validateNativeAsset } from "./asset-validation";

export interface GeneratedImageNativeOptions {
	work: string;
	outputPath: string;
	sourcePath?: string;
	binaryArtifactId: string;
	apiKey?: string;
	signal: AbortSignal;
	fetch?: typeof globalThis.fetch;
	/** Trusted resource-gate observation after decoding, never part of a command. */
	decoded?: (bytes: Uint8Array) => void;
}

/** Exactly one fixed-origin provider POST, or exact-source recovery without a
 * provider request. The native supervisor bounds RSS, files and wall time. */
export async function executeGeneratedImage(
	raw: unknown,
	options: GeneratedImageNativeOptions,
): Promise<GeneratedImageEvidence> {
	const command = generatedImageCommandSchema.parse(raw),
		identity = {
			version: 1 as const,
			kind: "generated_image" as const,
			jobId: command.jobId,
			requestId: command.requestId,
			inputHash: command.inputHash,
		};
	const directory = await realpath(options.work);
	if (
		(await realpath(dirname(options.outputPath))) !== directory ||
		(await lstat(options.work)).isSymbolicLink()
	)
		throw new Error("generated_image_scratch_invalid");
	options.signal.throwIfAborted();
	const unknown = (providerRef: string | null = null) =>
		generatedImageEvidenceSchema.parse({
			...identity,
			outcome: "unknown",
			code: "generated_media_publication_reconciliation_required",
			providerRef,
			retryable: false,
			retryAfterMs: null,
		});
	let sourcePath = options.sourcePath,
		providerRef: string | null =
			command.mode === "recover" ? command.providerRef : null;
	let expected: {
		contentType: "image/png";
		byteLength: number;
		sha256: string;
	};
	if (command.mode === "generate") {
		try {
			const request = options.fetch ?? globalThis.fetch;
			const provider = createOpenAiImageProvider({
				apiKey: options.apiKey ?? "",
				model: command.model,
				quality: command.quality,
				maxOutputBytes: command.maxOutputBytes,
				fetch: (url, init) =>
					request(url, {
						...init,
						signal: AbortSignal.any([
							options.signal,
							...(init?.signal ? [init.signal] : []),
						]),
					}),
			});
			const outcome = await provider.submit({
				requestId: command.requestId,
				prompt: command.prompt,
				aspectRatio: command.aspectRatio,
				style: command.style,
			});
			if (
				outcome.kind !== "completed" ||
				outcome.result?.contentType !== "image/png" ||
				!outcome.result.bytes
			)
				throw new GeneratedMediaProviderError(
					"generated_media_provider_malformed_output",
				);
			providerRef = outcome.providerRef;
			const bytes = outcome.result.bytes;
			options.decoded?.(bytes);
			expected = {
				contentType: "image/png",
				byteLength: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			};
			sourcePath = join(directory, "generated-source.png");
			try {
				await writeFile(sourcePath, bytes, {
					flag: "wx",
					mode: 0o600,
					signal: options.signal,
				});
			} catch {
				return unknown(providerRef);
			}
			outcome.result.bytes = undefined;
		} catch (error) {
			if (error instanceof GeneratedMediaProviderError)
				return generatedImageEvidenceSchema.parse({
					...identity,
					outcome: error.details?.outcomeUnknown
						? "unknown"
						: error.code === "generated_media_safety_rejected"
							? "rejected"
							: "failed",
					code: error.code,
					providerRef,
					retryable: error.details?.outcomeUnknown
						? false
						: Boolean(error.details?.retryable),
					retryAfterMs:
						error.retryAfterSeconds === undefined
							? null
							: Math.min(86400000, Math.round(error.retryAfterSeconds * 1000)),
				});
			return generatedImageEvidenceSchema.parse({
				...identity,
				outcome: "unknown",
				code: "generated_media_provider_outcome_unknown",
				providerRef,
				retryable: false,
				retryAfterMs: null,
			});
		}
	} else {
		if (!sourcePath) throw new Error("generated_image_source_invalid");
		expected = command.expected;
	}
	try {
		options.signal.throwIfAborted();
		const image = await validateNativeAsset(
			{ kind: "visual", sourcePath, outputPath: options.outputPath, expected },
			options.signal,
		);
		return generatedImageEvidenceSchema.parse({
			...identity,
			outcome: "completed",
			providerRef,
			usageImages: 1,
			binaryArtifactId: options.binaryArtifactId,
			image,
		});
	} catch (error) {
		if (
			options.signal.aborted ||
			["ENOSPC", "EIO", "EACCES", "ENOENT"].includes(
				(error as { code?: string }).code ?? "",
			)
		)
			return unknown(providerRef);
		return generatedImageEvidenceSchema.parse({
			...identity,
			outcome: "failed",
			code: "generated_media_output_invalid",
			providerRef,
			retryable: false,
			retryAfterMs: null,
		});
	} finally {
		if (command.mode === "generate" && sourcePath)
			await unlink(sourcePath).catch(() => {});
	}
}
