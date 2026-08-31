import { describe, expect, test } from "bun:test";

import {
	GeneratedMediaIngestionError,
	createGeneratedMediaAssetIngestor,
	createGeneratedMediaProviderResultStore,
	normalizeGeneratedImageAspectRatio,
	probeGeneratedMedia,
	reconcileGeneratedMediaOrphans,
	type GeneratedMediaObjectStorage,
} from "./generated-media-ingestion";

function pngBytes() {
	return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
}

function portraitPngBytes() {
	return Buffer.from(
		[
			"iVBORw0KGgoAAAANSUhEUgAAAGQAAACWCAIAAACn2roRAAAACXBIWXMAAAABAAAA",
			"AQBPJcTWAAABUElEQVR4nO3QQQ3AIADAQEiwPC9oQtUsrC+y5E5B0/nsM/hm3Q74",
			"E7MCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKz",
			"ArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKz",
			"ArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKz",
			"ArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKz",
			"ArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKz",
			"ArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKz",
			"ArMCswKzArOCF0Y0BC3zCPTDAAAAAElFTkSuQmCC",
		].join(""),
		"base64",
	);
}

function createStorage(): GeneratedMediaObjectStorage & {
	puts: string[];
	deletes: string[];
} {
	const objects = new Map<
		string,
		{ bytes: Uint8Array; contentType: string; metadata: Record<string, string> }
	>();
	return {
		puts: [],
		deletes: [],
		async head(key) {
			const object = objects.get(key);
			return object
				? {
						contentType: object.contentType,
						sizeBytes: object.bytes.byteLength,
						metadata: object.metadata,
					}
				: null;
		},
		async put(input) {
			this.puts.push(input.key);
			objects.set(input.key, {
				bytes: input.bytes,
				contentType: input.contentType,
				metadata: input.metadata,
			});
		},
		async get(key, maxBytes) {
			const object = objects.get(key);
			if (!object || object.bytes.byteLength > maxBytes) throw new Error("missing");
			return { bytes: object.bytes, contentType: object.contentType };
		},
		async delete(key) {
			this.deletes.push(key);
			objects.delete(key);
		},
		async list(prefix) {
			return [...objects.entries()]
				.filter(([key]) => key.startsWith(prefix))
				.map(([key, object]) => ({
					key,
					sizeBytes: object.bytes.byteLength,
					lastModified: new Date(0),
				}));
		},
	};
}

const baseInput = {
	jobId: "00000000-0000-4000-8000-000000000001",
	attemptId: "00000000-0000-4000-8000-000000000002",
	storageKey:
		"workspaces/00000000-0000-4000-8000-000000000003/visual-assets/generated/job/attempt.png",
	kind: "image" as const,
	aspectRatio: "9:16" as const,
	requestedDurationSec: null,
	maxOutputBytes: 1024,
};

