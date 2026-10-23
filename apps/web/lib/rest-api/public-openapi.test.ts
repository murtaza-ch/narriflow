import { describe, expect, test } from "bun:test";
import { createRestApi } from "./app";
import { PUBLIC_API_ORIGIN, publicOpenApiDocument } from "./public-openapi";

describe("public OpenAPI document", () => {
  test("is the document the REST API serves, which the docs render", async () => {
    const app = createRestApi({
      checkRateLimit: async () => ({ allowed: true, availability: "available", remaining: 0, limit: 0 }),
      appOrigin: () => PUBLIC_API_ORIGIN,
      log: () => {},
    });
    const served = await app.request(`${PUBLIC_API_ORIGIN}/api/v1/openapi.json`);
    expect(served.status).toBe(200);
    expect(publicOpenApiDocument()).toEqual(await served.json());
  });
});
