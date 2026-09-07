import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { RssEpisodeInput } from "@narriflow/validators";
import {
  guardedFetch,
  readResponseTextBounded,
  RemoteFetchError,
  type FetchImplementation,
  type HostResolver,
} from "./url-guard";

// Some long-running podcast feeds are substantially larger than 5 MiB (for
// example, daily shows with several thousand entries). Keep the response
// bounded, but high enough to accept production podcast feeds.
export const MAX_RSS_FEED_BYTES = 25 * 1024 * 1024;
export const MAX_RSS_EPISODES = 500;
const RSS_FETCH_TIMEOUT_MS = 15_000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Entity expansion remains disabled. We decode only XML's five predefined
  // entities and numeric character references below, so remote DTDs/custom
  // entities can never expand inside the process.
  processEntities: false,
  trimValues: true,
});

type XmlRecord = Record<string, unknown>;

export type RssFeedSnapshot = {
  title: string | null;
  episodes: RssEpisodeInput[];
  etag: string | null;
  lastModified: string | null;
  finalUrl: string;
  notModified: boolean;
};

export type FetchRssFeedOptions = {
  etag?: string | null;
  lastModified?: string | null;
  /** Test/contract injection; production callers use guardedFetch defaults. */
  fetchImpl?: FetchImplementation;
  resolver?: HostResolver;
};

import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";

const rssFeedFailureCatalog = {
  rss_invalid_xml: "unprocessable",
  rss_no_media_episodes: "unprocessable",
  rss_unsupported_document: "unprocessable",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type RssFeedFailureCode = keyof typeof rssFeedFailureCatalog;

export class RssFeedError extends ExpectedDomainFailureError<RssFeedFailureCode> {
  constructor(code: RssFeedFailureCode) {
    super({
      code,
      kind: rssFeedFailureCatalog[code],
      message: "The RSS feed could not be used",
    });
    this.name = "RssFeedError";
  }
}

export function redactUrlForDisplay(value: string): string {
  try {
    const url = new URL(value);
    // Private podcast tokens can appear in either query strings or opaque path
    // segments. Persist/display only the origin; the full URL remains confined
    // to the encrypted database job/rule fields needed by the worker.
    // Keep the display-safe form US-ASCII. This value is also used as
    // diagnostic S3/R2 object metadata, whose REST headers must be ASCII.
    return `${url.origin}/...`;
  } catch {
    return value;
  }
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is XmlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decode character references without enabling XML DTD/entity expansion. */
export function decodeXmlText(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g,
    (entity) => {
      switch (entity) {
        case "&amp;":
          return "&";
        case "&lt;":
          return "<";
        case "&gt;":
          return ">";
        case "&quot;":
          return '"';
        case "&apos;":
          return "'";
        default: {
          const radix = entity.startsWith("&#x") ? 16 : 10;
          const raw = entity.slice(radix === 16 ? 3 : 2, -1);
          const codePoint = Number.parseInt(raw, radix);
          if (
            !Number.isInteger(codePoint) ||
            codePoint <= 0 ||
            codePoint > 0x10ffff ||
            (codePoint >= 0xd800 && codePoint <= 0xdfff)
          ) {
            return entity;
          }
          return String.fromCodePoint(codePoint);
        }
      }
    },
  );
}

/** Normalize fast-xml-parser scalar nodes, including attributed text nodes. */
export function xmlScalar(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    const normalized = decodeXmlText(String(value)).trim();
    return normalized || null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const normalized = xmlScalar(entry);
      if (normalized) return normalized;
    }
    return null;
  }
  if (isRecord(value)) {
    return xmlScalar(value["#text"] ?? value.__cdata);
  }
  return null;
}

