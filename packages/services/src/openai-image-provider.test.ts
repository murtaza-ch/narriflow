import { describe, expect, test } from "bun:test";
import {
  GeneratedMediaProviderError,
  createOpenAiImageProvider,
} from "./openai-image-provider";

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("OpenAI image provider", () => {
  test("uses the configured model and maps a portrait medium-quality result", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const provider = createOpenAiImageProvider({
      apiKey: "test-key",
      model: "gpt-image-2",
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return response({
          created: 1_788_220_800,
          data: [{ b64_json: Buffer.from([137, 80, 78, 71]).toString("base64") }],
        }, 200, { "x-request-id": "req_image_1" });
      },
    });

    const outcome = await provider.submit({
      requestId: "job-1",
      prompt: "An editorial photograph of a founder at a train platform",
      aspectRatio: "9:16",
      style: "editorial",
    });

    expect(outcome).toMatchObject({
      kind: "completed",
      providerRef: "req_image_1",
      usage: { images: 1 },
      result: { contentType: "image/png" },
    });
    expect(outcome.kind === "completed" ? [...(outcome.result?.bytes ?? [])] : []).toEqual([137, 80, 78, 71]);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0]!.init.body))).toMatchObject({
      model: "gpt-image-2",
      size: "1024x1536",
      quality: "medium",
      output_format: "png",
      n: 1,
    });
    expect(requests[0]!.init.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Idempotency-Key": "job-1",
    });
  });

  test.each([
    [400, "content_policy_violation", "generated_media_safety_rejected", false],
    [400, "invalid_request_error", "generated_media_provider_validation", false],
    [429, "rate_limit_exceeded", "generated_media_provider_rate_limited", true],
    [503, "server_error", "generated_media_provider_unavailable", true],
  ] as const)("normalizes provider error %s/%s", async (status, providerCode, expectedCode, retryable) => {
    const provider = createOpenAiImageProvider({
      apiKey: "test-key",
      model: "gpt-image-2",
      fetch: async () => response({ error: { code: providerCode, message: "sensitive provider detail" } }, status, { "retry-after": "2" }),
    });

    await expect(provider.submit({
      requestId: `job-${status}`,
      prompt: "A safe prompt",
      aspectRatio: "1:1",
      style: "photoreal",
    })).rejects.toMatchObject({
      code: expectedCode,
      retryable,
      retryAfterMs: retryable ? 2_000 : undefined,
    });
  });

  test("treats a timeout as an unknown outcome", async () => {
    const provider = createOpenAiImageProvider({
      apiKey: "test-key",
      model: "gpt-image-2",
      timeoutMs: 1,
      fetch: async (_url, init) => {
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
        throw new Error("unreachable");
      },
    });

    await expect(provider.submit({
      requestId: "job-timeout",
      prompt: "A safe prompt",
      aspectRatio: "16:9",
      style: "cinematic",
    })).rejects.toEqual(expect.objectContaining({
      code: "generated_media_provider_outcome_unknown",
      outcomeUnknown: true,
    }));
  });

  test("rejects malformed output without exposing the provider payload", async () => {
    const provider = createOpenAiImageProvider({
      apiKey: "test-key",
      model: "gpt-image-2",
      fetch: async () => response({ data: [{ revised_prompt: "not an image" }] }),
    });

    try {
      await provider.submit({
        requestId: "job-malformed",
        prompt: "A safe prompt",
        aspectRatio: "1:1",
        style: "illustration",
      });
      throw new Error("expected provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(GeneratedMediaProviderError);
      expect(error).toMatchObject({ code: "generated_media_provider_malformed_output" });
      expect(String(error)).not.toContain("revised_prompt");
    }
  });

  test("bounds encoded provider output before accepting decoded bytes", async () => {
    const provider = createOpenAiImageProvider({
      apiKey: "test-key",
      model: "gpt-image-2",
      maxOutputBytes: 4,
      fetch: async () => response({ data: [{ b64_json: Buffer.from(new Uint8Array(8)).toString("base64") }] }),
    });

    await expect(provider.submit({
      requestId: "job-oversized",
      prompt: "A safe prompt",
      aspectRatio: "1:1",
      style: "editorial",
    })).rejects.toMatchObject({ code: "generated_media_provider_output_too_large" });
  });
});
