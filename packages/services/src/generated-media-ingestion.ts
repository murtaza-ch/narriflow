import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
	deleteObject,
	headObject,
	listObjectsByPrefix,
	putFileFromPath,
	readObjectBytes,
} from "./r2-storage";
import {
	guardedFetch,
	readResponseBodyBounded,
	UnsafeUrlError,
} from "./url-guard";
import type {
	GeneratedMediaAssetDraft,
	GeneratedMediaAssetIngestor,
	GeneratedMediaStore,
} from "./generated-media";
import type { GeneratedMediaProviderResultStore } from "./openai-image-provider";

export interface GeneratedMediaProbeResult
	extends Omit<
		GeneratedMediaAssetDraft,
		"storageKey" | "sizeBytes" | "fingerprint"
	> {
	kind: "image" | "video";
}

export interface GeneratedMediaObjectStorage {
	head(key: string, signal?: AbortSignal): Promise<{
		contentType: string | null;
		sizeBytes: number | null;
		metadata: Readonly<Record<string, string>>;
	} | null>;
	put(input: {
		key: string;
		bytes: Uint8Array;
		contentType: string;
		metadata: Record<string, string>;
		signal?: AbortSignal;
	}): Promise<void>;
	get(
		key: string,
		maxBytes: number,
		signal?: AbortSignal,
	): Promise<{ bytes: Uint8Array; contentType: string }>;
	delete(key: string, signal?: AbortSignal): Promise<void>;
	list(prefix: string): Promise<
		Array<{ key: string; sizeBytes: number; lastModified: Date | null }>
	>;
}

export class GeneratedMediaIngestionError extends Error {
	constructor(
		readonly code:
			| "generated_media_unsafe_result_url"
			| "generated_media_result_download_failed"
			| "generated_media_output_too_large"
			| "generated_media_mime_unsupported"
			| "generated_media_mime_mismatch"
			| "generated_media_probe_failed"
			| "generated_media_kind_mismatch"
			| "generated_media_aspect_ratio_mismatch"
			| "generated_media_duration_mismatch"
			| "generated_media_normalization_failed"
			| "generated_media_attempt_object_conflict"
			| "generated_media_storage_unavailable"
			| "generated_media_upload_failed",
	) {
		super(code);
		this.name = "GeneratedMediaIngestionError";
	}
}

const contentTypes = new Set<GeneratedMediaAssetDraft["contentType"]>([
	"image/png",
	"image/jpeg",
	"image/webp",
	"video/mp4",
	"video/quicktime",
]);

function normalizeContentType(value: string | null) {
	const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
	return normalized && contentTypes.has(normalized as GeneratedMediaAssetDraft["contentType"])
		? (normalized as GeneratedMediaAssetDraft["contentType"])
		: null;
}

function sniffContentType(bytes: Uint8Array): GeneratedMediaAssetDraft["contentType"] | null {
	if (
		bytes.length >= 8 &&
		[137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
	) {
		return "image/png";
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	if (
		bytes.length >= 12 &&
		new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
		new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
	) {
		return "image/webp";
	}
	if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(4, 8)) === "ftyp") {
		return new TextDecoder().decode(bytes.slice(8, 12)) === "qt  "
			? "video/quicktime"
			: "video/mp4";
	}
	return null;
}

function expectedRatio(value: "9:16" | "1:1" | "16:9" | "4:5") {
	const [width, height] = value.split(":").map(Number);
	return (width ?? 1) / (height ?? 1);
}

function extension(contentType: GeneratedMediaAssetDraft["contentType"]) {
	return {
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/webp": "webp",
		"video/mp4": "mp4",
		"video/quicktime": "mov",
	}[contentType];
}

