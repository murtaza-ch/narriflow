import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DOCS_API_ORIGIN_PLACEHOLDER, docsApiOrigin, withDocsApiOrigin } from "./api-origin";

function mdxFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? mdxFiles(path) : path.endsWith(".mdx") ? [path] : [];
  });
}

describe("docs API origin", () => {
  test("replaces the placeholder everywhere it appears", () => {
    const text = `curl ${DOCS_API_ORIGIN_PLACEHOLDER}/api/v1/events and ${DOCS_API_ORIGIN_PLACEHOLDER}/mcp`;
    expect(withDocsApiOrigin(text, "https://api.example.test")).toBe("curl https://api.example.test/api/v1/events and https://api.example.test/mcp");
  });

  test("the origin is the configured public API URL without a trailing slash, else the local API", () => {
    expect(docsApiOrigin({ NEXT_PUBLIC_API_URL: "https://api.example.test/" })).toBe("https://api.example.test");
    expect(docsApiOrigin({})).toBe("http://localhost:4000");
  });

  test("no docs page names the retired web origin for API or MCP addresses", () => {
    const offenders = mdxFiles(join(import.meta.dir, "../../content/docs")).filter((file) =>
      /https:\/\/app\.narriflow\.com\/(?:api|mcp|\.well-known)|NARRIFLOW_URL=https:\/\/app\.narriflow\.com/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
