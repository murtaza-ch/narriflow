import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import { LibrarySearch, LibrarySearchError, lexicalQueryText, planEmbeddingBatches } from "./library-search";
import { EmbeddingProviderError, type EmbeddingProvider } from "./openai-embedding-provider";

const scope = { actorUserId: "00000000-0000-4000-8000-000000000001", workspaceId: "00000000-0000-4000-8000-000000000002" };
// These paths finish before any query runs, so a database that throws proves it.
const noDatabase = new Proxy({}, { get: () => { throw new Error("the database must not be used"); } }) as unknown as PrismaClient;

function embeddings(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return { model: "test-model", configured: true, embed: async () => ({ vectors: [], tokens: 0 }), ...overrides };
}

describe("lexicalQueryText", () => {
  test("keeps words only, so query syntax never reaches Postgres", () => {
    expect(lexicalQueryText(`"Pricing" -strategy & (ads | seo); DROP TABLE`)).toBe("pricing or strategy or ads or seo or drop or table");
  });

  test("deduplicates, caps the term count, and keeps non-English words", () => {
    expect(lexicalQueryText("price price Price")).toBe("price");
    expect(lexicalQueryText(Array.from({ length: 30 }, (_, index) => `word${index}`).join(" "))?.split(" or ")).toHaveLength(12);
    expect(lexicalQueryText("café résumé 2026")).toBe("café or résumé or 2026");
  });

  test("returns null when there is nothing to match", () => {
    expect(lexicalQueryText("?! ... --")).toBeNull();
  });
});

describe("planEmbeddingBatches", () => {
  const passages = (count: number, length = 300) => Array.from({ length: count }, (_, index) => ({ text: `${index}`.padEnd(length, "x") }));

  test("keeps order and splits on the input cap", () => {
    const batches = planEmbeddingBatches(passages(5), { maxInputs: 2, maxEstimatedTokens: 1_000_000 });
    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(batches.flat().map((passage) => passage.text.slice(0, 1))).toEqual(["0", "1", "2", "3", "4"]);
  });

  test("keeps every request under the token budget with the default limits", () => {
    // 3,000 characters is about 1,000 estimated tokens, so 200 fit under 250,000.
    const batches = planEmbeddingBatches(passages(1_000, 3_000));
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(128);
      expect(batch.reduce((total, passage) => total + Math.ceil(passage.text.length / 3), 0)).toBeLessThan(250_000);
    }
  });

  test("counts a long passage at the length the provider will cut it to", () => {
    const [only, ...rest] = planEmbeddingBatches([{ text: "y".repeat(1_000_000) }]);
    expect(rest).toEqual([]);
    expect(only).toHaveLength(1);
    // Two inputs of 4,000 characters (about 1,334 tokens each) exceed a 2,000 token budget.
    expect(planEmbeddingBatches([{ text: "a".repeat(9_000) }, { text: "b".repeat(9_000) }], { maxInputs: 10, maxEstimatedTokens: 2_000 })).toHaveLength(2);
  });

  test("returns no batches for no passages", () => {
    expect(planEmbeddingBatches([])).toEqual([]);
  });
});

describe("LibrarySearch", () => {
  test("refuses queries outside 2 to 300 characters before embedding", async () => {
    let embedded = false;
    const search = new LibrarySearch({ prisma: noDatabase, embeddings: embeddings({ embed: async () => { embedded = true; return { vectors: [], tokens: 0 }; } }) });
    for (const query of ["", " a ", "x".repeat(301)]) {
      await expect(search.search(scope, { query })).rejects.toMatchObject({ code: "library_search_query_invalid", kind: "invalid" });
    }
    expect(embedded).toBe(false);
  });

  test("returns nothing, without embedding, when the project filter is empty", async () => {
    const search = new LibrarySearch({ prisma: noDatabase, embeddings: embeddings({ embed: async () => { throw new Error("must not embed"); } }) });
    expect(await search.search(scope, { query: "pricing", projectIds: [] })).toEqual([]);
  });

  test("reports an embedding failure as temporary unavailability and logs no query text", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const search = new LibrarySearch({
      prisma: noDatabase,
      embeddings: embeddings({ embed: async () => { throw new EmbeddingProviderError("embedding_request_failed", { status: 503 }); } }),
      log: (entry) => logs.push(entry),
    });
    const error = await search.search(scope, { query: "secret board meeting" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(LibrarySearchError);
    expect(error).toMatchObject({ code: "library_search_unavailable", kind: "unavailable" });
    expect(logs).toEqual([{ level: "warn", message: "library_query_embedding_failed", workspaceId: scope.workspaceId, code: "embedding_request_failed" }]);
    expect(JSON.stringify(logs)).not.toContain("secret");
  });

  test("indexing waits quietly while embeddings are not configured", async () => {
    const search = new LibrarySearch({ prisma: noDatabase, embeddings: embeddings({ configured: false }) });
    expect(await search.indexNext()).toBe(0);
  });
});