export function createGeneratedMediaAssetIngestor(input: {
	storage: GeneratedMediaObjectStorage;
	probe: (input: {
		bytes: Uint8Array;
		contentType: GeneratedMediaAssetDraft["contentType"];
		signal?: AbortSignal;
	}) => Promise<GeneratedMediaProbeResult | null>;
	normalizeImage?: (input: {
		bytes: Uint8Array;
		contentType: "image/png" | "image/jpeg" | "image/webp";
		aspectRatio: "9:16" | "1:1" | "16:9" | "4:5";
		signal?: AbortSignal;
	}) => Promise<{
		bytes: Uint8Array;
		contentType: "image/png" | "image/jpeg" | "image/webp";
	}>;
	fetchRemote?: typeof guardedFetch;
}): GeneratedMediaAssetIngestor {
	const fetchRemote = input.fetchRemote ?? guardedFetch;
	return {
		async ingest(request) {
			let bytes: Uint8Array;
			let declaredContentType: string | null;
			if (request.source.kind === "inline") {
				bytes = request.source.bytes;
				declaredContentType = request.source.contentType;
			} else {
				let response: Response;
				try {
					response = await fetchRemote(request.source.url, {
						headers: request.source.headers,
						timeoutMs: 30_000,
					});
				} catch (error) {
					if (error instanceof UnsafeUrlError) {
						throw new GeneratedMediaIngestionError(
							"generated_media_unsafe_result_url",
						);
					}
					throw new GeneratedMediaIngestionError(
						"generated_media_result_download_failed",
					);
				}
				if (!response.ok) {
					await response.body?.cancel().catch(() => undefined);
					throw new GeneratedMediaIngestionError(
						"generated_media_result_download_failed",
					);
				}
				declaredContentType = response.headers.get("content-type");
				try {
					bytes = await readResponseBodyBounded(response, request.maxOutputBytes);
				} catch {
					throw new GeneratedMediaIngestionError(
						"generated_media_output_too_large",
					);
				}
			}
			if (bytes.byteLength > request.maxOutputBytes) {
				throw new GeneratedMediaIngestionError("generated_media_output_too_large");
			}
			const declared = normalizeContentType(declaredContentType);
			if (!declared) {
				throw new GeneratedMediaIngestionError("generated_media_mime_unsupported");
			}
			let sniffed = sniffContentType(bytes);
			if (!sniffed || sniffed !== declared) {
				throw new GeneratedMediaIngestionError("generated_media_mime_mismatch");
			}
			let probe = await input.probe({
				bytes,
				contentType: sniffed,
				signal: request.signal,
			});
			if (!probe || probe.width <= 0 || probe.height <= 0) {
				throw new GeneratedMediaIngestionError("generated_media_probe_failed");
			}
			if (probe.kind !== request.kind) {
				throw new GeneratedMediaIngestionError("generated_media_kind_mismatch");
			}
			if (probe.contentType !== sniffed) {
				throw new GeneratedMediaIngestionError("generated_media_mime_mismatch");
			}
			let actualRatio = probe.width / probe.height;
			if (
				Math.abs(actualRatio / expectedRatio(request.aspectRatio) - 1) > 0.04 &&
				request.kind === "image" &&
				input.normalizeImage &&
				sniffed.startsWith("image/")
			) {
				let normalized: Awaited<ReturnType<NonNullable<typeof input.normalizeImage>>>;
				try {
					normalized = await input.normalizeImage({
						bytes,
						contentType: sniffed as "image/png" | "image/jpeg" | "image/webp",
						aspectRatio: request.aspectRatio,
						signal: request.signal,
					});
				} catch {
					throw new GeneratedMediaIngestionError(
						"generated_media_normalization_failed",
					);
				}
				if (normalized.bytes.byteLength > request.maxOutputBytes) {
					throw new GeneratedMediaIngestionError(
						"generated_media_output_too_large",
					);
				}
				const normalizedSniffed = sniffContentType(normalized.bytes);
				if (
					!normalizedSniffed ||
					normalizedSniffed !== normalized.contentType
				) {
					throw new GeneratedMediaIngestionError(
						"generated_media_mime_mismatch",
					);
				}
				bytes = normalized.bytes;
				sniffed = normalizedSniffed;
				probe = await input.probe({
					bytes,
					contentType: sniffed,
					signal: request.signal,
				});
				if (!probe || probe.width <= 0 || probe.height <= 0) {
					throw new GeneratedMediaIngestionError("generated_media_probe_failed");
				}
				if (probe.kind !== "image" || probe.contentType !== sniffed) {
					throw new GeneratedMediaIngestionError("generated_media_mime_mismatch");
				}
				actualRatio = probe.width / probe.height;
			}
			if (Math.abs(actualRatio / expectedRatio(request.aspectRatio) - 1) > 0.04) {
				throw new GeneratedMediaIngestionError(
					"generated_media_aspect_ratio_mismatch",
				);
			}
			if (
				request.kind === "video" &&
				(request.requestedDurationSec === null ||
					probe.durationSec === null ||
					probe.durationSec <= 0 ||
					probe.durationSec > request.requestedDurationSec + 1)
			) {
				throw new GeneratedMediaIngestionError(
					"generated_media_duration_mismatch",
				);
			}
			const fingerprint = createHash("sha256").update(bytes).digest("hex");
			const requestedKey = request.storageKey.replace(
				/\.(?:bin|media)$/i,
				`.${extension(sniffed)}`,
			);
			let existing: Awaited<ReturnType<GeneratedMediaObjectStorage["head"]>>;
			try {
				existing = await input.storage.head(requestedKey, request.signal);
			} catch {
				throw new GeneratedMediaIngestionError(
					"generated_media_storage_unavailable",
				);
			}
			if (existing) {
				if (
					existing.contentType !== sniffed ||
					existing.sizeBytes !== bytes.byteLength ||
					existing.metadata.fingerprint !== fingerprint ||
					existing.metadata["generated-job-id"] !== request.jobId
				) {
					throw new GeneratedMediaIngestionError(
						"generated_media_attempt_object_conflict",
					);
				}
			} else {
				try {
					await input.storage.put({
						key: requestedKey,
						bytes,
						contentType: sniffed,
						metadata: {
							fingerprint,
							"generated-job-id": request.jobId,
							"generated-attempt-id": request.attemptId,
						},
						signal: request.signal,
					});
				} catch {
					await input.storage.delete(requestedKey, request.signal).catch(() => undefined);
					throw new GeneratedMediaIngestionError("generated_media_upload_failed");
				}
			}
			return {
				storageKey: requestedKey,
				contentType: sniffed,
				sizeBytes: bytes.byteLength,
				width: probe.width,
				height: probe.height,
				durationSec: probe.durationSec,
				hasAudio: probe.hasAudio,
				videoCodec: probe.videoCodec,
				audioCodec: probe.audioCodec,
				fingerprint,
			};
		},
	};
}

