import { writeFile } from "node:fs/promises";
import { publicOpenApiDocument } from "../../web/lib/rest-api/public-openapi";

// Writes the REST API's OpenAPI document where the docs site reads it.
// Run after any change to apps/web/lib/rest-api: bun run --cwd apps/docs openapi
const target = new URL("../api-reference/openapi.json", import.meta.url);
await writeFile(target, await publicOpenApiDocument());
console.warn(`Wrote ${target.pathname}`);
