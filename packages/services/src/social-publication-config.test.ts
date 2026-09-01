import { describe, expect, test } from "bun:test";
import {
  isSocialProviderPublishingEnabled,
  parseSocialPublicationConfig,
  SOCIAL_PROVIDER_CAPABILITIES,
  socialPublicationCapabilityVersion,
  SocialPublicationConfigurationError,
} from "./social-publication-config";

const valid = {
  SOCIAL_PUBLISH_BATCH_SIZE: "20",
  SOCIAL_PUBLISH_CONCURRENCY: "4",
  SOCIAL_PUBLISH_LEASE_MS: "60000",
  SOCIAL_PUBLISH_HEARTBEAT_MS: "15000",
  SOCIAL_PUBLISH_PROVIDER_DEADLINE_MS: "30000",
  SOCIAL_PUBLISH_PROVIDER_CALL_BUDGET: "12",
  SOCIAL_PUBLISH_MAX_ATTEMPTS: "4",
  SOCIAL_PUBLISH_MAX_ELAPSED_MS: "86400000",
  SOCIAL_PUBLISH_RETRY_BASE_MS: "30000",
  SOCIAL_PUBLISH_RETRY_MAX_MS: "900000",
  SOCIAL_PUBLISH_PROCESSING_DEADLINE_MS: "86400000",
  SOCIAL_PUBLISH_RECONCILIATION_DEADLINE_MS: "86400000",
  SOCIAL_PUBLICATION_CHECKPOINT_KEY: "test-checkpoint-key-with-at-least-32-characters",
  META_GRAPH_VERSION: "v24.0",
  LINKEDIN_API_VERSION: "202608",
  SOCIAL_PUBLISH_WEBHOOK_URL: "https://receiver.example/narriflow",
  SOCIAL_PUBLISH_WEBHOOK_SECRET: "test-webhook-secret-with-at-least-32-characters",
  SOCIAL_PUBLISH_WEBHOOK_DEADLINE_MS: "10000",
  SOCIAL_PUBLISH_WEBHOOK_MAX_RESPONSE_BYTES: "65536",
  SOCIAL_PUBLISH_WEBHOOK_REDIRECT_POLICY: "error",
  SOCIAL_PUBLISH_WEBHOOK_RECONCILIATION_MAX_MS: "3600000",
};

describe("Social Publication configuration", () => {
  test("keeps Facebook connection metadata visible while publishing remains dark", () => {
    expect(SOCIAL_PROVIDER_CAPABILITIES.facebook_reels).toMatchObject({
      apiVersion: "v24.0",
      connectionEnabled: true,
      publishingEnabledByDefault: false,
      requiredScopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
    });
    expect(socialPublicationCapabilityVersion("facebook_reels")).toBe("facebook-reels-2026-08-31");
    expect(isSocialProviderPublishingEnabled("facebook_reels", {})).toBe(false);
    expect(isSocialProviderPublishingEnabled("facebook_reels", { FACEBOOK_REELS_PUBLISHING_ENABLED: "1" })).toBe(true);
  });

  test("parses finite bounded worker and receiver policy once", () => {
    expect(parseSocialPublicationConfig(valid)).toMatchObject({
      worker: {
        batchSize: 20,
        concurrency: 4,
        leaseMs: 60_000,
        heartbeatMs: 15_000,
        providerCallBudget: 12,
      },
      webhook: {
        url: "https://receiver.example/narriflow",
        redirectPolicy: "error",
        maxResponseBytes: 65_536,
      },
		providers: {
			youtubeApiVersion: "v3",
			youtubeChunkBytes: 8 * 1024 * 1024,
			metaGraphVersion: "v24.0",
			facebookReelsPublishingEnabled: false,
			tiktokApiVersion: "v2",
			tiktokChunkBytes: 64 * 1024 * 1024,
			linkedInVersion: "202608",
			xApiVersion: "v2",
			xChunkBytes: 4 * 1024 * 1024,
			xMaxMediaBytes: 512 * 1024 * 1024,
			xRateLimitRetryFloorMs: 60_000,
			xReconciliationMaxPages: 5,
		},
    });
  });

  test.each([
    ["non-finite concurrency", { SOCIAL_PUBLISH_CONCURRENCY: "Infinity" }],
    ["zero batch", { SOCIAL_PUBLISH_BATCH_SIZE: "0" }],
    ["heartbeat not below half the lease", { SOCIAL_PUBLISH_HEARTBEAT_MS: "30000" }],
    ["unbounded retry attempts", { SOCIAL_PUBLISH_MAX_ATTEMPTS: "1000" }],
    ["missing provider version", { META_GRAPH_VERSION: "" }],
    ["unsupported Meta provider version", { META_GRAPH_VERSION: "v25.0" }],
    ["unsupported LinkedIn provider version", { LINKEDIN_API_VERSION: "202609" }],
		["unsupported YouTube provider version", { YOUTUBE_API_VERSION: "v4" }],
		["unsupported TikTok provider version", { TIKTOK_API_VERSION: "v3" }],
		["unsupported X provider version", { X_API_VERSION: "v3" }],
		["misaligned YouTube chunk", { YOUTUBE_UPLOAD_CHUNK_BYTES: "300000" }],
		["oversized TikTok chunk", { TIKTOK_UPLOAD_CHUNK_BYTES: "68157440" }],
		["oversized X chunk", { X_UPLOAD_CHUNK_BYTES: "6291456" }],
		["oversized X media limit", { X_MAX_MEDIA_BYTES: "536870913" }],
		["unsafe X rate retry floor", { X_RATE_LIMIT_RETRY_FLOOR_MS: "999" }],
		["unbounded X reconciliation", { X_RECONCILIATION_MAX_PAGES: "11" }],
		["unsafe TikTok polling rate", { TIKTOK_STATUS_POLL_INTERVAL_MS: "1000" }],
    ["insecure receiver URL", { SOCIAL_PUBLISH_WEBHOOK_URL: "http://receiver.example/hook" }],
    ["short signing secret", { SOCIAL_PUBLISH_WEBHOOK_SECRET: "short" }],
    ["redirect following", { SOCIAL_PUBLISH_WEBHOOK_REDIRECT_POLICY: "follow" }],
  ])("rejects %s", (_label, override) => {
    expect(() => parseSocialPublicationConfig({ ...valid, ...override })).toThrow(
      SocialPublicationConfigurationError,
    );
	});

	test("fails startup before the pinned LinkedIn version sunset becomes unsafe", () => {
		expect(() =>
			parseSocialPublicationConfig(
				valid,
				new Date("2027-08-02T00:00:00.000Z"),
			),
		).toThrow(SocialPublicationConfigurationError);
	});
});