const execFileAsync = promisify(execFile);

export async function normalizeGeneratedImageAspectRatio(input: {
	bytes: Uint8Array;
	contentType: "image/png" | "image/jpeg" | "image/webp";
	aspectRatio: "9:16" | "1:1" | "16:9" | "4:5";
	signal?: AbortSignal;
}): Promise<{
	bytes: Uint8Array;
	contentType: "image/png" | "image/jpeg" | "image/webp";
}> {
	const directory = await mkdtemp(join(tmpdir(), "narriflow-generated-normalize-"));
	const mediaExtension = extension(input.contentType);
	const sourcePath = join(directory, `source.${mediaExtension}`);
	const outputPath = join(directory, `normalized.${mediaExtension}`);
	const targetRatio = expectedRatio(input.aspectRatio);
	try {
		await writeFile(sourcePath, input.bytes);
		await execFileAsync(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-i",
				sourcePath,
				"-vf",
				`crop='if(gt(a,${targetRatio}),ih*${targetRatio},iw)':'if(gt(a,${targetRatio}),ih,iw/${targetRatio})'`,
				"-frames:v",
				"1",
				"-map_metadata",
				"-1",
				outputPath,
			],
			{ timeout: 30_000, maxBuffer: 1024 * 1024, signal: input.signal },
		);
		return {
			bytes: new Uint8Array(await readFile(outputPath)),
			contentType: input.contentType,
		};
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

export async function probeGeneratedMedia(input: {
	bytes: Uint8Array;
	contentType: GeneratedMediaAssetDraft["contentType"];
	signal?: AbortSignal;
}): Promise<GeneratedMediaProbeResult | null> {
	const directory = await mkdtemp(join(tmpdir(), "narriflow-generated-probe-"));
	const filePath = join(directory, `media.${extension(input.contentType)}`);
	try {
		await writeFile(filePath, input.bytes);
		const { stdout } = await execFileAsync(
			"ffprobe",
			[
				"-v",
				"error",
				"-show_entries",
				"stream=codec_type,codec_name,width,height,duration:format=format_name,duration:format_tags=major_brand",
				"-of",
				"json",
				filePath,
			],
			{ timeout: 20_000, maxBuffer: 1024 * 1024, signal: input.signal },
		);
		const parsed = JSON.parse(stdout) as {
			streams?: Array<{
				codec_type?: string;
				codec_name?: string;
				width?: number;
				height?: number;
				duration?: string;
			}>;
			format?: { duration?: string };
		};
		const video = parsed.streams?.find((stream) => stream.codec_type === "video");
		if (!video?.width || !video.height) return null;
		const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
		const duration = Number(video.duration ?? parsed.format?.duration);
		const kind = input.contentType.startsWith("image/") ? "image" : "video";
		return {
			kind,
			contentType: input.contentType,
			width: video.width,
			height: video.height,
			durationSec:
				kind === "video" && Number.isFinite(duration) && duration >= 0
					? duration
					: null,
			hasAudio: kind === "video" ? Boolean(audio) : null,
			videoCodec: kind === "video" ? video.codec_name ?? null : null,
			audioCodec: kind === "video" ? audio?.codec_name ?? null : null,
		};
	} catch {
		return null;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

export const r2GeneratedMediaObjectStorage: GeneratedMediaObjectStorage = {
	async head(key, signal) {
		try {
			const result = await headObject(key, { signal });
			return {
				contentType: result.contentType,
				sizeBytes: result.sizeBytes,
				metadata: result.metadata,
			};
		} catch (error) {
			const candidate = error as {
				name?: unknown;
				code?: unknown;
				$metadata?: { httpStatusCode?: unknown };
			};
			if (
				candidate.$metadata?.httpStatusCode === 404 ||
				["NotFound", "NoSuchKey"].includes(String(candidate.name)) ||
				["NotFound", "NoSuchKey"].includes(String(candidate.code))
			) {
				return null;
			}
			throw error;
		}
	},
	async put(input) {
		const directory = await mkdtemp(join(tmpdir(), "narriflow-generated-upload-"));
		const filePath = join(directory, randomUUID());
		try {
			await writeFile(filePath, input.bytes);
			await putFileFromPath({
				key: input.key,
				filePath,
				contentType: input.contentType,
				metadata: input.metadata,
				signal: input.signal,
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
	async get(key, maxBytes, signal) {
		const [head, bytes] = await Promise.all([
			headObject(key, { signal }),
			readObjectBytes(key, maxBytes, { signal }),
		]);
		if (!head.contentType) throw new Error("Generated media object has no content type");
		return { bytes, contentType: head.contentType };
	},
	async delete(key, signal) {
		await deleteObject(key, { signal });
	},
	async list(prefix) {
		return (await listObjectsByPrefix(prefix)).map((object) => ({
			...object,
			lastModified: object.lastModified ?? null,
		}));
	},
};

export function createGeneratedMediaProviderResultStore(
	storage: GeneratedMediaObjectStorage = r2GeneratedMediaObjectStorage,
): GeneratedMediaProviderResultStore {
	const referenceFor = (requestId: string) =>
		`generated-media/provider-results/${requestId}.png`;
	return {
		referenceFor,
		async put(input) {
			const key = referenceFor(input.requestId);
			const fingerprint = createHash("sha256").update(input.bytes).digest("hex");
			const matches = (
				value: Awaited<ReturnType<GeneratedMediaObjectStorage["head"]>>,
			) =>
				Boolean(
					value &&
						value.contentType === input.contentType &&
						value.metadata.fingerprint === fingerprint &&
						value.sizeBytes === input.bytes.byteLength,
				);
			const existing = await storage.head(key, input.signal);
			if (!existing) {
				try {
					await storage.put({
						key,
						bytes: input.bytes,
						contentType: input.contentType,
						metadata: { fingerprint },
						signal: input.signal,
					});
				} catch (error) {
					let committed: Awaited<
						ReturnType<GeneratedMediaObjectStorage["head"]>
					>;
					try {
						committed = await storage.head(key, input.signal);
					} catch {
						throw error;
					}
					if (!matches(committed)) throw error;
				}
			} else if (!matches(existing)) {
				throw new Error("Provider result key conflict");
			}
			return key;
		},
		get(reference, signal) {
			return storage.get(reference, 32 * 1024 * 1024, signal);
		},
	};
}

export async function reconcileGeneratedMediaOrphans(input: {
	storage: GeneratedMediaObjectStorage;
	store: Pick<GeneratedMediaStore, "referencedStorageKeys">;
	prefix: string;
	now: Date;
	minimumAgeMs: number;
	limit: number;
	signal?: AbortSignal;
}) {
	const [objects, referenced] = await Promise.all([
		input.storage.list(input.prefix),
		input.store.referencedStorageKeys(input.prefix),
	]);
	const candidates = objects
		.filter(
			(object) =>
				!referenced.has(object.key) &&
				Boolean(object.lastModified) &&
				input.now.getTime() - object.lastModified!.getTime() >= input.minimumAgeMs,
		)
		.slice(0, Math.max(0, Math.min(1000, input.limit)));
	let deleted = 0;
	let failed = 0;
	for (const object of candidates) {
		input.signal?.throwIfAborted();
		try {
			await input.storage.delete(object.key, input.signal);
			deleted += 1;
		} catch {
			failed += 1;
		}
	}
	return { scanned: objects.length, deleted, failed };
}

export const generatedMediaAssetIngestor = createGeneratedMediaAssetIngestor({
	storage: r2GeneratedMediaObjectStorage,
	probe: probeGeneratedMedia,
	normalizeImage: normalizeGeneratedImageAspectRatio,
});
