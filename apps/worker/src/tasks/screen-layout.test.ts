import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ClipAspectRatio } from "@narriflow/validators";
import type { FaceSample } from "./reframe";
import {
  buildScreenSpeakerFilterChain,
  classifyScreencast,
  confirmsFaceInRect,
  fitPipCropToTile,
  pipCropTooSmall,
  screenBottomIsTrackable,
  screenTileGeometry,
  selectPipRect,
  SCREEN_BOTTOM_CROP_NAME,
  type PipCandidate,
} from "./screen-layout";

// C1 (adversarial review): every output aspect ratio's target dimensions —
// mirrors packages/validators/src/clip.ts's `clipAspectRatioOptions` (kept
// as literal numbers here rather than importing the option list, so this
// test data can't silently drift in lockstep with a validators change that
// broke the very invariant it's meant to catch).
const ASPECT_RATIO_DIMS: Record<ClipAspectRatio, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

describe("buildScreenSpeakerFilterChain — landscape source (fit-tile pad math)", () => {
  // 640x360 source, 9:16 target -> tile 1080x960 (tileRatio 1.125).
  // srcRatio 1.778 >= tileRatio, so the BOTTOM crop is full source height,
  // width = round(360 * 1.125) = 405 (same tile-crop math two-up.ts's tiles
  // use — verified against two-up.test.ts's own buildTwoUpFilterChain case).
  const probe = { width: 640, height: 360 };

  test("splits, fits the TOP tile (scale+pad, never cropped), crops the BOTTOM tile, vstacks to [outv]", () => {
    const parts = buildScreenSpeakerFilterChain({
      aspectRatio: "9:16",
      probe,
      bottom: { cx: 0.7 },
    });
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("[0:v]split=2[screen_top_src][screen_bot_src]");
    // TOP: generic fit — scale-to-contain (force_divisible_by=2) + letterbox
    // pad to the exact 1080x960 tile canvas, black bars, own setsar=1.
    expect(parts[1]).toBe(
      "[screen_top_src]scale=1080:960:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:960:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[screen_top]",
    );
    // BOTTOM: static crop centered on cx=0.7 -> cropW=405, centerPx=448,
    // raw x=448-202.5=245.5, clamped to cropXForCenter's max (640-405=235).
    expect(parts[2]).toBe("[screen_bot_src]crop=405:360:235:0,scale=1080:960,setsar=1[screen_bot]");
    expect(parts[3]).toBe(
      "[screen_top][screen_bot]vstack=inputs=2,format=yuv420p,setsar=1[outv]",
    );
  });

  test("both branches pin setsar=1 BEFORE vstack (not just after)", () => {
    const parts = buildScreenSpeakerFilterChain({
      aspectRatio: "9:16",
      probe,
      bottom: { cx: 0.5 },
    });
    // TOP branch's own filter statement (index 1) must carry setsar=1 itself.
    expect(parts[1]).toContain(",setsar=1[screen_top]");
    // BOTTOM branch's own filter statement (index 2) must carry setsar=1 itself.
    expect(parts[2]).toContain(",setsar=1[screen_bot]");
  });

  test("appends a trailing chain (captions) before the output label", () => {
    const parts = buildScreenSpeakerFilterChain({
      aspectRatio: "9:16",
      probe,
      bottom: { cx: 0.5 },
      trailingChain: "subtitles='/tmp/x.srt'",
    });
    expect(parts[3]).toBe(
      "[screen_top][screen_bot]vstack=inputs=2,format=yuv420p,setsar=1,subtitles='/tmp/x.srt'[outv]",
    );
  });

  test("respects a custom videoInputLabel/outputLabel ([vcat]/[outvbase] cut-concat interop contract)", () => {
    const parts = buildScreenSpeakerFilterChain({
      aspectRatio: "9:16",
      probe,
      bottom: { cx: 0.5 },
      videoInputLabel: "[vcat]",
      outputLabel: "[outvbase]",
    });
    expect(parts[0]).toBe("[vcat]split=2[screen_top_src][screen_bot_src]");
    expect(parts[3]).toContain("[outvbase]");
  });

  test("labelSuffix keeps two calls' internal labels from colliding", () => {
    const a = buildScreenSpeakerFilterChain({
      aspectRatio: "9:16",
      probe,
      bottom: { cx: 0.5 },
      labelSuffix: "_seg0",
    });
    const b = buildScreenSpeakerFilterChain({
      aspectRatio: "9:16",
      probe,
      bottom: { cx: 0.5 },
      labelSuffix: "_seg1",
    });
    expect(a[0]).toContain("screen_top_src_seg0");
    expect(b[0]).toContain("screen_top_src_seg1");
    expect(a[0]).not.toContain("_seg1");
  });

  test("throws on an unsupported aspect ratio", () => {
    expect(() =>
      buildScreenSpeakerFilterChain({
        // @ts-expect-error deliberately invalid for this test
        aspectRatio: "3:2",
        probe,
        bottom: { cx: 0.5 },
      }),
    ).toThrow();
  });

  test("throws on degenerate source geometry (defensive sanity gate)", () => {
    expect(() =>
      buildScreenSpeakerFilterChain({
        aspectRatio: "9:16",
        probe: { width: 0, height: 0 },
        bottom: { cx: 0.5 },
      }),
    ).toThrow();
    expect(() =>
      buildScreenSpeakerFilterChain({
        aspectRatio: "9:16",
        probe: { width: 1, height: 1 },
        bottom: { cx: 0.5 },
      }),
    ).toThrow();
  });
});

