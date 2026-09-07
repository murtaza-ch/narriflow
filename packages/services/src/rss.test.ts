import { describe, expect, test } from "bun:test";
import {
  decodeXmlText,
  fetchRssFeed,
  parseItunesDuration,
  parseRssFeed,
  redactUrlForDisplay,
  RssFeedError,
  xmlScalar,
} from "./rss";

const RSS_HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel><title>Test &amp; Verify</title>`;
const RSS_TAIL = "</channel></rss>";

describe("RSS scalar normalization", () => {
  test("redacts query and path tokens from persisted display URLs", () => {
    expect(
      redactUrlForDisplay("https://private.example/member/secret-token.xml?key=abc"),
    ).toBe("https://private.example/...");
  });

  test("reads attributed text nodes instead of coercing them to [object Object]", () => {
    expect(xmlScalar({ "#text": "episode-1", "@_isPermaLink": "false" })).toBe(
      "episode-1",
    );
  });

  test("decodes only predefined and numeric XML character references", () => {
    expect(decodeXmlText("Rock &amp; Roll &#38; &#x1F680; &custom;")).toBe(
      "Rock & Roll & 🚀 &custom;",
    );
  });

  test.each([
    [123, 123],
    ["01:02", 62],
    ["1:02:03", 3723],
    ["bad", null],
    [0, null],
  ])("parses duration %p", (input, expected) => {
    expect(parseItunesDuration(input)).toBe(expected);
  });
});

describe("parseRssFeed", () => {
  test("normalizes mainstream RSS GUIDs, entities, numeric durations, and ordering", () => {
    const feed = parseRssFeed(
      `${RSS_HEAD}
      <item>
        <title>Older &amp; useful</title>
        <guid isPermaLink="false">episode-old</guid>
        <pubDate>Mon, 10 Aug 2026 10:00:00 GMT</pubDate>
        <itunes:duration>123</itunes:duration>
        <enclosure url="https://cdn.example/old.mp3?x=1&amp;y=2" type="audio/mpeg" />
      </item>
      <item>
        <title>Newest &#38; best</title>
        <guid isPermaLink="false">episode-new</guid>
        <pubDate>Tue, 11 Aug 2026 10:00:00 GMT</pubDate>
        <itunes:duration>01:02:03</itunes:duration>
        <enclosure url="/new.mp3" type="audio/mpeg" />
      </item>${RSS_TAIL}`,
      "https://feeds.example/show.xml",
    );

    expect(feed.title).toBe("Test & Verify");
    expect(feed.episodes).toHaveLength(2);
    expect(new Set(feed.episodes.map((episode) => episode.id)).size).toBe(2);
    expect(feed.episodes[0]).toMatchObject({
      title: "Newest & best",
      enclosureUrl: "https://feeds.example/new.mp3",
      durationSeconds: 3723,
      mimeType: "audio/mpeg",
    });
    expect(feed.episodes[1]).toMatchObject({
      title: "Older & useful",
      enclosureUrl: "https://cdn.example/old.mp3?x=1&y=2",
      durationSeconds: 123,
    });
  });

  test("uses rel=enclosure from an Atom link array and attributed titles", () => {
    const feed = parseRssFeed(
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
        <title type="text">Atom show</title>
        <entry>
          <id>tag:example.com,2026:1</id>
          <title type="html">Atom &amp; episode</title>
          <updated>2026-08-11T10:00:00Z</updated>
          <link rel="alternate" href="https://example.com/episodes/1" />
          <link rel="enclosure" href="https://cdn.example/1.m4a" type="audio/mp4" />
        </entry>
      </feed>`,
      "https://example.com/feed.atom",
    );

    expect(feed.episodes).toHaveLength(1);
    expect(feed.episodes[0]).toMatchObject({
      title: "Atom & episode",
      enclosureUrl: "https://cdn.example/1.m4a",
      mimeType: "audio/mp4",
    });
  });

  test("disambiguates reused GUIDs and drops exact duplicate enclosures", () => {
    const feed = parseRssFeed(
      `${RSS_HEAD}
        <item><title>A</title><guid>same</guid><enclosure url="https://cdn.example/a.mp3" /></item>
        <item><title>B</title><guid>same</guid><enclosure url="https://cdn.example/b.mp3" /></item>
        <item><title>A duplicate</title><guid>other</guid><enclosure url="https://cdn.example/a.mp3" /></item>
      ${RSS_TAIL}`,
      "https://example.com/feed.xml",
    );

    expect(feed.episodes).toHaveLength(2);
    expect(new Set(feed.episodes.map((episode) => episode.id)).size).toBe(2);
  });

  test.each([
    ["<rss><channel>", "rss_invalid_xml"],
    ["<html><body>not a feed</body></html>", "rss_unsupported_document"],
    [`${RSS_HEAD}<item><title>No media</title></item>${RSS_TAIL}`, "rss_no_media_episodes"],
  ])("rejects invalid feed input", (xml, code) => {
    try {
      parseRssFeed(xml, "https://example.com/feed.xml");
      throw new Error("expected parser to reject the document");
    } catch (error) {
      expect(error).toBeInstanceOf(RssFeedError);
      expect((error as RssFeedError).code).toBe(code);
    }
  });

  test("enforces the normalized episode limit after date sorting", () => {
    const items = Array.from({ length: 20 }, (_, index) => `
      <item><title>Episode ${index}</title><guid>${index}</guid>
      <pubDate>${new Date(Date.UTC(2026, 0, index + 1)).toUTCString()}</pubDate>
      <enclosure url="https://cdn.example/${index}.mp3" /></item>`).join("");
    const feed = parseRssFeed(`${RSS_HEAD}${items}${RSS_TAIL}`, "https://example.com/feed", 5);
    expect(feed.episodes).toHaveLength(5);
    expect(feed.episodes[0]?.title).toBe("Episode 19");
  });
});

describe("fetchRssFeed HTTP contracts", () => {
  test("sends conditional validators and accepts a bodyless 304", async () => {
    let receivedHeaders = new Headers();
    const feed = await fetchRssFeed("https://feeds.example/show.xml", {
      etag: '"feed-v1"',
      lastModified: "Wed, 12 Aug 2026 10:00:00 GMT",
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async (_input, init) => {
        receivedHeaders = new Headers(init?.headers);
        return new Response(null, { status: 304 });
      },
    });

    expect(receivedHeaders.get("if-none-match")).toBe('"feed-v1"');
    expect(receivedHeaders.get("if-modified-since")).toBe(
      "Wed, 12 Aug 2026 10:00:00 GMT",
    );
    expect(feed.notModified).toBe(true);
    expect(feed.episodes).toEqual([]);
  });
});
