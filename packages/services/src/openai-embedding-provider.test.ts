import { describe, expect, test } from "bun:test";
import {
  createOpenAiEmbeddingProvider,
  EmbeddingProviderError,
  LIBRARY_EMBEDDING_DIMENSIONS,
  LIBRARY_EMBEDDING_MODEL,
} from "./openai-embedding-provider";

const vector = (seed: number) => Array.from({ length: LIBRARY_EMBEDDING_DIMENSIONS }, (_, index) => (index === seed ? 1 : 0));

function providerReturning(respond: (request: { url: string; init: RequestInit }) => Response | Promise<Response>) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const provider = createOpenAiEmbeddingProvider({
    apiKey: "test-key",
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return respond({ url, init });
    }) as unknown as typeof fetch,
  });
  return { provider, requests };
}

describe("OpenAI embedding provider", () => {
  test("sends one batched request with the pinned model and dimensions", async () => {
    const { provider, requests } = providerReturning(() =>
      Response.json({ data: [{ index: 0, embedding: vector(0) }, { index: 1, embedding: vector(1) }], usage: { total_tokens: 42 } }));
    const result = await provider.embed(["first", "second"]);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.openai.com/v1/embeddings");
    expect((requests[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(requests[0]!.init.body as string)).toEqual({
      model: LIBRARY_EMBEDDING_MODEL, input: ["first", "second"], dimensions: LIBRARY_EMBEDDING_DIMENSIONS, encoding_format: "float",
    });
    expect(result.tokens).toBe(42);
    expect(result.vectors).toHaveLength(2);
  });

  test("returns vectors in input order even when the provider does not", async () => {
    const { provider } = providerReturning(() =>
      Response.json({ data: [{ index: 1, embedding: vector(1) }, { index: 0, embedding: vector(0) }], usage: { total_tokens: 2 } }));
    const { vectors } = await provider.embed(["a", "b"]);
    expect(vectors[0]![0]).toBe(1);
    expect(vectors[1]![1]).toBe(1);
  });

  test("cuts oversized inputs below the provider limit", async () => {
    const { provider, requests } = providerReturning(() => Response.json({ data: [{ index: 0, embedding: vector(0) }] }));
    await provider.embed(["x".repeat(50_000)]);
    expect((JSON.parse(requests[0]!.init.body as string).input as string[])[0]!.length).toBe(4_000);
  });

  test("makes no request without an API key or without input", async () => {
    let called = false;
    const unconfigured = createOpenAiEmbeddingProvider({ apiKey: undefined, fetch: (async () => { called = true; return new Response(); }) as unknown as typeof fetch });
    expect(unconfigured.configured).toBe(false);
    await expect(unconfigured.embed(["text"])).rejects.toMatchObject({ code: "embedding_not_configured" });

    const { provider, requests } = providerReturning(() => new Response());
    expect(await provider.embed([])).toEqual({ vectors: [], tokens: 0 });
    expect(requests).toHaveLength(0);
    expect(called).toBe(false);
  });

  test("reports failed requests with the provider status", async () => {
    const { provider } = providerReturning(() => new Response("rate limited", { status: 429 }));
    const error = await provider.embed(["text"]).catch((caught) => caught);
    expect(error).toBeInstanceOf(EmbeddingProviderError);
    expect(error).toMatchObject({ code: "embedding_request_failed", status: 429 });
  });

  test("reports network failures without leaking the key", async () => {
    const provider = createOpenAiEmbeddingProvider({ apiKey: "secret-key", fetch: (async () => { throw new Error("socket closed"); }) as unknown as typeof fetch });
    const error = await provider.embed(["text"]).catch((caught) => caught);
    expect(error).toMatchObject({ code: "embedding_request_failed", status: null });
    expect(String(error.message)).not.toContain("secret-key");
  });

  test("rejects responses with the wrong count or dimensions", async () => {
    const wrongCount = providerReturning(() => Response.json({ data: [{ index: 0, embedding: vector(0) }] }));
    await expect(wrongCount.provider.embed(["a", "b"])).rejects.toMatchObject({ code: "embedding_bad_response" });
    const wrongSize = providerReturning(() => Response.json({ data: [{ index: 0, embedding: [0.1, 0.2] }] }));
    await expect(wrongSize.provider.embed(["a"])).rejects.toMatchObject({ code: "embedding_bad_response" });
    const notJson = providerReturning(() => new Response("<html>", { status: 200 }));
    await expect(notJson.provider.embed(["a"])).rejects.toMatchObject({ code: "embedding_bad_response" });
  });
});