describe("buildScreenSpeakerFilterChain — portrait source (generic both-dims fit math)", () => {
  // 360x640 portrait source, 16:9 target -> tile 1920x540 (tileRatio 3.556).
  // srcRatio 0.5625 < tileRatio, so the BOTTOM crop is full source WIDTH
  // (the branch buildTwoUpFilterChain's own computeTileCrop takes when the
  // source is narrower than the tile demands) — the case a purely
  // landscape-source-oriented implementation would get wrong.
  const probe = { width: 360, height: 640 };

  test("TOP tile fit generically handles a portrait source (height-constrained scale + horizontal pad)", () => {
    const parts = buildScreenSpeakerFilterChain({
      aspectRatio: "16:9",
      probe,
      bottom: { cx: 0.5 },
    });
    // The TOP filter statement is IDENTICAL in shape regardless of source
    // orientation — ffmpeg's own scale filter resolves which dimension binds
    // at run time (see the module's doc comment); this is the point of using
    // "force_original_aspect_ratio=decrease" instead of a JS-side branch.
    expect(parts[1]).toBe(
      "[screen_top_src]scale=1920:540:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:540:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[screen_top]",
    );
    // BOTTOM: cropW=360 (full source width), cropH=round(360/3.5556)=101,
    // y centered (cropXForCenter(0.5, 640, 101) = 270), x=0 for cx=0.5.
    expect(parts[2]).toBe("[screen_bot_src]crop=360:101:0:270,scale=1920:540,setsar=1[screen_bot]");
  });
});

describe("buildScreenSpeakerFilterChain — sendcmd-driven vs static-center bottom tile", () => {
  const probe = { width: 640, height: 360 };

  test("sendcmd path targets its OWN crop name, never the split/reframe names", () => {
    const parts = buildScreenSpeakerFilterChain({
      aspectRatio: "9:16",
      probe,
      bottom: {
        cx: 0.5,
        reframe: { scriptPath: "/tmp/screen-bottom.txt", cropName: SCREEN_BOTTOM_CROP_NAME },
      },
    });
    expect(parts[2]).toContain("sendcmd=f='/tmp/screen-bottom.txt'");
    expect(parts[2]).toContain(`${SCREEN_BOTTOM_CROP_NAME}=w=`);
    // Never REFRAME_CROP_NAME or TWO_UP_*_CROP_NAME — sendcmd dispatches by
    // filter NAME graph-wide, so a shared name would let one script's
    // commands silently retarget an unrelated crop instance.
    expect(SCREEN_BOTTOM_CROP_NAME).not.toBe("crop@reframe");
    expect(SCREEN_BOTTOM_CROP_NAME).not.toBe("crop@twoup_top");
    expect(SCREEN_BOTTOM_CROP_NAME).not.toBe("crop@twoup_bottom");
  });

  test("static-center path (no reframe) crops around the given cx with no sendcmd stage", () => {
    const parts = buildScreenSpeakerFilterChain({
      aspectRatio: "9:16",
      probe,
      bottom: { cx: 0.5 },
    });
    expect(parts[2]).not.toContain("sendcmd");
    // cx=0.5 -> centered crop: centerPx=320, x=round(320-202.5)=118 (cropW=405).
    expect(parts[2]).toBe("[screen_bot_src]crop=405:360:118:0,scale=1080:960,setsar=1[screen_bot]");
  });

  test("escapes single quotes in the sendcmd script path", () => {
    const parts = buildScreenSpeakerFilterChain({
      aspectRatio: "9:16",
      probe,
      bottom: {
        cx: 0.5,
        reframe: { scriptPath: "/tmp/it's a path.txt", cropName: SCREEN_BOTTOM_CROP_NAME },
      },
    });
    expect(parts[2]).toContain("sendcmd=f='/tmp/it'\\''s a path.txt'");
  });

  // Element segmentation v1: `pipRect` wins over BOTH `reframe` and `cx` —
  // a facecam overlay doesn't move, so its crop is always static (no
  // sendcmd), and its own rect (already fitted to the tile ratio by
  // `fitPipCropToTile`) is used verbatim rather than `screenTileGeometry`'s
  // whole-frame-centered `cropW`/`cropH`.
  test("pipRect wins over reframe: static crop of the pip rect, no sendcmd, ignores cx/reframe", () => {
    const parts = buildScreenSpeakerFilterChain({
      aspectRatio: "9:16",
      probe,
      bottom: {
        cx: 0.1, // deliberately different from the pip rect, to prove it's ignored
        reframe: { scriptPath: "/tmp/should-be-ignored.txt", cropName: SCREEN_BOTTOM_CROP_NAME },
        pipRect: { x: 480, y: 40, w: 101, h: 90 },
      },
    });
    expect(parts[2]).not.toContain("sendcmd");
    expect(parts[2]).not.toContain("should-be-ignored");
    expect(parts[2]).toBe("[screen_bot_src]crop=100:90:480:40,scale=1080:960,setsar=1[screen_bot]");
  });

  test("pipRect w/h are floored to even (C1-lesson discipline)", () => {
    const parts = buildScreenSpeakerFilterChain({
      aspectRatio: "9:16",
      probe,
      bottom: { cx: 0.5, pipRect: { x: 10, y: 10, w: 101, h: 91 } },
    });
    // 101 -> 100, 91 -> 90 (floor to even).
    expect(parts[2]).toBe("[screen_bot_src]crop=100:90:10:10,scale=1080:960,setsar=1[screen_bot]");
  });
});

describe("screenTileGeometry — per-ratio tile heights (C1 fix)", () => {
  for (const [aspectRatio, dims] of Object.entries(ASPECT_RATIO_DIMS) as Array<
    [ClipAspectRatio, { width: number; height: number }]
  >) {
    test(`${aspectRatio}: topHeight + bottomHeight === H, both even`, () => {
      const geometry = screenTileGeometry(aspectRatio);
      expect(geometry.tileWidth).toBe(dims.width);
      expect(geometry.topHeight + geometry.bottomHeight).toBe(dims.height);
      expect(geometry.topHeight % 2).toBe(0);
      expect(geometry.bottomHeight % 2).toBe(0);
      expect(geometry.cropW).toBeNull();
      expect(geometry.cropH).toBeNull();
    });
  }

  // The bug this whole fix chases: naive `Math.round(H / 2)` for 4:5
  // (H=1350) rounds to 675, an ODD height `pad`'s yuv420p output floors to
  // 674 while `crop`+`scale` (no such floor) independently stays 675 —
  // `vstack`ing 674+675 = 1349, which `libx264` refuses to encode.
  test("4:5 specifically: 676 top / 674 bottom (never the naive 675/675 split)", () => {
    const geometry = screenTileGeometry("4:5");
    expect(geometry.topHeight).toBe(676);
    expect(geometry.bottomHeight).toBe(674);
  });

  test("both call sites (buildScreenSpeakerFilterChain, render-clips.ts's applyScreenSpeakerLayout) are structurally forced to agree — there's only one geometry function to call", () => {
    // Not a runtime assertion so much as documentation: H1's fix is that
    // divergence is impossible by construction (one exported function, both
    // callers import it), rather than two independent implementations that
    // happen to agree today. The per-ratio value tests above are the actual
    // regression guard for what that shared function returns.
    expect(typeof screenTileGeometry).toBe("function");
  });
});

