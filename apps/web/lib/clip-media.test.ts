import { describe, expect, test } from "bun:test";
import {
  clipMediaPayloadForClip,
  clipFileDownloadPath,
  loadClipPreview,
  type ClipMediaFetcher,
} from "./clip-media";

function mediaPayload(overrides: Record<string, unknown> = {}) {
  return {
    downloadUrl: "https://media.example.test/clip.mp4?signature=valid",
    expiresInSeconds: 3600,
    fileName: "clip-1-hook-9x16.mp4",
    ...overrides,
  };
}

describe("clip preview loading", () => {
  test("selects one clip descriptor from a project preview response", () => {
    expect(
      clipMediaPayloadForClip(
        { previews: { "clip-1": mediaPayload(), "clip-2": null } },
        "clip-1",
      ),
    ).toEqual(mediaPayload());
    expect(
      clipMediaPayloadForClip(
        { previews: { "clip-1": mediaPayload(), "clip-2": null } },
        "clip-2",
      ),
    ).toBeNull();
  });

  test("shares one successful preview request across concurrent consumers", async () => {
    let calls = 0;
    const fetcher: ClipMediaFetcher = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => mediaPayload(),
      };
    };
    const url = "/api/preview?clip=concurrent";

    const [first, second] = await Promise.all([
      loadClipPreview(url, fetcher),
      loadClipPreview(url, fetcher),
    ]);

    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });

  test("does not cache a failed preview response", async () => {
    let calls = 0;
    const fetcher: ClipMediaFetcher = async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, status: 503, json: async () => ({ message: "later" }) }
        : { ok: true, status: 200, json: async () => mediaPayload() };
    };
    const url = "/api/preview?clip=retry";

    expect((await loadClipPreview(url, fetcher)).ok).toBe(false);
    expect((await loadClipPreview(url, fetcher)).ok).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("clip downloads", () => {
  test("builds a same-origin browser download route", () => {
    expect(
      clipFileDownloadPath("project/id", "clip id", "9:16"),
    ).toBe(
      "/api/projects/project%2Fid/clips/clip%20id/file?aspectRatio=9%3A16",
    );
  });
});
