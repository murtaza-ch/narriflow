import { describe, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { publicOpenApiDocument } from "./public-openapi";

describe("docs site OpenAPI file", () => {
  test("matches the document the REST API serves", async () => {
    const committed = await readFile(new URL("../../../docs/api-reference/openapi.json", import.meta.url), "utf8");
    if (committed !== (await publicOpenApiDocument())) {
      throw new Error("apps/docs/api-reference/openapi.json is out of date. Run `bun run --cwd apps/docs openapi` and commit the result.");
    }
  });
});
