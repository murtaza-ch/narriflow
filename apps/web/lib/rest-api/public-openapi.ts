import { createRestApi, openApiDocumentConfig } from "./app";

/** The OpenAPI 3.1 document of the public REST API as served from production. The docs render their API reference from it. */
export const PUBLIC_API_ORIGIN = "https://app.narriflow.com";

export function publicOpenApiDocument() {
  const app = createRestApi({
    checkRateLimit: async () => ({ allowed: true, availability: "available", remaining: 0, limit: 0 }),
    appOrigin: () => PUBLIC_API_ORIGIN,
    log: () => {},
  });
  return app.getOpenAPI31Document(openApiDocumentConfig(PUBLIC_API_ORIGIN));
}
