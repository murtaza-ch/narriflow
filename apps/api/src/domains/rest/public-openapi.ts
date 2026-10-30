import { createRestOpenApiRoutes, restOpenApiDocument } from "./routes";

/** Stable artifact origin; deployed servers and docs project their configured API origin. */
export const PUBLIC_API_ORIGIN = "http://localhost:4000";

/** Construct the actual route definitions without starting the API or calling any provider. */
export function publicOpenApiDocument(origin = PUBLIC_API_ORIGIN) {
  const app = createRestOpenApiRoutes({
    checkRateLimit: async () => { throw new Error("OpenAPI generation must not call the limiter"); },
    readRateLimit: async () => { throw new Error("OpenAPI generation must not call the limiter"); },
    apiOrigin: () => origin,
    webOrigin: () => "http://localhost:3000",
    corsAllowedOrigins: [],
    log: () => {},
  });
  return restOpenApiDocument(app, origin);
}
