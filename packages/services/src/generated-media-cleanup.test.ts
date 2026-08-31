import { describe, expect, test } from "bun:test";

import {
	adoptGeneratedMediaAssetUpload,
	adoptGeneratedMediaProviderResult,
	generatedMediaAssetUploadObligation,
	generatedMediaProviderResultObligation,
	generatedMediaRetirementObligation,
} from "./generated-media-cleanup";

describe("generated media cleanup ownership", () => {
	test("plans delayed exact-key obligations before generated-media writes", () => {
		const now = new Date("2026-08-31T00:00:00.000Z");

		expect(
			generatedMediaAssetUploadObligation({
				projectId: "00000000-0000-4000-8000-000000000001",
				clipId: "00000000-0000-4000-8000-000000000002",
				objectKey:
					"generated-media/assets/workspace/workspace-1/job-1/attempt-1.png",
				now,
			}),
		).toEqual({
			origin: "generated_media_ingestion",
			cleanupClass: "generated_media_asset_upload",
			projectId: "00000000-0000-4000-8000-000000000001",
			clipId: "00000000-0000-4000-8000-000000000002",
			objectKey:
				"generated-media/assets/workspace/workspace-1/job-1/attempt-1.png",
			nextAttemptAt: new Date("2026-09-01T00:00:00.000Z"),
		});

		expect(
			generatedMediaProviderResultObligation(
				"generated-media/provider-results/00000000-0000-4000-8000-000000000003.png",
				now,
			),
		).toEqual({
			origin: "generated_media_ingestion",
			cleanupClass: "generated_media_provider_result",
			objectKey:
				"generated-media/provider-results/00000000-0000-4000-8000-000000000003.png",
			nextAttemptAt: new Date("2026-09-01T00:00:00.000Z"),
		});
		expect(
			generatedMediaProviderResultObligation(
				"https://provider.example.test/result.png",
				now,
			),
		).toBeNull();
	});

	test("plans exact retirement only after a durable reference is removed", () => {
		const now = new Date("2026-08-31T00:00:00.000Z");

		expect(
			generatedMediaRetirementObligation({
				kind: "consumed_provider_result",
				projectId: "00000000-0000-4000-8000-000000000001",
				clipId: null,
				objectKey:
					"generated-media/provider-results/00000000-0000-4000-8000-000000000003.png",
				now,
			}),
		).toEqual({
			origin: "generated_media_ingestion",
			cleanupClass: "generated_media_consumed_provider_result",
			projectId: "00000000-0000-4000-8000-000000000001",
			clipId: null,
			objectKey:
				"generated-media/provider-results/00000000-0000-4000-8000-000000000003.png",
			nextAttemptAt: now,
		});
	});

	test("adopts durable asset and provider-result references with exact receipts", async () => {
		const now = new Date("2026-08-31T00:00:00.000Z");
		const updates: unknown[] = [];
		const store = {
			async updateMany(input: unknown) {
				updates.push(input);
				return { count: 1 };
			},
			async count() {
				return 0;
			},
		};

		await adoptGeneratedMediaAssetUpload(
			store,
			"generated-media/assets/workspace/workspace-1/job-1/attempt-1.png",
			now,
		);
		await adoptGeneratedMediaProviderResult(
			store,
			"generated-media/provider-results/00000000-0000-4000-8000-000000000003.png",
			now,
		);

		expect(updates).toEqual([
			expect.objectContaining({
				where: expect.objectContaining({
					cleanupClass: "generated_media_asset_upload",
					objectKey:
						"generated-media/assets/workspace/workspace-1/job-1/attempt-1.png",
				}),
				data: expect.objectContaining({
					failureCode: "generated_media_asset_referenced",
				}),
			}),
			expect.objectContaining({
				where: expect.objectContaining({
					cleanupClass: "generated_media_provider_result",
					objectKey:
						"generated-media/provider-results/00000000-0000-4000-8000-000000000003.png",
				}),
				data: expect.objectContaining({
					failureCode: "generated_media_result_referenced",
				}),
			}),
		]);
	});
});
