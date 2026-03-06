import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import type { RssEpisodeInput } from "@narriflow/validators";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function parseItunesDuration(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parts = value.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }

  if (parts.length === 3) {
    return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  }

  if (parts.length === 2) {
    return parts[0]! * 60 + parts[1]!;
  }

  if (parts.length === 1) {
    return parts[0]!;
  }

  return null;
}

function makeEpisodeId(seed: string) {
  return createHash("sha1").update(seed).digest("hex");
}

export async function fetchRssEpisodes(rssUrl: string): Promise<RssEpisodeInput[]> {
  const response = await fetch(rssUrl, {
    headers: {
      "user-agent": "NarriflowBot/1.0 (+https://narriflow.app)",
      accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch RSS feed: ${response.status}`);
  }

  const xml = await response.text();
  const parsed = parser.parse(xml) as {
    rss?: { channel?: { item?: unknown } };
    feed?: { entry?: unknown };
  };

  const rssItems = toArray(parsed.rss?.channel?.item as Record<string, unknown> | Record<string, unknown>[]);
  const atomEntries = toArray(parsed.feed?.entry as Record<string, unknown> | Record<string, unknown>[]);

  const items = rssItems.length > 0 ? rssItems : atomEntries;

  const episodes: RssEpisodeInput[] = [];

  for (const item of items) {
    const enclosure = (item.enclosure ?? item.link) as Record<string, string> | string | undefined;
    const enclosureUrl =
      typeof enclosure === "string"
        ? enclosure
        : enclosure?.["@_url"] ?? enclosure?.href ?? enclosure?.["@_href"] ?? null;

    if (!enclosureUrl) {
      continue;
    }

    const title = String(item.title ?? "Untitled Episode").trim();
    const guidSeed = String(item.guid ?? item.id ?? `${title}:${enclosureUrl}`);
    const durationRaw =
      typeof item["itunes:duration"] === "string"
        ? item["itunes:duration"]
        : typeof item.duration === "string"
          ? item.duration
          : null;
    const publishedRaw = String(item.pubDate ?? item.published ?? item.updated ?? "").trim();
    const publishedAt = publishedRaw ? new Date(publishedRaw).toISOString() : null;

    episodes.push({
      id: makeEpisodeId(guidSeed),
      title,
      enclosureUrl,
      publishedAt: Number.isNaN(Date.parse(publishedAt ?? "")) ? null : publishedAt,
      durationSeconds: parseItunesDuration(durationRaw),
      mimeType:
        typeof enclosure === "object"
          ? (enclosure?.["@_type"] ?? enclosure?.type ?? null)
          : null,
    });
  }

  return episodes.slice(0, 50);
}
