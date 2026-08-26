import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PexelsVideo } from "@narriflow/services";
import {
  getCachedBrollAssetPath,
  remapBrollCuesForCutPlan,
  resolveBrollCutaways,
  saveBrollAssetToCache,
} from "./broll";
import { buildClipCutPlan } from "./cut-plan";

// Pure query/orientation/placement logic (brollQueryForClip, planBrollWindow,
// planBrollCutaways, orientation mapping) is unit-tested at its source of
// truth in packages/validators/src/broll.test.ts (shared with the studio
// panel). This file covers only what's specific to the worker: the disk
// asset cache and resolving a cutaway plan into real Pexels picks.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeVideo(overrides: Partial<PexelsVideo> = {}): PexelsVideo {
  return {
    id: 1,
    width: 1080,
    height: 1920,
    duration: 6,
    url: "https://pexels.com/video/1",
    image: "https://img/1.jpg",
    user: { id: 1, name: "Jane Doe", url: "https://pexels.com/@jane" },
    video_files: [
      { link: "https://cdn.pexels.com/1.mp4", width: 1080, height: 1920, quality: "hd", file_type: "video/mp4" },
    ],
    ...overrides,
  };
}

describe("resolveBrollCutaways", () => {
  const prevKey = process.env.PEXELS_API_KEY;

  function withKey<T>(fn: () => Promise<T>): Promise<T> {
    process.env.PEXELS_API_KEY = "test-key";
    return fn().finally(() => {
      if (prevKey !== undefined) process.env.PEXELS_API_KEY = prevKey;
      else delete process.env.PEXELS_API_KEY;
    });
  }

  test("resolves each cue into its own cutaway with its own query", () =>
    withKey(async () => {
      const seenQueries: string[] = [];
      const resolved = await resolveBrollCutaways({
        clipDurationSec: 40,
        cues: [
          { atSec: 5, query: "server room lights" },
          { atSec: 20, query: "team meeting laptop" },
          { atSec: 33, query: "handshake office" },
        ],
        fallbackQuery: null,
        broaderFallbackQuery: "business people",
        orientation: "portrait",
        targetWidth: 1080,
        targetHeight: 1920,
        fetchImpl: (async (url: string | URL) => {
          const parsed = new URL(String(url));
          const q = parsed.searchParams.get("query") ?? "";
          seenQueries.push(q);
          return jsonResponse({ videos: [fakeVideo({ id: seenQueries.length })] });
        }) as unknown as typeof fetch,
      });

      expect(resolved).toHaveLength(3);
      expect(resolved.map((r) => r.query)).toEqual([
        "server room lights",
        "team meeting laptop",
        "handshake office",
      ]);
      expect(seenQueries).toEqual([
        "server room lights",
        "team meeting laptop",
        "handshake office",
      ]);
      for (const cutaway of resolved) {
        expect(cutaway.attribution.authorName).toBe("Jane Doe");
        expect(cutaway.downloadUrl).toBe("https://cdn.pexels.com/1.mp4");
      }
    }));

  test("broadens to the fallback query when a slot's own query returns nothing", () =>
    withKey(async () => {
      const calls: string[] = [];
      const resolved = await resolveBrollCutaways({
        clipDurationSec: 30,
        cues: [{ atSec: 10, query: "extremely obscure niche term" }],
        fallbackQuery: null,
        broaderFallbackQuery: "business people",
        orientation: "portrait",
        targetWidth: 1080,
        targetHeight: 1920,
        fetchImpl: (async (url: string | URL) => {
          const parsed = new URL(String(url));
          const q = parsed.searchParams.get("query") ?? "";
          calls.push(q);
          if (q === "extremely obscure niche term") {
            return jsonResponse({ videos: [] });
          }
          return jsonResponse({ videos: [fakeVideo()] });
        }) as unknown as typeof fetch,
      });

      expect(calls).toEqual(["extremely obscure niche term", "business people"]);
      expect(resolved).toHaveLength(1);
    }));

  test("drops a slot whose resolved asset is shorter than the minimum usable cutaway", () =>
    withKey(async () => {
      const resolved = await resolveBrollCutaways({
        clipDurationSec: 30,
        cues: [
          { atSec: 10, query: "short asset" },
          { atSec: 20, query: "normal asset" },
        ],
        fallbackQuery: null,
        broaderFallbackQuery: null,
        orientation: "portrait",
        targetWidth: 1080,
        targetHeight: 1920,
        fetchImpl: (async (url: string | URL) => {
          const parsed = new URL(String(url));
          const q = parsed.searchParams.get("query") ?? "";
          if (q === "short asset") {
            // Real duration under the 1.2s floor once clamped to the window start.
            return jsonResponse({ videos: [fakeVideo({ id: 2, duration: 0.5 })] });
          }
          return jsonResponse({ videos: [fakeVideo({ id: 3, duration: 6 })] });
        }) as unknown as typeof fetch,
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.query).toBe("normal asset");
    }));

  test("keeps other cutaways when one slot's search throws", () =>
    withKey(async () => {
      const resolved = await resolveBrollCutaways({
        clipDurationSec: 30,
        cues: [
          { atSec: 10, query: "will throw" },
          { atSec: 20, query: "will succeed" },
        ],
        fallbackQuery: null,
        broaderFallbackQuery: null,
        orientation: "portrait",
        targetWidth: 1080,
        targetHeight: 1920,
        fetchImpl: (async (url: string | URL) => {
          const parsed = new URL(String(url));
          const q = parsed.searchParams.get("query") ?? "";
          if (q === "will throw") throw new Error("boom");
          return jsonResponse({ videos: [fakeVideo()] });
        }) as unknown as typeof fetch,
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.query).toBe("will succeed");
    }));

  test("clamps a resolved window to the asset's own duration without breaking ordering", () =>
    withKey(async () => {
      const resolved = await resolveBrollCutaways({
        clipDurationSec: 30,
        cues: [{ atSec: 15, query: "brief asset" }],
        fallbackQuery: null,
        broaderFallbackQuery: null,
        orientation: "portrait",
        targetWidth: 1080,
        targetHeight: 1920,
        fetchImpl: (async () =>
          jsonResponse({ videos: [fakeVideo({ duration: 1.5 })] })) as unknown as typeof fetch,
      });

      expect(resolved).toHaveLength(1);
      const cutaway = resolved[0]!;
      expect(cutaway.endSec - cutaway.startSec).toBeLessThanOrEqual(1.5 + 0.01);
    }));

  test("returns [] when the clip is too short to plan any cutaway", () =>
    withKey(async () => {
      const resolved = await resolveBrollCutaways({
        clipDurationSec: 8,
        cues: null,
        fallbackQuery: "anything",
        broaderFallbackQuery: null,
        orientation: "portrait",
        targetWidth: 1080,
        targetHeight: 1920,
        fetchImpl: (async () => jsonResponse({ videos: [fakeVideo()] })) as unknown as typeof fetch,
      });
      expect(resolved).toEqual([]);
    }));
});

describe("remapBrollCuesForCutPlan (fix #2: cues are uncut clip-relative, planning runs on the edited timeline)", () => {
  // 30s clip window [0,30), one mid-clip deletion [10,15) -> kept segments
  // [0,10) and [15,30), 25s edited duration (10s in, cut point, then +5).
  const window = { startSec: 0, endSec: 30 };
  const cutPlan = buildClipCutPlan([{ startSec: 10, endSec: 15 }], window);
  const clipStartSec = 0;

  test("is a no-op when the clip is uncut (byte-identical to the pre-remap common case)", () => {
    const uncutPlan = buildClipCutPlan([], window);
    const cues = [{ atSec: 5, query: "q" }];
    expect(remapBrollCuesForCutPlan(cues, uncutPlan, clipStartSec)).toBe(cues);
  });

  test("passes through null/undefined unchanged", () => {
    expect(remapBrollCuesForCutPlan(null, cutPlan, clipStartSec)).toBeNull();
    expect(remapBrollCuesForCutPlan(undefined, cutPlan, clipStartSec)).toBeUndefined();
  });

  test("a cue after a cut shifts left onto the edited timeline", () => {
    // atSec=20 (uncut clip-relative) -> source 20 -> in the second kept
    // segment (source [15,30) -> edited [10,25)) -> edited 10 + (20-15) = 15.
    const cues = [{ atSec: 20, query: "office" }];
    const remapped = remapBrollCuesForCutPlan(cues, cutPlan, clipStartSec);
    expect(remapped).toEqual([{ atSec: 15, query: "office" }]);
  });

  test("a cue before any cut is unchanged (no shift needed)", () => {
    const cues = [{ atSec: 5, query: "intro" }];
    const remapped = remapBrollCuesForCutPlan(cues, cutPlan, clipStartSec);
    expect(remapped).toEqual([{ atSec: 5, query: "intro" }]);
  });

  test("a cue inside a cut is dropped", () => {
    const cues = [
      { atSec: 5, query: "kept" },
      { atSec: 12, query: "deleted (inside [10,15))" },
      { atSec: 20, query: "kept, shifted" },
    ];
    const remapped = remapBrollCuesForCutPlan(cues, cutPlan, clipStartSec);
    expect(remapped).toEqual([
      { atSec: 5, query: "kept" },
      { atSec: 15, query: "kept, shifted" },
    ]);
  });

  test("respects a non-zero clipStartSec (cue atSec is clip-relative, cutPlan.map is source-absolute)", () => {
    const offsetWindow = { startSec: 100, endSec: 130 };
    const offsetPlan = buildClipCutPlan(
      [{ startSec: 110, endSec: 115 }],
      offsetWindow,
    );
    // atSec=20 relative to a clip starting at source 100 -> source 120 ->
    // second kept segment (source [115,130) -> edited [10,25)) -> edited
    // 10 + (120-115) = 15.
    const cues = [{ atSec: 20, query: "office" }];
    const remapped = remapBrollCuesForCutPlan(cues, offsetPlan, 100);
    expect(remapped).toEqual([{ atSec: 15, query: "office" }]);
  });
});

describe("downloaded-asset disk cache", () => {
  let tempDir = "";

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  });

  test("returns null for a URL that was never cached", async () => {
    const result = await getCachedBrollAssetPath(
      `https://cdn.pexels.com/never-cached-${Date.now()}-${Math.random()}.mp4`,
    );
    expect(result).toBeNull();
  });

  test("round-trips: save then read back the same bytes path", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "narriflow-broll-cache-test-"));
    const sourcePath = join(tempDir, "source.mp4");
    await writeFile(sourcePath, "fake mp4 bytes");

    const url = `https://cdn.pexels.com/roundtrip-${Date.now()}-${Math.random()}.mp4`;
    expect(await getCachedBrollAssetPath(url)).toBeNull();

    await saveBrollAssetToCache(url, sourcePath);
    const cachedPath = await getCachedBrollAssetPath(url);
    expect(cachedPath).not.toBeNull();
    expect(cachedPath).not.toBe(sourcePath);
  });

  test("honors the startup-frozen cache lifetime supplied by the renderer", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "narriflow-broll-cache-test-"));
    const sourcePath = join(tempDir, "source.mp4");
    await writeFile(sourcePath, "fake mp4 bytes");
    const url = `https://cdn.pexels.com/ttl-${Date.now()}-${Math.random()}.mp4`;
    await saveBrollAssetToCache(url, sourcePath);
    const cachedPath = await getCachedBrollAssetPath(url);
    if (!cachedPath) throw new Error("expected cached fixture path");
    const staleAt = new Date(Date.now() - 60_000);
    await utimes(cachedPath, staleAt, staleAt);

    expect(await getCachedBrollAssetPath(url, 1_000)).toBeNull();
    expect(await getCachedBrollAssetPath(url, 120_000)).toBe(cachedPath);
  });

  test("a cache-write failure (bad source path) never throws", async () => {
    await expect(
      saveBrollAssetToCache(
        `https://cdn.pexels.com/missing-${Date.now()}.mp4`,
        "/nonexistent/path/does-not-exist.mp4",
      ),
    ).resolves.toBeUndefined();
  });
});
