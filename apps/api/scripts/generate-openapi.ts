import { readFile, writeFile } from "node:fs/promises";
import { publicOpenApiDocument } from "../src/domains/rest/public-openapi";

const artifact = new URL("../../../packages/api-client/src/openapi/public-v1.json", import.meta.url);
const document = publicOpenApiDocument();
const normalize = (value: object) => JSON.stringify({ ...value, servers: [] }, null, 2);
if (process.argv.includes("--check")) {
  const committed = JSON.parse(await readFile(artifact, "utf8")) as object;
  if (normalize(document) !== normalize(committed)) {
    throw new Error("Public OpenAPI artifact is stale. Run bun run --cwd apps/api openapi:generate");
  }
  console.log("Public OpenAPI artifact matches all 31 REST operations");
} else {
  await writeFile(artifact, `${JSON.stringify(document, null, 2)}\n`);
  console.log("Generated packages/api-client/src/openapi/public-v1.json");
}