describe("screenBottomIsTrackable — trackability gate (H3)", () => {
  // 1920x1080 landscape source — the exact matrix from the adversarial
  // review: 9:16 and 4:5 have lateral room to track a face in, 1:1 and 16:9
  // don't (their tile-aspect crop already consumes the full source width).
  const probe = { width: 1920, height: 1080 };

  test("9:16: trackable", () => {
    expect(screenBottomIsTrackable("9:16", probe)).toBe(true);
  });

  test("1:1: NOT trackable (tile crop == full source width)", () => {
    expect(screenBottomIsTrackable("1:1", probe)).toBe(false);
  });

  test("16:9: NOT trackable (tile crop == full source width)", () => {
    expect(screenBottomIsTrackable("16:9", probe)).toBe(false);
  });

  test("4:5: trackable (marginal lateral room, ~189px)", () => {
    const geometry = screenTileGeometry("4:5", probe);
    expect(screenBottomIsTrackable("4:5", probe)).toBe(true);
    // Documents just how marginal this case is — a source barely wider than
    // the crop it needs, unlike 9:16's much larger margin.
    expect(probe.width - (geometry.cropW as number)).toBeGreaterThan(0);
    expect(probe.width - (geometry.cropW as number)).toBeLessThan(300);
  });
});

describe("classifyScreencast — motion-fraction classification gate", () => {
  // H1 (adversarial review): default recalibrated to 0.12 — the geometric
  // mean of the PROXY-domain boundary values (worst-case screencast fixture
  // ~0.051, worst-case jensen control ~0.273) — see
  // `pipMotionThreshold`'s own doc comment and
  // `docs/plans/vizard-parity.md`'s landed note for the full table.
  test("below the default threshold (0.12): screencast-like", () => {
    expect(classifyScreencast(0.0)).toBe(true);
    expect(classifyScreencast(0.05)).toBe(true);
    expect(classifyScreencast(0.11)).toBe(true);
  });

  test("at/above the default threshold: NOT screencast-like", () => {
    expect(classifyScreencast(0.12)).toBe(false);
    expect(classifyScreencast(0.27)).toBe(false);
    expect(classifyScreencast(1.0)).toBe(false);
  });

  test("an explicit threshold overrides the env-derived default", () => {
    expect(classifyScreencast(0.3, 0.5)).toBe(true);
    expect(classifyScreencast(0.6, 0.5)).toBe(false);
  });

  test("reads WORKER_PIP_MOTION_THRESHOLD when no explicit threshold is given", () => {
    const prev = process.env.WORKER_PIP_MOTION_THRESHOLD;
    try {
      process.env.WORKER_PIP_MOTION_THRESHOLD = "0.1";
      expect(classifyScreencast(0.15)).toBe(false); // above the overridden 0.1
      expect(classifyScreencast(0.05)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.WORKER_PIP_MOTION_THRESHOLD;
      else process.env.WORKER_PIP_MOTION_THRESHOLD = prev;
    }
  });

  test("a non-finite/non-positive env value falls back to the 0.12 default", () => {
    const prev = process.env.WORKER_PIP_MOTION_THRESHOLD;
    try {
      process.env.WORKER_PIP_MOTION_THRESHOLD = "not-a-number";
      expect(classifyScreencast(0.11)).toBe(true);
      expect(classifyScreencast(0.13)).toBe(false);
      process.env.WORKER_PIP_MOTION_THRESHOLD = "-1";
      expect(classifyScreencast(0.11)).toBe(true);
      expect(classifyScreencast(0.13)).toBe(false);
      process.env.WORKER_PIP_MOTION_THRESHOLD = "0";
      expect(classifyScreencast(0.11)).toBe(true);
      expect(classifyScreencast(0.13)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.WORKER_PIP_MOTION_THRESHOLD;
      else process.env.WORKER_PIP_MOTION_THRESHOLD = prev;
    }
  });

  // L6 (adversarial review): `movingPxFrac` is always <= 1, so an env
  // threshold above 1 would otherwise make `classifyScreencast` accept
  // EVERY clip as screencast-like — clamped to 1, not accepted as-is.
  test("an env value above 1 clamps to 1, not accepted as a literal threshold", () => {
    const prev = process.env.WORKER_PIP_MOTION_THRESHOLD;
    try {
      process.env.WORKER_PIP_MOTION_THRESHOLD = "2";
      expect(classifyScreencast(0.99)).toBe(true); // clamped threshold is 1, not 2
      expect(classifyScreencast(1.0)).toBe(false); // 1.0 is never < the clamped threshold of 1
    } finally {
      if (prev === undefined) delete process.env.WORKER_PIP_MOTION_THRESHOLD;
      else process.env.WORKER_PIP_MOTION_THRESHOLD = prev;
    }
  });
});

describe("selectPipRect — corner-adjacent + compact + dense structural prior", () => {
  // The spike's headline measured failure: a large, non-corner-adjacent
  // "embedded video-in-video" blob has the biggest area/motion of any
  // candidate — a naive "pick the largest/most-moving blob" selector would
  // choose it (IoU 0.000 against the real facecam in the spike). The
  // corner-adjacent gate must reject it outright, regardless of its size.
  test("rejects a large, non-corner-adjacent blob even when it's the biggest/most-moving candidate (naive-largest failure mode)", () => {
    const embeddedVideo: PipCandidate = {
      x: 0.1,
      y: 0.1,
      w: 0.4,
      h: 0.4,
      areaFrac: 0.16, // biggest by far — outside the 0.5%-15% acceptance window AND not corner-adjacent
      fillFrac: 0.9,
      cornerAdjacent: false,
      medianDiffMean: 20,
    };
    const facecam: PipCandidate = {
      x: 0.79,
      y: 0.78,
      w: 0.2,
      h: 0.2,
      areaFrac: 0.04,
      fillFrac: 0.9,
      cornerAdjacent: true,
      medianDiffMean: 4.6,
    };
    const naiveLargest = [embeddedVideo, facecam].reduce((a, b) =>
      b.areaFrac > a.areaFrac ? b : a,
    );
    expect(naiveLargest).toBe(embeddedVideo); // documents the naive failure mode
    expect(selectPipRect([embeddedVideo, facecam])).toEqual({
      x: 0.79,
      y: 0.78,
      w: 0.2,
      h: 0.2,
    });
  });

  test("rejects a corner-adjacent candidate whose area is below the acceptance window (noise speck)", () => {
    const speck: PipCandidate = {
      x: 0.01,
      y: 0.01,
      w: 0.02,
      h: 0.02,
      areaFrac: 0.0004,
      fillFrac: 0.9,
      cornerAdjacent: true,
      medianDiffMean: 50,
    };
    expect(selectPipRect([speck])).toBeNull();
  });

  test("rejects a corner-adjacent candidate whose area is above the acceptance window (too big to be an overlay)", () => {
    const huge: PipCandidate = {
      x: 0,
      y: 0,
      w: 0.5,
      h: 0.5,
      areaFrac: 0.25,
      fillFrac: 0.9,
      cornerAdjacent: true,
      medianDiffMean: 10,
    };
    expect(selectPipRect([huge])).toBeNull();
  });

  test("rejects a compact but non-corner-adjacent candidate (a hand gesture mid-frame, not an overlay)", () => {
    const midFrameBlob: PipCandidate = {
      x: 0.4,
      y: 0.4,
      w: 0.1,
      h: 0.1,
      areaFrac: 0.01,
      fillFrac: 0.9,
      cornerAdjacent: false,
      medianDiffMean: 8,
    };
    expect(selectPipRect([midFrameBlob])).toBeNull();
  });

  // M1 (adversarial review): a candidate can be corner-adjacent and the
  // right size, yet still not be trustworthy as a facecam if the actual
  // thresholded pixels only sparsely fill their own bounding box (e.g. an
  // L-shaped scatter formed by disjoint bits of motion sharing one bbox).
  test("rejects a corner-adjacent, in-bounds-area candidate whose fillFrac is below the density gate", () => {
    const sparse: PipCandidate = {
      x: 0.8,
      y: 0.8,
      w: 0.15,
      h: 0.15,
      areaFrac: 0.0225,
      fillFrac: 0.2, // below the default 0.35 gate
      cornerAdjacent: true,
      medianDiffMean: 10,
    };
    expect(selectPipRect([sparse])).toBeNull();
    expect(selectPipRect([sparse], { minFillFrac: 0.1 })).toEqual({
      x: 0.8,
      y: 0.8,
      w: 0.15,
      h: 0.15,
    });
  });

  test("returns null for an empty candidate list", () => {
    expect(selectPipRect([])).toBeNull();
  });

  test("custom area bounds override the defaults", () => {
    const candidate: PipCandidate = {
      x: 0.8,
      y: 0.8,
      w: 0.3,
      h: 0.3,
      areaFrac: 0.09,
      fillFrac: 0.9,
      cornerAdjacent: true,
      medianDiffMean: 3,
    };
    expect(selectPipRect([candidate], { maxAreaFrac: 0.05 })).toBeNull();
    expect(selectPipRect([candidate], { maxAreaFrac: 0.1 })).toEqual({
      x: 0.8,
      y: 0.8,
      w: 0.3,
      h: 0.3,
    });
  });

  // M1 (adversarial review): a real facecam frequently thresholds into more
  // than one connected component (e.g. a bright face + a dimmer shoulder/
  // bezel edge separated by a thin gap the morphological close didn't fully
  // bridge) — those must be treated as ONE region, not compete as two
  // independent (and individually weaker) candidates.
  test("merges two adjacent (gap < 2% of frame) corner-qualifying candidates into their bbox union", () => {
    const a: PipCandidate = {
      x: 0.78,
      y: 0.78,
      w: 0.1,
      h: 0.1,
      areaFrac: 0.01,
      fillFrac: 0.8,
      cornerAdjacent: true,
      medianDiffMean: 6,
    };
    const b: PipCandidate = {
      // Starts 0.015 (< the 0.02 merge-gap threshold) past `a`'s right edge
      // (0.88), same y-span — no bbox overlap, but close enough to merge.
      x: 0.895,
      y: 0.78,
      w: 0.08,
      h: 0.1,
      areaFrac: 0.008,
      fillFrac: 0.5,
      cornerAdjacent: true,
      medianDiffMean: 6,
    };
    const merged = selectPipRect([a, b]);
    expect(merged?.x).toBeCloseTo(0.78, 6);
    expect(merged?.y).toBeCloseTo(0.78, 6);
    expect(merged?.w).toBeCloseTo(0.195, 6); // union: [0.78, 0.975]
    expect(merged?.h).toBeCloseTo(0.1, 6);
  });

  test("does NOT merge two qualifying candidates that are far apart (gap >= 2% of frame) — they compete instead", () => {
    // Well-separated (top-left vs. bottom-right), so no merge; the
    // bottom-right one has the higher pixel-area-weighted medianDiffMean
    // despite being much smaller — see the "highest medianDiffMean" test
    // below for that selection rule specifically.
    const topLeft: PipCandidate = {
      x: 0.02,
      y: 0.02,
      w: 0.1,
      h: 0.1,
      areaFrac: 0.01,
      fillFrac: 0.5,
      cornerAdjacent: true,
      medianDiffMean: 3,
    };
    const bottomRight: PipCandidate = {
      x: 0.85,
      y: 0.85,
      w: 0.1,
      h: 0.1,
      areaFrac: 0.01,
      fillFrac: 0.5,
      cornerAdjacent: true,
      medianDiffMean: 3,
    };
    // Same medianDiffMean, same size — with no merge, either could win on a
    // tie; the point of this test is just that the RESULT is one of the two
    // untouched candidates, not some merged hybrid (which would indicate a
    // merge incorrectly fired across the whole frame).
    const result = selectPipRect([topLeft, bottomRight]);
    expect([topLeft, bottomRight].some((c) => result?.x === c.x && result?.y === c.y)).toBe(true);
  });

  // M1 (adversarial review): the OLD policy picked the smallest qualifying
  // candidate outright — that was never spike-validated (the spike
  // validated the corner-adjacent + compact-size prior, not "prefer
  // smallest among several qualifiers") and has an obvious failure mode: a
  // tiny noise-adjacent fragment could beat a much more clearly
  // motion-dense region purely by being smaller. Current policy selects the
  // HIGHEST pixel-area-weighted `medianDiffMean` instead.
  test("selects the candidate with the highest (pixel-area-weighted) medianDiffMean, NOT the smallest", () => {
    const big: PipCandidate = {
      x: 0.02,
      y: 0.02,
      w: 0.3,
      h: 0.3,
      areaFrac: 0.09,
      fillFrac: 0.5,
      cornerAdjacent: true,
      medianDiffMean: 3, // low motion strength
    };
    const small: PipCandidate = {
      x: 0.85,
      y: 0.85,
      w: 0.1,
      h: 0.1,
      areaFrac: 0.01,
      fillFrac: 0.5,
      cornerAdjacent: true,
      medianDiffMean: 8, // high motion strength, wins despite being 9x smaller
    };
    expect(selectPipRect([big, small])).toEqual({ x: 0.85, y: 0.85, w: 0.1, h: 0.1 });
  });

  test("ties on medianDiffMean break toward the SMALLER (tighter) bbox", () => {
    const bigger: PipCandidate = {
      x: 0.02,
      y: 0.02,
      w: 0.25,
      h: 0.25,
      areaFrac: 0.0625,
      fillFrac: 0.5,
      cornerAdjacent: true,
      medianDiffMean: 4,
    };
    const smaller: PipCandidate = {
      x: 0.85,
      y: 0.75,
      w: 0.125,
      h: 0.25,
      areaFrac: 0.03125,
      fillFrac: 0.5,
      cornerAdjacent: true,
      medianDiffMean: 4,
    };
    expect(selectPipRect([bigger, smaller])).toEqual({
      x: 0.85,
      y: 0.75,
      w: 0.125,
      h: 0.25,
    });
  });
});

describe("fitPipCropToTile — expand-to-tile-ratio + clamp-to-frame (never crops the detected rect away)", () => {
  // 1920x1080 source, 9:16 tile ratio 1.125 (tileWidth 1080 / bottomHeight
  // 960, screenTileGeometry("9:16")'s own values).
  const probe = { width: 1920, height: 1080 };
  const tileRatio = 1080 / 960; // 1.125

  test("grows the short axis to hit tileRatio exactly, centered, with the 8% margin applied", () => {
    // Normalized pip rect matching fixture1's ground truth (1520,846,380,214
    // / 1920x1080): x=0.7917, y=0.7833, w=0.1979, h=0.1981 (near-square).
    const pipRect = { x: 0.7917, y: 0.7833, w: 0.1979, h: 0.1981 };
    const fitted = fitPipCropToTile(pipRect, tileRatio, probe);

    // Result must hit tileRatio (within integer-rounding tolerance).
    expect(fitted.w / fitted.h).toBeCloseTo(tileRatio, 1);

    // Never smaller than the (margin-grown) detected rect on its long axis:
    // w >= original w * (1 + 2*0.08), same for h's short-axis growth case.
    const originalWPx = pipRect.w * probe.width;
    expect(fitted.w).toBeGreaterThanOrEqual(Math.round(originalWPx * 1.16 * 0.99));

    // Stays inside the source frame.
    expect(fitted.x).toBeGreaterThanOrEqual(0);
    expect(fitted.y).toBeGreaterThanOrEqual(0);
    expect(fitted.x + fitted.w).toBeLessThanOrEqual(probe.width);
    expect(fitted.y + fitted.h).toBeLessThanOrEqual(probe.height);
  });

  test("clamps to the source frame when the fitted rect would otherwise exceed it, preserving tileRatio", () => {
    // A pip rect already covering nearly the whole (small) source — growing
    // it by the margin + aspect-fit would exceed the frame on some axis.
    const smallProbe = { width: 200, height: 150 };
    const pipRect = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
    const fitted = fitPipCropToTile(pipRect, tileRatio, smallProbe);

    expect(fitted.w).toBeLessThanOrEqual(smallProbe.width);
    expect(fitted.h).toBeLessThanOrEqual(smallProbe.height);
    expect(fitted.x).toBeGreaterThanOrEqual(0);
    expect(fitted.y).toBeGreaterThanOrEqual(0);
    expect(fitted.x + fitted.w).toBeLessThanOrEqual(smallProbe.width);
    expect(fitted.y + fitted.h).toBeLessThanOrEqual(smallProbe.height);
    // Aspect ratio still preserved even after the shrink-to-fit clamp.
    expect(fitted.w / fitted.h).toBeCloseTo(tileRatio, 1);
  });

  test("a rect already wider than tileRatio demands grows its height instead of its width", () => {
    // A wide letterbox-shaped pip rect (w/h way above tileRatio 1.125).
    const pipRect = { x: 0.1, y: 0.4, w: 0.3, h: 0.05 };
    const fitted = fitPipCropToTile(pipRect, tileRatio, probe);
    expect(fitted.w / fitted.h).toBeCloseTo(tileRatio, 1);
    // Width should be close to the margin-grown original (not grown further)
    // since height was the axis that needed to grow.
    const marginedWPx = pipRect.w * probe.width * 1.16;
    expect(fitted.w).toBeCloseTo(marginedWPx, -1);
  });

  // L2 (adversarial review): rounding `w`/`h` AFTER computing the shrink
  // factor but BEFORE clamping `x`/`y` against them means `x + w` (and
  // `y + h`) can never exceed `probe.width`/`probe.height` — the old order
  // (clamp against fractional `w`/`h`, round `w`/`h` separately afterward)
  // could let a `w` that rounded UP push `x + w` past the frame edge by up
  // to a pixel. Uses a pip rect deliberately close to the bottom-right
  // corner (so growth is asymmetric and likely to hit a rounding edge case)
  // across a range of tile ratios.
  test("L2: x + w never exceeds probe.width and y + h never exceeds probe.height, for any tile ratio", () => {
    const nearCornerProbe = { width: 1337, height: 751 }; // odd, non-round dims on purpose
    const pipRect = { x: 0.83, y: 0.81, w: 0.14, h: 0.17 };
    for (const ratio of [0.5, 0.75, 1.0, 1.125, 1.6, 2.0, 3.556]) {
      const fitted = fitPipCropToTile(pipRect, ratio, nearCornerProbe);
      expect(fitted.x + fitted.w).toBeLessThanOrEqual(nearCornerProbe.width);
      expect(fitted.y + fitted.h).toBeLessThanOrEqual(nearCornerProbe.height);
      expect(fitted.x).toBeGreaterThanOrEqual(0);
      expect(fitted.y).toBeGreaterThanOrEqual(0);
    }
  });
});

// M8 (adversarial review): `fitPipCropToTile`'s containment contract,
// verified across ALL FOUR output aspect ratios' own tile ratios
// (`screenTileGeometry`) — the string-level tests above only exercised a
// single hardcoded 9:16 tile ratio. Two distinct contracts, matching what
// the function actually guarantees (verified numerically before writing
// these, not assumed): on the NON-shrink path (the grown/aspect-fitted rect
// already fits inside the source — `shrink === 1` internally, not itself
// observable from the return value, so these tests use fixtures chosen to
// stay on that path), the fitted crop always fully CONTAINS the original
// detected `pipRect`. On the SHRINK path (the source is too small to hold
// the grown rect), full containment is NOT guaranteed — only the detected
// rect's CENTER staying inside the fitted crop is.
describe("fitPipCropToTile — containment contract across all four output tile ratios (M8)", () => {
  const probe = { width: 1920, height: 1080 };
  // Near the bottom-right corner, comfortably inside the frame — stays on
  // the non-shrink path for every one of the four tile ratios below.
  const pipRect = { x: 0.7917, y: 0.7833, w: 0.1979, h: 0.1981 };

  for (const aspectRatio of Object.keys(ASPECT_RATIO_DIMS) as ClipAspectRatio[]) {
    const { tileRatio } = screenTileGeometry(aspectRatio, probe);

    test(`${aspectRatio} (tileRatio ${tileRatio.toFixed(3)}): non-shrink path fully contains the detected rect (source px)`, () => {
      const fitted = fitPipCropToTile(pipRect, tileRatio, probe);
      const detX = pipRect.x * probe.width;
      const detY = pipRect.y * probe.height;
      const detW = pipRect.w * probe.width;
      const detH = pipRect.h * probe.height;

      expect(fitted.x).toBeLessThanOrEqual(detX);
      expect(fitted.y).toBeLessThanOrEqual(detY);
      expect(fitted.x + fitted.w).toBeGreaterThanOrEqual(detX + detW);
      expect(fitted.y + fitted.h).toBeGreaterThanOrEqual(detY + detH);
      // Never exceeds the source frame either.
      expect(fitted.x + fitted.w).toBeLessThanOrEqual(probe.width);
      expect(fitted.y + fitted.h).toBeLessThanOrEqual(probe.height);
    });

    test(`${aspectRatio} (tileRatio ${tileRatio.toFixed(3)}): shrink-to-fit path only guarantees the detected rect's CENTER stays inside`, () => {
      const smallProbe = { width: 200, height: 150 };
      const bigPipRect = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
      const fitted = fitPipCropToTile(bigPipRect, tileRatio, smallProbe);

      const cx = (bigPipRect.x + bigPipRect.w / 2) * smallProbe.width;
      const cy = (bigPipRect.y + bigPipRect.h / 2) * smallProbe.height;
      expect(cx).toBeGreaterThanOrEqual(fitted.x);
      expect(cx).toBeLessThanOrEqual(fitted.x + fitted.w);
      expect(cy).toBeGreaterThanOrEqual(fitted.y);
      expect(cy).toBeLessThanOrEqual(fitted.y + fitted.h);
      // Still stays inside the (small) source frame.
      expect(fitted.x + fitted.w).toBeLessThanOrEqual(smallProbe.width);
      expect(fitted.y + fitted.h).toBeLessThanOrEqual(smallProbe.height);
    });
  }
});

// M3 (adversarial review, PiP persistence follow-up): `fitPipCropToTile`
// has an independently-maintained client-side twin,
// `fitPipCropToTileNormalized` (apps/web/.../pip-crop-math.ts), which the
// studio preview uses to replicate this exact math in normalized (0..1)
// coordinates since the browser only ever has the source's pixel DIMENSIONS,
// not a pixel-space crop request. The two are NOT unified behind a shared
// import (this package has no dependency on apps/web, and apps/web has none
// on apps/worker) — this fixture table (6 `[pipRect, tileRatio, probe] ->
// exact {x,y,w,h}` cases) is duplicated VERBATIM in
// apps/web/.../pip-crop-math.test.ts (same inputs, expected outputs divided
// by `probe`'s width/height to normalize) so a future change to either
// implementation's growth/clamp/shrink order fails ONE of the two suites
// immediately, rather than silently drifting until someone notices the
// preview and the render disagree. Values below were generated by running
// THIS module's `fitPipCropToTile` (the parity source of truth) directly —
// exact integers, not `toBeCloseTo` tolerances, since both implementations
// are expected to agree to the pixel.
describe("fitPipCropToTile — cross-package parity fixtures (M3, shared verbatim with apps/web's pip-crop-math.test.ts)", () => {
  const fixtures: Array<{
    name: string;
    pipRect: { x: number; y: number; w: number; h: number };
    aspectRatio: ClipAspectRatio;
    probe: { width: number; height: number };
    expected: { x: number; y: number; w: number; h: number };
  }> = [
    {
      name: "9:16 tile, non-shrink",
      pipRect: { x: 0.7917, y: 0.7833, w: 0.1979, h: 0.1981 },
      aspectRatio: "9:16",
      probe: { width: 1920, height: 1080 },
      expected: { x: 1479, y: 688, w: 441, h: 392 },
    },
    {
      name: "1:1 tile, non-shrink, same detected rect as the 9:16 case",
      pipRect: { x: 0.7917, y: 0.7833, w: 0.1979, h: 0.1981 },
      aspectRatio: "1:1",
      probe: { width: 1920, height: 1080 },
      expected: { x: 1424, y: 829, w: 496, h: 248 },
    },
    {
      name: "16:9 tile, wide rect (grows height, not width)",
      pipRect: { x: 0.1, y: 0.4, w: 0.3, h: 0.05 },
      aspectRatio: "16:9",
      probe: { width: 1920, height: 1080 },
      expected: { x: 146, y: 365, w: 668, h: 188 },
    },
    {
      name: "4:5 tile, shrink-to-fit path (small probe, near-full-frame pipRect)",
      pipRect: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
      aspectRatio: "4:5",
      probe: { width: 1280, height: 720 },
      expected: { x: 63, y: 0, w: 1154, h: 720 },
    },
    {
      name: "9:16 tile, odd non-round probe dims near the bottom-right corner",
      pipRect: { x: 0.83, y: 0.81, w: 0.14, h: 0.17 },
      aspectRatio: "9:16",
      probe: { width: 1337, height: 751 },
      expected: { x: 1095, y: 558, w: 217, h: 193 },
    },
    {
      name: "16:9 tile, 4K probe",
      pipRect: { x: 0.6, y: 0.65, w: 0.25, h: 0.2 },
      aspectRatio: "16:9",
      probe: { width: 3840, height: 2160 },
      expected: { x: 1893, y: 1370, w: 1782, h: 501 },
    },
  ];

  for (const f of fixtures) {
    test(f.name, () => {
      const { tileRatio } = screenTileGeometry(f.aspectRatio, f.probe);
      const fitted = fitPipCropToTile(f.pipRect, tileRatio, f.probe);
      expect(fitted).toEqual(f.expected);
    });
  }
});

describe("pipCropTooSmall — M3 (fitted crop too narrow relative to its tile)", () => {
  test("below 40% of tile width is too small", () => {
    expect(pipCropTooSmall(399, 1000)).toBe(true);
    expect(pipCropTooSmall(400, 1000)).toBe(false);
    expect(pipCropTooSmall(800, 1000)).toBe(false);
  });
});

function faceSample(cx: number | null): FaceSample {
  return { t: 0, cx };
}

describe("confirmsFaceInRect — H2 (face-confirmation guard against motion-only false positives)", () => {
  const pipRect = { x: 0.7, y: 0.7, w: 0.2, h: 0.2 };

  test("confirms when faces are found in enough samples AND mostly fall inside the rect", () => {
    const samples: FaceSample[] = [
      faceSample(0.75),
      faceSample(0.8),
      faceSample(0.78),
      faceSample(null),
    ];
    expect(confirmsFaceInRect(samples, pipRect)).toBe(true);
  });

  test("rejects when too few samples carry a detected face at all (below the 25% sample-share gate)", () => {
    // Only 1/5 samples has a face — even though it's inside the rect, the
    // sample count itself is too sparse to trust.
    const samples: FaceSample[] = [
      faceSample(0.75),
      faceSample(null),
      faceSample(null),
      faceSample(null),
      faceSample(null),
    ];
    expect(confirmsFaceInRect(samples, pipRect)).toBe(false);
  });

  // H2's actual motivating scenario: motion segmentation's measured false
  // positive on real talking-head footage (a hand gesture near the frame
  // edge reads as a corner-adjacent, compact, dense motion blob) — the
  // detected FACE, when it's found at all, is NOT inside that "PiP" rect
  // (the face is centered, the false-positive rect is off in a corner).
  test("rejects when faces are found often enough but mostly OUTSIDE the rect (the measured hand-gesture false positive)", () => {
    const samples: FaceSample[] = [
      faceSample(0.5),
      faceSample(0.48),
      faceSample(0.52),
      faceSample(0.5),
    ];
    expect(confirmsFaceInRect(samples, pipRect)).toBe(false);
  });

  test("null samples/rect are never confirmed", () => {
    expect(confirmsFaceInRect(null, pipRect)).toBe(false);
    expect(confirmsFaceInRect([], pipRect)).toBe(false);
    expect(confirmsFaceInRect([faceSample(0.75)], null)).toBe(false);
  });

  test("custom thresholds override the defaults", () => {
    const samples: FaceSample[] = [faceSample(0.75), faceSample(null), faceSample(null)];
    // 1/3 face-bearing share (0.33) clears a lowered 0.2 gate, and its lone
    // sample is inside the rect (100% >= any inside-share threshold).
    expect(confirmsFaceInRect(samples, pipRect, { minSampleShare: 0.2 })).toBe(true);
    expect(confirmsFaceInRect(samples, pipRect, { minSampleShare: 0.5 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C1/M5-style ffmpeg smoke test (mirrors render-clips.test.ts's own
// smoke-test idiom): string-level filtergraph assertions above can't catch a
// SAR/pixel-format/odd-dimension class of bug (see the module's own GOTCHA
// doc comment and C1) — only actually running ffmpeg on a synthetic source
// can. Parameterized over all four output aspect ratios x {static-center,
// sendcmd-driven} bottom tile (8 executions total) so a regression specific
// to one ratio (like C1's 4:5-only odd-height bug) or one bottom-tile mode
// can't hide behind the other seven passing. Kept fast: a 1s synthetic
// source per execution. Skipped cleanly (not failed) when ffmpeg/ffprobe
// aren't on PATH.
// ---------------------------------------------------------------------------
const FFMPEG_AVAILABLE = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const FFPROBE_AVAILABLE = spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

describe("ffmpeg smoke test — screen layout actually renders", () => {
  let tempDir: string;
  // One synthetic 1920x1080 source shared across every case in this
  // describe block (generated once in `beforeEach` per case is wasteful —
  // shared once per describe run instead, since it never varies).
  let sourcePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "screen-layout-smoke-"));
    sourcePath = join(tempDir, "source.mp4");
    if (FFMPEG_AVAILABLE) {
      const generate = spawnSync("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=1920x1080:rate=25:duration=1",
        "-pix_fmt",
        "yuv420p",
        sourcePath,
      ]);
      if (generate.status !== 0) {
        throw new Error(`source generation failed (status ${generate.status}):\n${generate.stderr}`);
      }
    }
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const CASES: Array<{ aspectRatio: ClipAspectRatio; mode: "static-center" | "sendcmd-driven" | "pip" }> = [
    { aspectRatio: "9:16", mode: "static-center" },
    { aspectRatio: "9:16", mode: "sendcmd-driven" },
    // Element segmentation v1: one pipRect case, exercising the NEW crop
    // branch (`buildScreenSpeakerFilterChain`'s `bottom.pipRect` path) end
    // to end against real ffmpeg — string-level assertions elsewhere in this
    // file can't catch a SAR/odd-dimension bug the way this can.
    { aspectRatio: "9:16", mode: "pip" },
    { aspectRatio: "1:1", mode: "static-center" },
    { aspectRatio: "1:1", mode: "sendcmd-driven" },
    { aspectRatio: "16:9", mode: "static-center" },
    { aspectRatio: "16:9", mode: "sendcmd-driven" },
    { aspectRatio: "4:5", mode: "static-center" },
    { aspectRatio: "4:5", mode: "sendcmd-driven" },
  ];

  for (const { aspectRatio, mode } of CASES) {
    const dims = ASPECT_RATIO_DIMS[aspectRatio];

    test.skipIf(!FFMPEG_AVAILABLE || !FFPROBE_AVAILABLE)(
      `1920x1080 synthetic source -> ${aspectRatio} screen layout (${mode}): exit 0, ${dims.width}x${dims.height}, SAR 1:1`,
      async () => {
        const outputPath = join(tempDir, `output-${aspectRatio.replace(":", "x")}-${mode}.mp4`);

        let bottom: {
          cx: number;
          reframe?: { scriptPath: string; cropName: string };
          pipRect?: { x: number; y: number; w: number; h: number };
        };
        if (mode === "sendcmd-driven") {
          const scriptPath = join(tempDir, `sendcmd-${aspectRatio.replace(":", "x")}.txt`);
          // Minimal but real sendcmd script — a single command at t=0 is
          // enough to exercise the `sendcmd=`+named-crop filter stage; the
          // point of this test is that ffmpeg accepts and runs the whole
          // filtergraph, not the smoothing math (that's reframe.test.ts's
          // job).
          await writeFile(scriptPath, `0.000 ${SCREEN_BOTTOM_CROP_NAME} x 0;\n`, "utf-8");
          bottom = { cx: 0.5, reframe: { scriptPath, cropName: SCREEN_BOTTOM_CROP_NAME } };
        } else if (mode === "pip") {
          // A realistic fitted PiP rect for a 9:16 tile (tileRatio 1.125)
          // against the 1920x1080 synthetic source — bottom-right corner,
          // mirrors `fitPipCropToTile`'s own output shape.
          bottom = { cx: 0.5, pipRect: { x: 1500, y: 820, w: 400, h: 240 } };
        } else {
          bottom = { cx: 0.5 };
        }

        const parts = buildScreenSpeakerFilterChain({
          aspectRatio,
          probe: { width: 1920, height: 1080 },
          bottom,
        });

        const args = [
          "-y",
          "-i",
          sourcePath,
          "-filter_complex",
          parts.join(";"),
          "-map",
          "[outv]",
          "-t",
          "1",
          outputPath,
        ];

        const render = spawnSync("ffmpeg", args, { encoding: "utf-8" });
        if (render.status !== 0) {
          throw new Error(`ffmpeg failed (status ${render.status}):\n${render.stderr}`);
        }
        expect(render.status).toBe(0);

        const probeResult = spawnSync("ffprobe", [
          "-v",
          "quiet",
          "-print_format",
          "json",
          "-show_streams",
          "-select_streams",
          "v:0",
          outputPath,
        ]);
        expect(probeResult.status).toBe(0);
        const probed = JSON.parse(probeResult.stdout.toString()) as {
          streams?: Array<{ width?: number; height?: number; sample_aspect_ratio?: string }>;
        };
        const stream = probed.streams?.[0];
        expect(stream?.width).toBe(dims.width);
        expect(stream?.height).toBe(dims.height);
        // "1:1" or "1" depending on ffmpeg build's normalization — both mean
        // square pixels (the whole point of this test — see the module's
        // GOTCHA doc comment on mismatched-SAR vstack failures).
        expect(["1:1", "1"]).toContain(stream?.sample_aspect_ratio);
      },
      30_000,
    );
  }
});
