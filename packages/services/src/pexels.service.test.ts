import { describe, expect, test } from "bun:test";
import {
  pickPexelsFile,
  searchBrollVideos,
  searchPexelsVideos,
  selectBestPexelsVideo,
  type PexelsVideo,
} from "./pexels.service";

describe("pickPexelsFile", () => {
  const files = [
    { link: "a.mp4", width: 640, height: 360, file_type: "video/mp4" },
    { link: "b.mp4", width: 1280, height: 720, file_type: "video/mp4" },
    { link: "c.mp4", width: 1920, height: 1080, file_type: "video/mp4" },
  ];

  test("picks the smallest file at or above the target width", () => {
    expect(pickPexelsFile(files, 1000)?.link).toBe("b.mp4");
  });

  test("falls back to the largest when none reach the target", () => {
    expect(pickPexelsFile(files, 4000)?.link).toBe("c.mp4");
  });

  test("returns null with no usable files", () => {
    expect(pickPexelsFile([], 1080)).toBeNull();
  });
});

describe("selectBestPexelsVideo", () => {
  const files = [
    { link: "p.mp4", width: 1080, height: 1920, quality: "hd", file_type: "video/mp4" },
  ];

  test("skips videos shorter than the minimum and returns a downloadable pick with attribution", () => {
    const videos: PexelsVideo[] = [
      {
        id: 1,
        width: 1920,
        height: 1080,
        duration: 1,
        url: "https://pexels.com/video/1",
        image: "https://img/1.jpg",
        user: { id: 9, name: "Short Clip", url: "https://pexels.com/@short" },
        video_files: [],
      },
      {
        id: 2,
        width: 1080,
        height: 1920,
        duration: 9,
        url: "https://pexels.com/video/2",
        image: "https://img/2.jpg",
        user: { id: 7, name: "Jane Doe", url: "https://pexels.com/@jane" },
        video_files: files,
      },
    ];
    const clip = selectBestPexelsVideo(videos, 1080, 1920);
    expect(clip?.id).toBe(2);
    expect(clip?.downloadUrl).toBe("p.mp4");
    expect(clip?.attribution).toEqual({
      authorName: "Jane Doe",
      authorUrl: "https://pexels.com/@jane",
      pageUrl: "https://pexels.com/video/2",
      pexelsId: 2,
    });
  });

  test("returns null attribution fields when Pexels reports no user", () => {
    const videos: PexelsVideo[] = [
      {
        id: 3,
        width: 1080,
        height: 1920,
        duration: 9,
        url: "https://pexels.com/video/3",
        image: "https://img/3.jpg",
        user: null,
        video_files: files,
      },
    ];
    const clip = selectBestPexelsVideo(videos, 1080, 1920);
    expect(clip?.attribution).toEqual({
      authorName: null,
      authorUrl: null,
      pageUrl: "https://pexels.com/video/3",
      pexelsId: 3,
    });
  });
});

function withPexelsKey<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PEXELS_API_KEY;
  process.env.PEXELS_API_KEY = "test-key";
  return fn().finally(() => {
    if (prev !== undefined) process.env.PEXELS_API_KEY = prev;
    else delete process.env.PEXELS_API_KEY;
  });
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("searchBrollVideos", () => {
  test("returns [] with no API key configured (graceful)", async () => {
    const prev = process.env.PEXELS_API_KEY;
    delete process.env.PEXELS_API_KEY;
    try {
      expect(await searchBrollVideos("startup", "portrait")).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.PEXELS_API_KEY = prev;
    }
  });
});

