import { describe, expect, test } from "bun:test";
import { createProductionModule, GeneratedMediaService } from "./generated-media-runtime";
import { generatedImageCapability, generatedImagePolicy } from "./generation-usage";

const scope = {
  actorUserId: "user-1",
  workspaceId: "workspace-1",
  workspaceOwnerUserId: "user-1",
  role: "owner" as const,
  status: "active" as const,
  pricingTier: "creator",
  isPersonalWorkspace: true,
};

const configured = {
  OPENAI_API_KEY: "test-key-never-sent",
  OPENAI_IMAGE_MODEL: "gpt-image-2",
  GENERATED_MEDIA_PROMPT_ACTIVE_KEY_VERSION: "test-v1",
  GENERATED_MEDIA_PROMPT_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  GENERATED_MEDIA_PROMPT_DECRYPTION_KEYS_JSON: "{}",
  GENERATED_MEDIA_PROMPT_FINGERPRINT_KEY: Buffer.alloc(32, 2).toString("base64"),
};

describe("generation access", () => {
  test("Free meters the lifetime image sample; paid plans meter by month", () => {
    expect(generatedImagePolicy("free")).toBe("trial_metered");
    expect(generatedImagePolicy("creator")).toBe("metered");
    expect(generatedImagePolicy("business")).toBe("metered");
  });

  test("admits included image generation without deployment switches", () => {
    expect(generatedImageCapability(scope, configured)).toMatchObject({ available: true, reason: "available", usage: "metered" });
    expect(generatedImageCapability({ ...scope, pricingTier: "free" }, configured)).toMatchObject({ available: true, reason: "available", usage: "trial_metered" });
  });

  test("reports a missing or malformed provider setup as temporarily unavailable, not a plan limit", () => {
    for (const environment of [
      {},
      { ...configured, OPENAI_IMAGE_MODEL: "" },
      { ...configured, GENERATED_MEDIA_PROMPT_DECRYPTION_KEYS_JSON: undefined },
      { ...configured, GENERATED_MEDIA_PROMPT_ENCRYPTION_KEY: "not-a-32-byte-key" },
    ]) {
      expect(generatedImageCapability(scope, environment)).toEqual({ available: false, reason: "provider_unavailable", usage: "metered" });
      expect(generatedImageCapability({ ...scope, pricingTier: "free" }, environment)).toMatchObject({ reason: "provider_unavailable" });
    }
  });

  test("admission without provider setup refuses with a typed unavailable failure", async () => {
    const service = new GeneratedMediaService(() => createProductionModule({}));
    await expect(Promise.resolve().then(() => service.create(scope, {} as never))).rejects.toMatchObject({
      code: "generated_media_provider_not_configured",
      kind: "unavailable",
    });
  });
});
