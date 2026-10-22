import { createRestApi } from "./app";

/** The OpenAPI 3.1 document of the public REST API as served from production.
 * The docs site commits it as apps/docs/api-reference/openapi.json; regenerate
 * it with `bun run --cwd apps/docs openapi`. */
export const PUBLIC_API_ORIGIN = "https://app.narriflow.com";

export async function publicOpenApiDocument(): Promise<string> {
  const app = createRestApi({
    checkRateLimit: async () => ({ allowed: true, availability: "available", remaining: 0, limit: 0 }),
    appOrigin: () => PUBLIC_API_ORIGIN,
    log: () => {},
  });
  const response = await app.request(`${PUBLIC_API_ORIGIN}/api/v1/openapi.json`);
  if (!response.ok) throw new Error(`The OpenAPI document returned HTTP ${response.status}`);
  return `${JSON.stringify(await response.json(), null, 2)}\n`;
}