describe("searchPexelsVideos (resilient search)", () => {
  test("returns [] immediately with no API key, without calling fetch", async () => {
    const prev = process.env.PEXELS_API_KEY;
    delete process.env.PEXELS_API_KEY;
    let called = false;
    try {
      const result = await searchPexelsVideos("startup", "portrait", {
        fetchImpl: (async () => {
          called = true;
          return jsonResponse({ videos: [] });
        }) as unknown as typeof fetch,
      });
      expect(result).toEqual([]);
      expect(called).toBe(false);
    } finally {
      if (prev !== undefined) process.env.PEXELS_API_KEY = prev;
    }
  });

  test("logs and returns [] distinctly on zero results (no retry)", () =>
    withPexelsKey(async () => {
      let calls = 0;
      const result = await searchPexelsVideos("nonexistent-topic-zzz", "portrait", {
        skipCache: true,
        fetchImpl: (async () => {
          calls += 1;
          return jsonResponse({ videos: [] });
        }) as unknown as typeof fetch,
      });
      expect(result).toEqual([]);
      expect(calls).toBe(1); // zero results never retries
    }));

  test("retries on 429 with backoff and eventually succeeds", () =>
    withPexelsKey(async () => {
      let calls = 0;
      const video: PexelsVideo = {
        id: 42,
        width: 1080,
        height: 1920,
        duration: 6,
        url: "https://pexels.com/video/42",
        image: "https://img/42.jpg",
        user: { id: 1, name: "A", url: "https://pexels.com/@a" },
        video_files: [{ link: "x.mp4", width: 1080, height: 1920, quality: "hd", file_type: "video/mp4" }],
      };
      const result = await searchPexelsVideos("office team", "portrait", {
        skipCache: true,
        maxAttempts: 3,
        fetchImpl: (async () => {
          calls += 1;
          if (calls < 3) {
            return new Response("rate limited", { status: 429 });
          }
          return jsonResponse({ videos: [video] });
        }) as unknown as typeof fetch,
      });
      expect(calls).toBe(3);
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe(42);
    }));

  test("gives up after exhausting retries on persistent 429", () =>
    withPexelsKey(async () => {
      let calls = 0;
      const result = await searchPexelsVideos("always limited", "portrait", {
        skipCache: true,
        maxAttempts: 2,
        fetchImpl: (async () => {
          calls += 1;
          return new Response("rate limited", { status: 429 });
        }) as unknown as typeof fetch,
      });
      expect(result).toEqual([]);
      expect(calls).toBe(2);
    }));

  test("retries transient network errors, then succeeds", () =>
    withPexelsKey(async () => {
      let calls = 0;
      const result = await searchPexelsVideos("city skyline", "landscape", {
        skipCache: true,
        maxAttempts: 3,
        fetchImpl: (async () => {
          calls += 1;
          if (calls === 1) throw new Error("ECONNRESET");
          return jsonResponse({ videos: [] });
        }) as unknown as typeof fetch,
      });
      expect(calls).toBe(2);
      expect(result).toEqual([]);
    }));

  test("does not retry a non-retryable 4xx (e.g. bad API key)", () =>
    withPexelsKey(async () => {
      let calls = 0;
      const result = await searchPexelsVideos("office team", "portrait", {
        skipCache: true,
        maxAttempts: 3,
        fetchImpl: (async () => {
          calls += 1;
          return new Response("unauthorized", { status: 401 });
        }) as unknown as typeof fetch,
      });
      expect(result).toEqual([]);
      expect(calls).toBe(1);
    }));

  test("caches search results so a repeat query does not re-hit the network", () =>
    withPexelsKey(async () => {
      let calls = 0;
      const video: PexelsVideo = {
        id: 7,
        width: 1920,
        height: 1080,
        duration: 6,
        url: "https://pexels.com/video/7",
        image: "https://img/7.jpg",
        user: { id: 2, name: "B", url: "https://pexels.com/@b" },
        video_files: [{ link: "y.mp4", width: 1920, height: 1080, quality: "hd", file_type: "video/mp4" }],
      };
      const fetchImpl = (async () => {
        calls += 1;
        return jsonResponse({ videos: [video] });
      }) as unknown as typeof fetch;

      const uniqueQuery = `cache probe ${Date.now()}-${Math.random()}`;
      const first = await searchPexelsVideos(uniqueQuery, "landscape", { fetchImpl });
      const second = await searchPexelsVideos(uniqueQuery, "landscape", { fetchImpl });

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(calls).toBe(1); // second call served entirely from cache
    }));
});
