import { describe, expect, test } from "bun:test";
import {
  parseSocialPublicationConfig,
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
    ["insecure receiver URL", { SOCIAL_PUBLISH_WEBHOOK_URL: "http://receiver.example/hook" }],
    ["short signing secret", { SOCIAL_PUBLISH_WEBHOOK_SECRET: "short" }],
    ["redirect following", { SOCIAL_PUBLISH_WEBHOOK_REDIRECT_POLICY: "follow" }],
  ])("rejects %s", (_label, override) => {
    expect(() => parseSocialPublicationConfig({ ...valid, ...override })).toThrow(
      SocialPublicationConfigurationError,
    );
  });
});
