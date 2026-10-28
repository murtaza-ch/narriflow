import type { RestRoutes } from "@narriflow/api/types/rest";
import { hc } from "hono/client";

export type { RestRoutes };

export interface RestClientOptions {
  baseUrl: string;
  apiKey(): string | Promise<string>;
  fetch?: typeof globalThis.fetch;
}

/** Public v1 uses API keys, independently of the first-party Clerk transport. */
export function createRestClient(options: RestClientOptions) {
  const fetcher = options.fetch ?? globalThis.fetch;
  return hc<RestRoutes>(`${new URL(options.baseUrl).origin}/api/v1`, {
    fetch: (async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${await options.apiKey()}`);
      headers.delete("X-Workspace-Id");
      return fetcher(input, { ...init, headers, credentials: "omit" });
    }) as typeof globalThis.fetch,
  });
}

export type RestClient = ReturnType<typeof createRestClient>;