export function parseItunesDuration(value: unknown): number | null {
  const normalized = xmlScalar(value);
  if (!normalized) return null;

  const parts = normalized.split(":").map((part) => Number(part));
  if (
    parts.length < 1 ||
    parts.length > 3 ||
    parts.some((part) => !Number.isFinite(part) || part < 0)
  ) {
    return null;
  }

  const seconds =
    parts.length === 3
      ? parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
      : parts.length === 2
        ? parts[0]! * 60 + parts[1]!
        : parts[0]!;
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

function makeEpisodeId(seed: string) {
  return createHash("sha256").update(seed).digest("hex");
}

function normalizedHttpUrl(value: unknown, baseUrl: string): string | null {
  const raw = xmlScalar(value);
  if (!raw) return null;
  try {
    const url = new URL(raw, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function attribute(record: XmlRecord, name: string): unknown {
  return record[`@_${name}`] ?? record[name];
}

function selectEnclosure(
  item: XmlRecord,
  baseUrl: string,
  isAtom: boolean,
): { url: string; mimeType: string | null } | null {
  const candidates: unknown[] = [];
  if (isAtom) {
    candidates.push(...toArray(item.link));
  } else {
    candidates.push(...toArray(item.enclosure));
    candidates.push(...toArray(item["media:content"]));
  }

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      if (isAtom) continue;
      const url = normalizedHttpUrl(candidate, baseUrl);
      if (url) return { url, mimeType: null };
      continue;
    }
    if (!isRecord(candidate)) continue;

    const relation = xmlScalar(attribute(candidate, "rel"))?.toLowerCase();
    if (isAtom && relation !== "enclosure") continue;

    const url = normalizedHttpUrl(
      attribute(candidate, isAtom ? "href" : "url") ??
        attribute(candidate, "href"),
      baseUrl,
    );
    if (!url) continue;

    return {
      url,
      mimeType: xmlScalar(attribute(candidate, "type")),
    };
  }
  return null;
}

function parsePublishedAt(item: XmlRecord): string | null {
  const raw = xmlScalar(
    item.pubDate ??
      item.published ??
      item.updated ??
      item["dc:date"],
  );
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function compareEpisodes(
  a: RssEpisodeInput & { sourceIndex: number },
  b: RssEpisodeInput & { sourceIndex: number },
) {
  const aTime = a.publishedAt ? Date.parse(a.publishedAt) : Number.NEGATIVE_INFINITY;
  const bTime = b.publishedAt ? Date.parse(b.publishedAt) : Number.NEGATIVE_INFINITY;
  return bTime - aTime || a.sourceIndex - b.sourceIndex;
}

export function parseRssFeed(
  xml: string,
  feedUrl: string,
  maxEpisodes = MAX_RSS_EPISODES,
): Pick<RssFeedSnapshot, "title" | "episodes"> {
  if (XMLValidator.validate(xml) !== true) {
    throw new RssFeedError("rss_invalid_xml");
  }

  let parsed: XmlRecord;
  try {
    parsed = parser.parse(xml) as XmlRecord;
  } catch {
    throw new RssFeedError("rss_invalid_xml");
  }

  const rss = isRecord(parsed.rss) ? parsed.rss : null;
  const channel = rss && isRecord(rss.channel) ? rss.channel : null;
  const atom = isRecord(parsed.feed) ? parsed.feed : null;
  if (!channel && !atom) {
    throw new RssFeedError("rss_unsupported_document");
  }

  const isAtom = Boolean(atom && !channel);
  const container = channel ?? atom!;
  const items = toArray(container[isAtom ? "entry" : "item"]).filter(isRecord);
  const normalized: Array<RssEpisodeInput & { sourceIndex: number }> = [];
  const seenEnclosures = new Set<string>();
  const seenIds = new Set<string>();

  for (const [sourceIndex, item] of items.entries()) {
    const enclosure = selectEnclosure(item, feedUrl, isAtom);
    if (!enclosure || seenEnclosures.has(enclosure.url)) continue;

    const title = xmlScalar(item.title) ?? "Untitled episode";
    const publishedAt = parsePublishedAt(item);
    const canonicalIdentity = xmlScalar(item.guid ?? item.id) ?? enclosure.url;
    let id = makeEpisodeId(canonicalIdentity);
    if (seenIds.has(id)) {
      // Broken publishers occasionally reuse a GUID. Preserve a stable unique
      // identity by incorporating the authoritative enclosure URL.
      id = makeEpisodeId(`${canonicalIdentity}\0${enclosure.url}`);
    }
    if (seenIds.has(id)) continue;

    seenIds.add(id);
    seenEnclosures.add(enclosure.url);
    normalized.push({
      id,
      title,
      enclosureUrl: enclosure.url,
      publishedAt,
      durationSeconds: parseItunesDuration(
        item["itunes:duration"] ?? item.duration,
      ),
      mimeType: enclosure.mimeType,
      sourceIndex,
    });
  }

  if (normalized.length === 0) {
    throw new RssFeedError("rss_no_media_episodes");
  }

  normalized.sort(compareEpisodes);
  return {
    title: xmlScalar(container.title),
    episodes: normalized.slice(0, Math.max(1, maxEpisodes)).map(
      ({ sourceIndex: _sourceIndex, ...episode }) => episode,
    ),
  };
}

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
    timeoutMs: RSS_FETCH_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
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

export async function fetchRssEpisodes(rssUrl: string): Promise<RssEpisodeInput[]> {
  return (await fetchRssFeed(rssUrl)).episodes;
}