describe("generated media ingestion", () => {
	test("adopts a deterministic provider result when storage commits before losing the response", async () => {
		const storage = createStorage();
		const committedPut = storage.put.bind(storage);
		storage.put = async (input) => {
			await committedPut(input);
			throw new Error("storage response lost after commit");
		};
		const results = createGeneratedMediaProviderResultStore(storage);

		await expect(
			results.put({
				requestId: "00000000-0000-4000-8000-000000000017",
				bytes: pngBytes(),
				contentType: "image/png",
			}),
		).resolves.toBe(
			"generated-media/provider-results/00000000-0000-4000-8000-000000000017.png",
		);
		expect(storage.puts).toHaveLength(1);
	});

	test("normalizes the OpenAI portrait canvas to the requested 9:16 asset", async () => {
		const normalized = await normalizeGeneratedImageAspectRatio({
			bytes: portraitPngBytes(),
			contentType: "image/png",
			aspectRatio: "9:16",
		});
		const probe = await probeGeneratedMedia(normalized);

		expect(probe).not.toBeNull();
		expect(probe?.kind).toBe("image");
		expect((probe?.width ?? 0) / (probe?.height ?? 1)).toBeCloseTo(9 / 16, 2);
	});

	test("publishes normalized bytes and dimensions through guarded ingestion", async () => {
		const storage = createStorage();
		const ingestor = createGeneratedMediaAssetIngestor({
			storage,
			probe: probeGeneratedMedia,
			normalizeImage: normalizeGeneratedImageAspectRatio,
		});
		const asset = await ingestor.ingest({
			...baseInput,
			source: {
				kind: "inline",
				contentType: "image/png",
				bytes: portraitPngBytes(),
			},
		});

		expect(asset.width / asset.height).toBeCloseTo(9 / 16, 2);
		expect(asset.sizeBytes).toBeGreaterThan(0);
		expect(storage.puts).toHaveLength(1);
	});

	test("validates, fingerprints, and idempotently uploads an attempt object", async () => {
		const storage = createStorage();
		const ingestor = createGeneratedMediaAssetIngestor({
			storage,
			probe: async () => ({
				kind: "image",
				contentType: "image/png",
				width: 900,
				height: 1600,
				durationSec: null,
				hasAudio: null,
				videoCodec: null,
				audioCodec: null,
			}),
		});

		const first = await ingestor.ingest({
			...baseInput,
			source: { kind: "inline", contentType: "image/png", bytes: pngBytes() },
		});
		const replay = await ingestor.ingest({
			...baseInput,
			source: { kind: "inline", contentType: "image/png", bytes: pngBytes() },
		});

		expect(first).toEqual(replay);
		expect(first.fingerprint).toHaveLength(64);
		expect(storage.puts).toHaveLength(1);
	});

	test("rejects private result URLs before fetching", async () => {
		const ingestor = createGeneratedMediaAssetIngestor({
			storage: createStorage(),
			probe: async () => null,
		});

		await expect(
			ingestor.ingest({
				...baseInput,
				source: { kind: "url", url: "http://127.0.0.1/provider-output" },
			}),
		).rejects.toMatchObject({ code: "generated_media_unsafe_result_url" });
	});

	test("rejects oversized and MIME-mismatched output before upload", async () => {
		const storage = createStorage();
		const ingestor = createGeneratedMediaAssetIngestor({
			storage,
			probe: async () => ({
				kind: "image",
				contentType: "image/png",
				width: 900,
				height: 1600,
				durationSec: null,
				hasAudio: null,
				videoCodec: null,
				audioCodec: null,
			}),
		});

		await expect(
			ingestor.ingest({
				...baseInput,
				maxOutputBytes: 4,
				source: { kind: "inline", contentType: "image/png", bytes: pngBytes() },
			}),
		).rejects.toBeInstanceOf(GeneratedMediaIngestionError);
		await expect(
			ingestor.ingest({
				...baseInput,
				source: { kind: "inline", contentType: "image/jpeg", bytes: pngBytes() },
			}),
		).rejects.toMatchObject({ code: "generated_media_mime_mismatch" });
		expect(storage.puts).toHaveLength(0);
	});

	test("enforces requested video duration and audio metadata", async () => {
		const mp4 = new Uint8Array([
			0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0,
		]);
		const ingestor = createGeneratedMediaAssetIngestor({
			storage: createStorage(),
			probe: async () => ({
				kind: "video",
				contentType: "video/mp4",
				width: 1080,
				height: 1920,
				durationSec: 12,
				hasAudio: true,
				videoCodec: "h264",
				audioCodec: "aac",
			}),
		});

		await expect(
			ingestor.ingest({
				...baseInput,
				kind: "video",
				requestedDurationSec: 8,
				storageKey: baseInput.storageKey.replace(".png", ".mp4"),
				source: { kind: "inline", contentType: "video/mp4", bytes: mp4 },
			}),
		).rejects.toMatchObject({ code: "generated_media_duration_mismatch" });
	});

	test("retains probed codec, duration, and optional-audio metadata", async () => {
		const mp4 = new Uint8Array([
			0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0,
		]);
		const ingestor = createGeneratedMediaAssetIngestor({
			storage: createStorage(),
			probe: async () => ({
				kind: "video",
				contentType: "video/mp4",
				width: 1080,
				height: 1920,
				durationSec: 7.9,
				hasAudio: false,
				videoCodec: "h264",
				audioCodec: null,
			}),
		});

		await expect(
			ingestor.ingest({
				...baseInput,
				kind: "video",
				requestedDurationSec: 8,
				storageKey: baseInput.storageKey.replace(".png", ".mp4"),
				source: { kind: "inline", contentType: "video/mp4", bytes: mp4 },
			}),
		).resolves.toMatchObject({
			contentType: "video/mp4",
			durationSec: 7.9,
			hasAudio: false,
			videoCodec: "h264",
			audioCodec: null,
		});
	});

	test("does not overwrite an attempt key when storage inspection fails", async () => {
		const storage = createStorage();
		storage.head = async () => {
			throw new Error("storage unavailable");
		};
		const ingestor = createGeneratedMediaAssetIngestor({
			storage,
			probe: async () => ({
				kind: "image",
				contentType: "image/png",
				width: 900,
				height: 1600,
				durationSec: null,
				hasAudio: null,
				videoCodec: null,
				audioCodec: null,
			}),
		});

		await expect(
			ingestor.ingest({
				...baseInput,
				source: { kind: "inline", contentType: "image/png", bytes: pngBytes() },
			}),
		).rejects.toMatchObject({ code: "generated_media_storage_unavailable" });
		expect(storage.puts).toHaveLength(0);
	});

	test("attempts cleanup when an attempt-scoped upload crashes", async () => {
		const storage = createStorage();
		storage.put = async (input) => {
			storage.puts.push(input.key);
			throw new Error("connection reset after upload");
		};
		const ingestor = createGeneratedMediaAssetIngestor({
			storage,
			probe: async () => ({
				kind: "image",
				contentType: "image/png",
				width: 900,
				height: 1600,
				durationSec: null,
				hasAudio: null,
				videoCodec: null,
				audioCodec: null,
			}),
		});

		await expect(
			ingestor.ingest({
				...baseInput,
				source: { kind: "inline", contentType: "image/png", bytes: pngBytes() },
			}),
		).rejects.toMatchObject({ code: "generated_media_upload_failed" });
		expect(storage.puts).toHaveLength(1);
		expect(storage.deletes).toEqual(storage.puts);
	});

	test("deletes only old unreferenced attempt objects", async () => {
		const storage = createStorage();
		const referenced = "generated-media/provider-results/referenced.png";
		const orphan = "generated-media/provider-results/orphan.png";
		for (const key of [referenced, orphan]) {
			await storage.put({
				key,
				bytes: pngBytes(),
				contentType: "image/png",
				metadata: {},
			});
		}

		const result = await reconcileGeneratedMediaOrphans({
			storage,
			store: {
				async referencedStorageKeys() {
					return new Set([referenced]);
				},
			},
			prefix: "generated-media/provider-results/",
			now: new Date("2026-08-31T00:00:00.000Z"),
			minimumAgeMs: 60_000,
			limit: 10,
		});

		expect(result).toEqual({ scanned: 2, deleted: 1, failed: 0 });
		expect(storage.deletes).toContain(orphan);
		expect(storage.deletes).not.toContain(referenced);
	});
});
