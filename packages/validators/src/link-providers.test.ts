import { describe, expect, test } from "bun:test";
import {
  detectLinkProvider,
  linkIngestSchema,
  LINK_PROVIDERS,
  youtubeMediaId,
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

  test("a host nothing can import from is not a link provider", () => {
    for (const url of [
      "https://drive.google.com/file/d/abc123/view",
      "https://streamyard.com/watch/abc123",
      "https://www.loom.com/share/abc123",
      "https://www.twitch.tv/somechannel",
      "https://x.com/someuser/status/123",
      "https://twitter.com/someuser/status/123",
      "https://www.tiktok.com/@someuser/video/123",
      "https://www.linkedin.com/posts/someuser_video-activity-123",
      "https://www.facebook.com/someuser/videos/123",
      "https://fb.watch/abc123/",
      "https://vimeo.com/123456789",
    ]) expect(detectLinkProvider(url)).toBeNull();
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
    expect(detectLinkProvider("https://fakedropbox.com/s/abc")).toBeNull();
  });

  test("Google Drive labels Picker imports but no pasted link matches it", () => {
    expect(LINK_PROVIDERS.map((provider) => provider.id)).toEqual(["youtube", "gdrive", "dropbox"]);
    expect(LINK_PROVIDERS.find((provider) => provider.id === "gdrive")?.hosts).toEqual([]);
  });
});

describe("youtubeMediaId", () => {
  test("reads the video id from each link form a person can paste", () => {
    for (const url of [
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=30",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/live/dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ]) expect(youtubeMediaId(url)).toBe("dQw4w9WgXcQ");
  });

  test("a YouTube page that names no single video has no id", () => {
    for (const url of [
      "https://www.youtube.com/@somechannel",
      "https://www.youtube.com/playlist?list=PL123",
      "https://www.youtube.com/watch?v=short",
      "https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ",
      "https://user@www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://vimeo.com/123456789",
      "not a url",
    ]) expect(youtubeMediaId(url)).toBeNull();
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
      url: "https://www.dropbox.com/s/abc123/video.mp4",
    });
    expect(result.success).toBe(true);
  });

  test("leaves an unsupported host to intake, which refuses it with a stable code", () => {
    const result = linkIngestSchema.safeParse({
      url: "https://example.com/video.mp4",
    });
    expect(result.success).toBe(true);
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
