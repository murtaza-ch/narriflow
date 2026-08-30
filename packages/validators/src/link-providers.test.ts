import { describe, expect, test } from "bun:test";
import {
  detectLinkProvider,
  linkIngestSchema,
  LINK_PROVIDERS,
} from ".";

describe("detectLinkProvider", () => {
  test("recognizes youtube URLs", () => {
    expect(detectLinkProvider("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
    expect(
      detectLinkProvider("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).toBe("youtube");
    expect(
      detectLinkProvider("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"),
    ).toBe("youtube");
  });

  test("recognizes google drive URLs", () => {
    expect(
      detectLinkProvider("https://drive.google.com/file/d/abc123/view"),
    ).toBe("gdrive");
  });

  test("recognizes streamyard URLs", () => {
    expect(detectLinkProvider("https://streamyard.com/watch/abc123")).toBe(
      "streamyard",
    );
  });

  test("recognizes loom URLs", () => {
    expect(detectLinkProvider("https://www.loom.com/share/abc123")).toBe(
      "loom",
    );
  });

  test("recognizes twitch URLs, including clips subdomain", () => {
    expect(detectLinkProvider("https://www.twitch.tv/somechannel")).toBe(
      "twitch",
    );
    expect(
      detectLinkProvider("https://clips.twitch.tv/SomeClipSlug"),
    ).toBe("twitch");
  });

  test("recognizes x/twitter URLs", () => {
    expect(detectLinkProvider("https://x.com/someuser/status/123")).toBe("x");
    expect(
      detectLinkProvider("https://twitter.com/someuser/status/123"),
    ).toBe("x");
  });

  test("recognizes tiktok URLs, including vm short links", () => {
    expect(
      detectLinkProvider("https://vm.tiktok.com/ZMabcdefg/"),
    ).toBe("tiktok");
    expect(
      detectLinkProvider("https://www.tiktok.com/@someuser/video/123"),
    ).toBe("tiktok");
  });

  test("recognizes linkedin URLs", () => {
    expect(
      detectLinkProvider("https://www.linkedin.com/posts/someuser_video-activity-123"),
    ).toBe("linkedin");
  });

  test("recognizes facebook URLs, including fb.watch", () => {
    expect(detectLinkProvider("https://fb.watch/abc123/")).toBe("facebook");
    expect(
      detectLinkProvider("https://www.facebook.com/someuser/videos/123"),
    ).toBe("facebook");
  });

  test("recognizes vimeo URLs, including player subdomain", () => {
    expect(detectLinkProvider("https://vimeo.com/123456789")).toBe("vimeo");
    expect(
      detectLinkProvider("https://player.vimeo.com/video/123456789"),
    ).toBe("vimeo");
  });

  test("recognizes dropbox share URLs", () => {
    expect(
      detectLinkProvider("https://www.dropbox.com/s/abc123/video.mp4?dl=0"),
    ).toBe("dropbox");
    expect(
      detectLinkProvider(
        "https://www.dropbox.com/scl/fi/abc123/video.mp4?rlkey=xyz",
      ),
    ).toBe("dropbox");
  });

  test("returns null for unsupported or invalid input", () => {
    expect(detectLinkProvider("https://example.com/video.mp4")).toBeNull();
    expect(detectLinkProvider("not a url")).toBeNull();
    expect(detectLinkProvider("ftp://files.example.com/video.mp4")).toBeNull();
    expect(
      detectLinkProvider("https://feeds.example.com/podcast.xml"),
    ).toBeNull();
  });

  test("rejects adversarial lookalike hostnames", () => {
    expect(detectLinkProvider("https://evil-youtube.com/watch?v=x")).toBeNull();
    expect(
      detectLinkProvider("https://youtube.com.evil.com/watch?v=x"),
    ).toBeNull();
    expect(detectLinkProvider("https://notvimeo.com/123")).toBeNull();
    expect(detectLinkProvider("https://x.com.attacker.net/status/1")).toBeNull();
    expect(detectLinkProvider("https://fakedropbox.com/s/abc")).toBeNull();
  });

  test("every provider def has an entry in LINK_PROVIDERS", () => {
    expect(LINK_PROVIDERS.length).toBe(11);
    expect(LINK_PROVIDERS.find((p) => p.id === "dropbox")?.strategy).toBe(
      "direct",
    );
    expect(
      LINK_PROVIDERS.filter((p) => p.strategy === "ytdlp").length,
    ).toBe(10);
  });
});

describe("linkIngestSchema", () => {
  test("accepts a valid youtube link with optional brand selections", () => {
    const result = linkIngestSchema.safeParse({
      title: "My Podcast Episode",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      brandProfileId: "bc25be61-113c-4fa0-b7a6-6e757270cd94",
    });
    expect(result.success).toBe(true);
  });

  test("accepts a minimal valid link (url only)", () => {
    const result = linkIngestSchema.safeParse({
      url: "https://vimeo.com/123456789",
    });
    expect(result.success).toBe(true);
  });

  test("rejects an unsupported host", () => {
    const result = linkIngestSchema.safeParse({
      url: "https://example.com/video.mp4",
    });
    expect(result.success).toBe(false);
  });

  test("rejects a non-URL string", () => {
    const result = linkIngestSchema.safeParse({ url: "not-a-url" });
    expect(result.success).toBe(false);
  });

  test("rejects a title longer than 200 chars", () => {
    const result = linkIngestSchema.safeParse({
      title: "a".repeat(201),
      url: "https://youtu.be/dQw4w9WgXcQ",
    });
    expect(result.success).toBe(false);
  });
});
