import { describe, expect, test } from "bun:test";
import { bucketWidth, cacheKeyFor, sourceTimeToVideoTime } from "./timeline-preview-manager";

// ─── sourceTimeToVideoTime ──────────────────────────────────────────────────
//
// The timeline's thumbnail grabber always computes its seek target in
// absolute source time (clipStartSec + segStartSec + a fraction of the
// segment's duration — see runJob in timeline-preview-manager.ts), then this
// function translates that into the local `currentTime` of whichever file is
// actually loaded. `offsetSec` is that file's own t=0 expressed in source
// time: 0 for the full source, `previewStartSec` for the preview proxy —
// exactly mirroring how studio-shell.tsx derives
// `playerClipStartSec`/`playerClipEndSec` for the main player from the same
// `previewStartSec` value.

describe("sourceTimeToVideoTime", () => {
  test("passes the source time through unchanged when reading the source directly (offset 0)", () => {
    expect(sourceTimeToVideoTime(0, 0)).toBe(0);
    expect(sourceTimeToVideoTime(42.5, 0)).toBe(42.5);
  });

  test("subtracts the proxy's start offset to land on the proxy's own timeline", () => {
    // A clip starting at source t=120s, with a proxy cut starting 8s earlier
    // (padding) at source t=112s: seeking to the clip's own start should hit
    // t=8s on the proxy, not t=120s.
    expect(sourceTimeToVideoTime(120, 112)).toBeCloseTo(8, 10);
  });

  test("is the exact inverse of adding the offset back on", () => {
    const offsetSec = 37.25;
    const sourceTimeSec = 96.4;
    const videoTime = sourceTimeToVideoTime(sourceTimeSec, offsetSec);
    expect(videoTime + offsetSec).toBeCloseTo(sourceTimeSec, 10);
  });

  test("clamps to zero instead of seeking to a negative time", () => {
    // Defends against the proxy's padding window being thinner than expected
    // (rounding, or a regenerated proxy) — never hand the video element a
    // negative currentTime.
    expect(sourceTimeToVideoTime(5, 20)).toBe(0);
  });

  test("returns exactly zero at the boundary where source time equals the offset", () => {
    expect(sourceTimeToVideoTime(20, 20)).toBe(0);
  });
});

// ─── bucketWidth ────────────────────────────────────────────────────────────
//
// Cache keys must not vary on every pixel of width, or every 0.05 zoom-slider
// tick invalidates and re-seeks every visible thumbnail (the reported bug).
// Reusing a strip captured at a nearby width is safe: timeline.tsx's
// drawCachedStrip always rescales the cached canvas into the destination
// rect via drawImage, regardless of the strip's native resolution.

describe("bucketWidth", () => {
  test("is stable for widths inside the same bucket", () => {
    expect(bucketWidth(100)).toBe(bucketWidth(104));
    expect(bucketWidth(240)).toBe(bucketWidth(246));
  });

  test("collapses a run of consecutive zoom-slider ticks into few buckets", () => {
    // Simulates ~10 consecutive 0.05-zoom-step widths on a short segment —
    // before bucketing, each of these produced a distinct Math.round() key.
    const widths = Array.from({ length: 10 }, (_, i) => 100 + i * 1.2);
    const uniqueBuckets = new Set(widths.map(bucketWidth));
    expect(uniqueBuckets.size).toBeLessThan(widths.length);
  });

  test("moves to a different bucket once the width changes enough to matter", () => {
    expect(bucketWidth(100)).not.toBe(bucketWidth(400));
  });

  test("floors non-positive or tiny widths at one bucket width", () => {
    const zeroBucket = bucketWidth(0);
    expect(bucketWidth(-10)).toBe(zeroBucket);
    expect(bucketWidth(1)).toBe(zeroBucket);
    expect(zeroBucket).toBeGreaterThan(0);
  });

  test("rounds to the nearer bucket multiple rather than always flooring or ceiling", () => {
    // With the exported bucket unit, a width just above a lower multiple
    // rounds down and a width just above the midpoint rounds up to the next.
    const low = bucketWidth(41);
    const high = bucketWidth(79);
    expect(high).toBeGreaterThan(low);
  });
});

// ─── cacheKeyFor ────────────────────────────────────────────────────────────

function baseRequest(
  overrides: Partial<Parameters<typeof cacheKeyFor>[0]> = {},
): Parameters<typeof cacheKeyFor>[0] {
  return {
    sourcePreviewId: "project-abc",
    videoKind: "proxy",
    clipStartSec: 12,
    segStartSec: 0,
    segEndSec: 2,
    width: 100,
    height: 61,
    quality: "coarse",
    ...overrides,
  };
}

describe("cacheKeyFor", () => {
  test("is deterministic for identical requests", () => {
    expect(cacheKeyFor(baseRequest())).toBe(cacheKeyFor(baseRequest()));
  });

  test("shares a key across widths from consecutive zoom-slider ticks", () => {
    const a = baseRequest({ width: 240 });
    const b = baseRequest({ width: 246 });
    expect(cacheKeyFor(a)).toBe(cacheKeyFor(b));
  });

  test("changes key once the width crosses into a new bucket", () => {
    const a = baseRequest({ width: 100 });
    const b = baseRequest({ width: 400 });
    expect(cacheKeyFor(a)).not.toBe(cacheKeyFor(b));
  });

  test("never reuses a strip between the proxy and the full source", () => {
    // Same sourcePreviewId (same underlying footage identity), different
    // physical file — must not collide, per the "strip generated before the
    // proxy existed isn't reused afterwards" requirement.
    const proxyRequest = baseRequest({ videoKind: "proxy" });
    const sourceRequest = baseRequest({ videoKind: "source" });
    expect(cacheKeyFor(proxyRequest)).not.toBe(cacheKeyFor(sourceRequest));
  });

  test("changes key when the segment window moves", () => {
    const a = baseRequest({ segStartSec: 0, segEndSec: 2 });
    const b = baseRequest({ segStartSec: 2, segEndSec: 4 });
    expect(cacheKeyFor(a)).not.toBe(cacheKeyFor(b));
  });

  test("changes key when the underlying clip identity or trim point differs", () => {
    const a = baseRequest({ sourcePreviewId: "project-abc" });
    const b = baseRequest({ sourcePreviewId: "project-xyz" });
    const c = baseRequest({ clipStartSec: 12 });
    const d = baseRequest({ clipStartSec: 30 });
    expect(cacheKeyFor(a)).not.toBe(cacheKeyFor(b));
    expect(cacheKeyFor(c)).not.toBe(cacheKeyFor(d));
  });

  test("changes key between coarse and refined quality passes", () => {
    const coarse = baseRequest({ quality: "coarse" });
    const refined = baseRequest({ quality: "refined" });
    expect(cacheKeyFor(coarse)).not.toBe(cacheKeyFor(refined));
  });
});
