import { describe, expect, test } from "bun:test";
import {
  ALL_TEXT_OUTPUT_TYPES,
  contentSuiteLlmResponseSchema,
  contentSuiteLlmResponseSchemaForTypes,
  generateContentSuiteRequestSchema,
  TEXT_OUTPUT_TYPE_LABELS,
} from ".";

describe("content-suite validators", () => {
  test("generate request defaults to all text output types", () => {
    const parsed = generateContentSuiteRequestSchema.parse({});
    expect(parsed.types).toEqual(ALL_TEXT_OUTPUT_TYPES);
  });

  test("every text output type has a label", () => {
    for (const type of ALL_TEXT_OUTPUT_TYPES) {
      expect(TEXT_OUTPUT_TYPE_LABELS[type]).toBeTruthy();
    }
  });

  test("LLM response schema accepts well-formed assets", () => {
    const parsed = contentSuiteLlmResponseSchema.safeParse({
      assets: [
        { type: "blog_post", title: "How we did it", body: "# Heading\n\nBody" },
        { type: "x_thread", title: "Thread", body: "1/ Hook\n2/ Point" },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  test("LLM response schema rejects an unknown asset type", () => {
    const parsed = contentSuiteLlmResponseSchema.safeParse({
      assets: [{ type: "tiktok_script", title: "x", body: "y" }],
    });
    expect(parsed.success).toBe(false);
  });

  test("generate request rejects duplicate asset types", () => {
    expect(
      generateContentSuiteRequestSchema.safeParse({
        types: ["blog_post", "blog_post"],
      }).success,
    ).toBe(false);
  });

  test.each([
    ["empty", []],
    [
      "duplicate",
      [
        { type: "blog_post", title: "One", body: "Body" },
        { type: "blog_post", title: "Two", body: "Body" },
      ],
    ],
    ["missing", [{ type: "blog_post", title: "One", body: "Body" }]],
    [
      "extra",
      [
        { type: "blog_post", title: "One", body: "Body" },
        { type: "quote_cards", title: "Extra", body: "Body" },
      ],
    ],
  ])("exact response schema rejects %s asset sets", (_case, assets) => {
    const schema = contentSuiteLlmResponseSchemaForTypes([
      "blog_post",
      "x_thread",
    ]);
    expect(schema.safeParse({ assets }).success).toBe(false);
  });

  test("exact response schema accepts a complete set in any order", () => {
    const schema = contentSuiteLlmResponseSchemaForTypes([
      "blog_post",
      "x_thread",
    ]);
    expect(
      schema.safeParse({
        assets: [
          { type: "x_thread", title: "Thread", body: "1/ Point" },
          { type: "blog_post", title: "Article", body: "# Article" },
        ],
      }).success,
    ).toBe(true);
  });
});
