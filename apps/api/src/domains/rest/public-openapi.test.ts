import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { SCRIBE_LANGUAGE_CODES } from "@narriflow/validators";
import { publicV1Document } from "../../../../../packages/api-client/src/openapi";
import { PUBLIC_API_ORIGIN, publicOpenApiDocument } from "./public-openapi";
import { createRestRoutes } from "./routes";

const normalize = (document: object) => ({ ...document, servers: [] });

describe("public OpenAPI document", () => {
  test("the generated artifact matches the actual routes after origin projection", async () => {
    const origin = "https://configured-api.example.com";
    const app = new Hono().route("/api/v1", createRestRoutes({
      checkRateLimit: async () => { throw new Error("The document must not authenticate"); },
      readRateLimit: async () => { throw new Error("The document must not authenticate"); },
      apiOrigin: () => origin,
      webOrigin: () => "https://web.example.com",
      corsAllowedOrigins: [],
      log: () => {},
    }));
    const served = await app.request("https://untrusted-host.example/api/v1/openapi.json");
    expect(served.status).toBe(200);
    const document = await served.json();
    expect(document.servers).toEqual([{ url: origin }]);
    expect(document).toEqual(publicOpenApiDocument(origin));
    expect(normalize(document)).toEqual(normalize(publicV1Document));
    expect(publicV1Document.servers).toEqual([{ url: PUBLIC_API_ORIGIN }]);
    expect(Object.values(document.paths).flatMap((path) => Object.keys(path as object))).toHaveLength(31);
  });

  test("docs load only the generated document, without backend runtime imports", async () => {
    const result = await Bun.build({
      entrypoints: [new URL("../../../../web/lib/docs/openapi.ts", import.meta.url).pathname],
      target: "browser",
      write: false,
    });
    expect(result.success).toBe(true);
    const output = await result.outputs[0]!.text();
    expect(output).not.toMatch(/IntegrationAdmission|authenticateApiKey|PrismaClient|DATABASE_URL|OPENAI_API_KEY|CLERK_SECRET_KEY/);
    expect(output).toContain("Narriflow API");
  });

  test("every language field is the Scribe registry, and the document names no provider, model or accuracy", () => {
    const schemas = publicV1Document.components.schemas as Record<string, { properties?: Record<string, { enum?: unknown[] }> }>;
    expect(schemas.GenerationSettings?.properties?.languageCode?.enum).toEqual([...SCRIBE_LANGUAGE_CODES, null]);
    expect(JSON.stringify(publicV1Document)).not.toMatch(/assembly|universal-?\d|accuracy|\bscribe\b|elevenlabs/i);
  });
});
