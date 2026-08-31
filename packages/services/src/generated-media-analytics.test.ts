import { describe, expect, test } from "bun:test";
import {
	generatedMediaAnalyticsEventSchema,
	type GeneratedMediaAnalyticsEventInput,
} from "@narriflow/validators";

import {
	createGeneratedMediaAnalyticsSink,
	generatedMediaLatencyBucket,
} from "./generated-media-analytics";

describe("generated media analytics sink", () => {
	test("buckets latency without recording content or provider payloads", async () => {
		const events: GeneratedMediaAnalyticsEventInput[] = [];
		const sink = createGeneratedMediaAnalyticsSink({
			recordEvent: async (event) => {
				events.push(event);
			},
			resolveWorkspacePlan: async () => "creator",
			readJob: async () => null,
		});

		await sink.recordCompleted({
			jobId: "job-1",
			workspaceId: "00000000-0000-4000-8000-000000000001",
			projectId: "00000000-0000-4000-8000-000000000002",
			clipId: "00000000-0000-4000-8000-000000000003",
			kind: "image",
			providerAlias: "openai-image",
			modelAlias: "configured-image-alias",
			status: "completed",
			latencyMs: 12_000,
			retryCount: 1,
			moderationOutcome: "passed",
			usageUnits: 1,
		});

		expect(events).toEqual([
			{
				type: "generated_asset_completed",
				projectId: "00000000-0000-4000-8000-000000000002",
				clipId: "00000000-0000-4000-8000-000000000003",
				metadata: {
					kind: "image",
					providerAlias: "openai-image",
					modelAlias: "configured-image-alias",
					status: "completed",
					latencyBucket: "under_1m",
					retryCount: 1,
					moderationOutcome: "passed",
					usageUnits: 1,
					outcome: "succeeded",
					planTier: "creator",
				},
			},
		]);
		expect(JSON.stringify(events)).not.toContain("prompt");
		expect(JSON.stringify(events)).not.toContain("transcript");
		expect(JSON.stringify(events)).not.toContain("https://");
	});

	test("records insertion dimensions from the tenant-scoped durable job", async () => {
		const events: GeneratedMediaAnalyticsEventInput[] = [];
		const now = new Date("2026-08-31T12:02:00.000Z");
		const sink = createGeneratedMediaAnalyticsSink({
			recordEvent: async (event) => {
				events.push(event);
			},
			resolveWorkspacePlan: async () => "pro",
			readJob: async () => ({
				kind: "video",
				providerAlias: "approved-video",
				modelAlias: "configured-video-alias",
				status: "completed",
				createdAt: new Date("2026-08-31T12:00:00.000Z"),
				retryCount: 2,
				moderationOutcome: "passed",
				usageUnits: 6,
			}),
			now: () => now,
		});

		await sink.recordInserted({
			jobId: "job-2",
			workspaceId: "00000000-0000-4000-8000-000000000001",
			projectId: "00000000-0000-4000-8000-000000000002",
			clipId: "00000000-0000-4000-8000-000000000003",
			insertionAction: "scene_block",
			planTier: "pro",
			outcome: "succeeded",
		});

		expect(events[0]).toMatchObject({
			type: "generated_asset_inserted",
			metadata: {
				kind: "video",
				status: "completed",
				latencyBucket: "under_5m",
				insertionAction: "scene_block",
				outcome: "succeeded",
				planTier: "pro",
			},
		});
	});

	test("uses bounded, stable latency buckets", () => {
		expect(generatedMediaLatencyBucket(9_999)).toBe("under_10s");
		expect(generatedMediaLatencyBucket(10_000)).toBe("under_1m");
		expect(generatedMediaLatencyBucket(60_000)).toBe("under_5m");
		expect(generatedMediaLatencyBucket(300_000)).toBe("5m_plus");
	});

	test("requires terminal status and outcome to describe the same durable event", () => {
		const event = {
			type: "generated_asset_completed" as const,
			projectId: "00000000-0000-4000-8000-000000000002",
			clipId: null,
			metadata: {
				kind: "image" as const,
				providerAlias: "openai-image",
				modelAlias: "configured-image-alias",
				status: "failed" as const,
				latencyBucket: "under_1m" as const,
				retryCount: 0,
				moderationOutcome: "passed" as const,
				usageUnits: 0,
				outcome: "failed" as const,
				planTier: "creator" as const,
			},
		};
		expect(() => generatedMediaAnalyticsEventSchema.parse(event)).not.toThrow();
		expect(() => generatedMediaAnalyticsEventSchema.parse({
			...event,
			metadata: { ...event.metadata, outcome: "succeeded" },
		})).toThrow();
		expect(() => generatedMediaAnalyticsEventSchema.parse({
			...event,
			metadata: { ...event.metadata, status: "waiting", outcome: "failed" },
		})).toThrow();
	});

	test("accepts only committed insertion outcomes until failed commands are durable", () => {
		const event = {
			type: "generated_asset_inserted" as const,
			projectId: "00000000-0000-4000-8000-000000000002",
			clipId: "00000000-0000-4000-8000-000000000003",
			metadata: {
				kind: "image" as const,
				providerAlias: "openai-image",
				modelAlias: "configured-image-alias",
				status: "completed" as const,
				latencyBucket: "under_1m" as const,
				retryCount: 0,
				moderationOutcome: "passed" as const,
				usageUnits: 1,
				insertionAction: "broll" as const,
				outcome: "succeeded" as const,
				planTier: "creator" as const,
			},
		};
		expect(() => generatedMediaAnalyticsEventSchema.parse(event)).not.toThrow();
		expect(() => generatedMediaAnalyticsEventSchema.parse({
			...event,
			metadata: { ...event.metadata, outcome: "failed" },
		})).toThrow();
	});
});
