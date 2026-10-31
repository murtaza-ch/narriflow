import type { PexelsVideo } from "@narriflow/services/pexels-contract";
import type { PexelsSearchCachePort } from "@narriflow/services/pexels.service";

const CACHE_ENTRY_MAX_BYTES = 2 * 1024 * 1024;

/** Public stock metadata only. Requests are Cache API keys, never network fetches. */
export function createPexelsSearchCache(cache: Pick<Cache, "match" | "put">): PexelsSearchCachePort {
  const requestFor = async (key: string) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const name = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return new Request(`https://narriflow-cache.invalid/pexels/v1/${name}`);
  };
  return {
    async get(key) {
      const response = await cache.match(await requestFor(key));
      if (!response) return null;
      const value: unknown = await response.json();
      return Array.isArray(value) ? value as PexelsVideo[] : null;
    },
    async set(key, videos, ttlSeconds) {
      const body = JSON.stringify(videos);
      if (new TextEncoder().encode(body).byteLength > CACHE_ENTRY_MAX_BYTES) return;
      await cache.put(await requestFor(key), new Response(body, {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${Math.max(1, Math.min(86_400, Math.ceil(ttlSeconds)))}` },
      }));
    },
  };
}
