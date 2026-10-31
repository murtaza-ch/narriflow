import type { RssFeedSnapshot } from "@narriflow/validators/outbound-probe";
import { MAX_RSS_FEED_BYTES, parseRssFeed } from "@narriflow/services/rss-parser";
import { guardedFetch, readResponseTextBounded, RemoteFetchError, type PinnedTransport, type HostResolver } from "./outbound-transport";
const RSS_FETCH_TIMEOUT_MS = 15_000;
export type FetchRssFeedOptions = { etag?: string | null; lastModified?: string | null; transport?: PinnedTransport; resolver?: HostResolver; signal?: AbortSignal };
export async function fetchRssFeed(
  rssUrl: string,
  options: FetchRssFeedOptions = {},
): Promise<RssFeedSnapshot> {
  const headers: Record<string, string> = {
    "user-agent": "NarriflowBot/1.0 (+https://narriflow.app)",
    accept:
      "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
  };
  if (options.etag) headers["if-none-match"] = options.etag;
  if (options.lastModified) {
    headers["if-modified-since"] = options.lastModified;
  }

  const response = await guardedFetch(rssUrl, {
    headers,
    signal: options.signal,
    timeoutMs: RSS_FETCH_TIMEOUT_MS,
    transport: options.transport,
    resolver: options.resolver,
  });

  const finalUrl = response.url || rssUrl;
  if (response.status === 304) {
    await response.body?.cancel().catch(() => undefined);
    return {
      title: null,
      episodes: [],
      etag: options.etag ?? null,
      lastModified: options.lastModified ?? null,
      finalUrl,
      notModified: true,
    };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new RemoteFetchError("remote_download_failed");
  }

  const xml = await readResponseTextBounded(response, MAX_RSS_FEED_BYTES);
  const parsed = parseRssFeed(xml, finalUrl);
  return {
    ...parsed,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
    finalUrl,
    notModified: false,
  };
}

