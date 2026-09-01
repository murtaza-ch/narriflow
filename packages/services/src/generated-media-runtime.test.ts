import { describe, expect, test } from "bun:test";

import { createInMemoryGeneratedMediaStore } from "./generated-media";
import { createGeneratedMediaRuntime } from "./generated-media-runtime";
import type { GeneratedMediaObjectStorage } from "./generated-media-ingestion";

describe("generated media runtime", () => {
	test("stays inert without rollout configuration", () => {
		const runtime = createGeneratedMediaRuntime({ env: {} });
		expect(runtime.available).toBe(false);
		expect(runtime.service).toBeNull();
		expect(runtime.worker).toBeNull();
	});

	test("keeps prompt retention and orphan cleanup active when every write provider is disabled", async () => {
		let purgeCalls = 0;
		const durableStore = createInMemoryGeneratedMediaStore();
		const store = {
			...durableStore,
			async purgeExpiredPrompts() {
				purgeCalls += 1;
				return 1;
			},
		};
		const deleted: string[] = [];
		const objectStorage: GeneratedMediaObjectStorage = {
			async head() {
				return null;
			},
			async put() {},
			async get() {
				throw new Error("not used");
			},
			async delete(key) {
				deleted.push(key);
			},
			async list(prefix) {
				return [
					{
						key: `${prefix}orphan`,
						sizeBytes: 4,
						lastModified: new Date(0),
					},
				];
			},
		};
		const runtime = createGeneratedMediaRuntime({
			env: {
				GENERATED_IMAGE_USAGE_UNITS: "2",
				GENERATED_IMAGE_DAILY_USAGE_LIMIT: "7",
				GENERATED_IMAGE_DAILY_ABUSE_LIMIT: "9",
			},
			store,
			objectStorage,
		});
		const scope = {
			actorUserId: "00000000-0000-4000-8000-000000000401",
			workspaceId: "00000000-0000-4000-8000-000000000402",
			workspaceOwnerUserId: "00000000-0000-4000-8000-000000000401",
			role: "owner" as const,
			status: "active" as const,
			pricingTier: "free",
			isPersonalWorkspace: true,
		};

		expect(runtime.available).toBe(false);
		await expect(runtime.usageSummary(scope)).resolves.toMatchObject({
			image: {
				policy: "trial_metered",
				allowance: { limitUnits: 2, committedUnits: 0, availableUnits: 2 },
				dailyAbuse: { limitUnits: 9, admittedUnits: 0, availableUnits: 9 },
			},
		});
		await expect(runtime.maintenance()).resolves.toEqual({
			promptsPurged: 1,
			objectsDeleted: 2,
			objectFailures: 0,
		});
		expect(purgeCalls).toBe(1);
		expect(deleted).toHaveLength(2);
	});

	test("refuses enabled generation without independent prompt-protection keys", () => {
		expect(() =>
			createGeneratedMediaRuntime({
				env: {
					NARRIFLOW_WRITES_GENERATED_MEDIA: "1",
					NARRIFLOW_WRITES_GENERATED_IMAGES: "1",
					OPENAI_API_KEY: "configured-key",
					OPENAI_IMAGE_MODEL: "configured-model",
				},
			}),
		).toThrow("GENERATED_MEDIA_PROMPT_ENCRYPTION_KEY");
	});

	test("keeps video unavailable without the separately installed provider adapter", () => {
		const runtime = createGeneratedMediaRuntime({
			env: {
				NARRIFLOW_WRITES_GENERATED_MEDIA: "1",
				NARRIFLOW_WRITES_GENERATED_VIDEOS: "1",
				GENERATED_VIDEO_PROVIDER: "approved-video",
				GENERATED_VIDEO_MODEL: "deployment-video-alias",
				GENERATED_VIDEO_MAX_DURATION_SEC: "8",
				GENERATED_VIDEO_MAX_CONCURRENCY: "2",
				GENERATED_VIDEO_USAGE_UNITS: "6",
				GENERATED_VIDEO_MAX_OUTPUT_BYTES: "67108864",
			},
		});

		expect(runtime.available).toBe(false);
		expect(runtime.config.video).toEqual({
			enabled: false,
			reason: "video_provider_adapter_missing",
		});
	});

	test("rejects reused prompt encryption and fingerprint secrets", () => {
		const repeatedSecret = "a-secure-test-secret-with-32-characters";
		expect(() =>
			createGeneratedMediaRuntime({
				env: {
					NARRIFLOW_WRITES_GENERATED_MEDIA: "1",
					NARRIFLOW_WRITES_GENERATED_IMAGES: "1",
					OPENAI_API_KEY: "configured-key",
					OPENAI_IMAGE_MODEL: "configured-model",
					GENERATED_MEDIA_PROMPT_ENCRYPTION_KEY: repeatedSecret,
					GENERATED_MEDIA_PROMPT_ACTIVE_KEY_VERSION: "test-primary",
					GENERATED_MEDIA_PROMPT_FINGERPRINT_KEY: repeatedSecret,
				},
			}),
		).toThrow("must be independent");
	});
});
