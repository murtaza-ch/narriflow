import { describe, expect, test } from "bun:test";

import {
  AssistedCopyProviderConfigurationError,
  createOpenAiAssistedCopyProvider,
} from "./openai-assisted-copy.provider";
import type { AssistedCopyProviderRequest } from "./assisted-copy.service";

const request: AssistedCopyProviderRequest = {
  requestId: "20000000-0000-4000-8000-000000000000",
  platform: "linkedin",
  context: {
    clipId: "20000000-0000-4000-8000-000000000001",
    title: "Recovery before symptoms",
    hook: "The score moved first",
    payoff: "The wearer became sick later",
    brandProfileId: null,
    brandProfileRevision: null,
    voiceGuidance: {
      tone: "measured",
      audience: "coaches",
      preferredPhrases: [],
      avoidedPhrases: [],
    },
  },
  campaignNote: "Lead with a concrete observation.",
  lockedTerms: [],
  sourceDraftId: null,
  promptVersion: "assisted-copy-v1",
  guidanceSkipped: false,
};

describe("OpenAI assisted-copy provider", () => {
  test("uses private structured Responses output and maps usage", async () => {
    let captured: Record<string, unknown> | null = null;
    const provider = createOpenAiAssistedCopyProvider({
      env: { OPENAI_API_KEY: "test-key", OPENAI_COPY_MODEL: "gpt-copy" },
      fetch: async (_url, init) => {
        captured = JSON.parse(String(init?.body));
        return Response.json({
          status: "completed",
          output_text: JSON.stringify({
            caption: "Recovery signals can move before symptoms.",
            hashtags: ["recovery"],
            title: null,
          }),
          usage: { input_tokens: 100, output_tokens: 30 },
        });
      },
    });

    expect(await provider.generate(request)).toMatchObject({
      kind: "completed",
      modelAlias: "gpt-copy",
      usage: { inputTokens: 100, outputTokens: 30 },
    });
    expect(captured).toMatchObject({
      model: "gpt-copy",
      store: false,
      text: { format: { type: "json_schema", strict: true } },
    });
  });

  test("keeps moderation and malformed outcomes explicit", async () => {
    const rejected = createOpenAiAssistedCopyProvider({
      env: { OPENAI_API_KEY: "test-key", OPENAI_COPY_MODEL: "gpt-copy" },
      fetch: async () =>
        Response.json({
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
        }),
    });
    const malformed = createOpenAiAssistedCopyProvider({
      env: { OPENAI_API_KEY: "test-key", OPENAI_COPY_MODEL: "gpt-copy" },
      fetch: async () => Response.json({ status: "completed", output_text: "not json" }),
    });

    expect(await rejected.generate(request)).toMatchObject({
      kind: "rejected",
      errorCode: "assisted_copy_rejected",
    });
    expect(await malformed.generate(request)).toMatchObject({
      kind: "unknown",
      errorCode: "assisted_copy_provider_outcome_unknown",
    });
  });

  test("holds timeout and transport loss as an ambiguous provider outcome", async () => {
    const provider = createOpenAiAssistedCopyProvider({
      env: { OPENAI_API_KEY: "test-key", OPENAI_COPY_MODEL: "gpt-copy" },
      timeoutMs: 5,
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    });

    expect(await provider.generate(request)).toMatchObject({
      kind: "unknown",
      errorCode: "assisted_copy_provider_outcome_unknown",
    });

    const disconnected = createOpenAiAssistedCopyProvider({
      env: { OPENAI_API_KEY: "test-key", OPENAI_COPY_MODEL: "gpt-copy" },
      fetch: async () => {
        throw new TypeError("connection reset after request dispatch");
      },
    });
    expect(await disconnected.generate(request)).toMatchObject({
      kind: "unknown",
      errorCode: "assisted_copy_provider_outcome_unknown",
    });
  });

  test("holds a provider 5xx for reconciliation but keeps a proven 429 retryable", async () => {
    const unavailable = createOpenAiAssistedCopyProvider({
      env: { OPENAI_API_KEY: "test-key", OPENAI_COPY_MODEL: "gpt-copy" },
      fetch: async () => Response.json({ error: { code: "server_error" } }, { status: 503 }),
    });
    const rateLimited = createOpenAiAssistedCopyProvider({
      env: { OPENAI_API_KEY: "test-key", OPENAI_COPY_MODEL: "gpt-copy" },
      fetch: async () => Response.json({ error: { code: "rate_limit" } }, { status: 429 }),
    });

    expect(await unavailable.generate(request)).toMatchObject({
      kind: "unknown",
      errorCode: "assisted_copy_provider_outcome_unknown",
    });
    expect(await rateLimited.generate(request)).toMatchObject({
      kind: "failed",
      errorCode: "assisted_copy_provider_rate_limited",
    });
  });

  test("fails closed when the model alias or credential is missing", () => {
    expect(() => createOpenAiAssistedCopyProvider({ env: {} })).toThrow(
      AssistedCopyProviderConfigurationError,
    );
  });
});
