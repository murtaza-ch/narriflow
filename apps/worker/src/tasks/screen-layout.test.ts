import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ClipAspectRatio } from "@narriflow/validators";
import {
  buildScreenSpeakerFilterChain,
  screenBottomIsTrackable,
  screenTileGeometry,
  SCREEN_BOTTOM_CROP_NAME,
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

  const CASES: Array<{ aspectRatio: ClipAspectRatio; mode: "static-center" | "sendcmd-driven" }> = [
    { aspectRatio: "9:16", mode: "static-center" },
    { aspectRatio: "9:16", mode: "sendcmd-driven" },
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

        let bottom: { cx: number; reframe?: { scriptPath: string; cropName: string } };
        if (mode === "sendcmd-driven") {
          const scriptPath = join(tempDir, `sendcmd-${aspectRatio.replace(":", "x")}.txt`);
          // Minimal but real sendcmd script — a single command at t=0 is
          // enough to exercise the `sendcmd=`+named-crop filter stage; the
          // point of this test is that ffmpeg accepts and runs the whole
          // filtergraph, not the smoothing math (that's reframe.test.ts's
          // job).
          await writeFile(scriptPath, `0.000 ${SCREEN_BOTTOM_CROP_NAME} x 0;\n`, "utf-8");
          bottom = { cx: 0.5, reframe: { scriptPath, cropName: SCREEN_BOTTOM_CROP_NAME } };
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
