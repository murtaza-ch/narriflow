/**
 * Screen-share layout (vizard-parity.md Phase C-2 stage 1, "screen" framing
 * mode — screen packet B, the worker render path). Pure filtergraph-string
 * builder only — no FFmpeg execution, no Prisma, no detection; wiring lives
 * in render-clips.ts (mirrors two-up.ts's own split between pure geometry
 * here and render-clips.ts's `isScreenMode` gate).
 *
 * Composition: a static two-tile stack, TOP over BOTTOM, together exactly
 * `W x H` of the target output (see `screenTileGeometry` for the top/bottom
 * height split — NOT a plain `H/2` each; see its doc comment for why) —
 *   - TOP: the full source frame FIT (scale-to-contain + letterbox pad,
 *     never cropped) — this is the "screen" element (a shared window/slide/
 *     app) and must stay fully readable, so it can never lose any of the
 *     source frame the way a crop would.
 *   - BOTTOM: a face-CENTERED horizontal crop of the WHOLE source frame —
 *     the exact same single-face detection `reframe.ts`'s auto-reframe path
 *     uses (`smoothFacePath` + `buildReframeSendcmdScript`), just aimed at a
 *     half-height tile instead of the full output. This is NOT a facecam/
 *     webcam sub-region detector — there is no PiP-region localization here,
 *     only "where in the full frame is the one detected face, horizontally."
 *     render-clips.ts's `applyScreenSpeakerLayout` builds the sendcmd script
 *     this module's `bottom.reframe` consumes, or falls back to a static
 *     center crop when no face is detected/detection is unavailable/the
 *     output has no lateral room to track in (see `screenBottomIsTrackable`)
 *     — never a failed render, and never a whole-clip fallback to
 *     auto-reframe the way split does — a screen clip is still valuable
 *     with a centered bottom tile, since the TOP tile is the whole point of
 *     this layout).
 *
 * H3 (adversarial review): unlike `two-up.ts`'s split layout, the two tiles
 * here are always DIFFERENT CONTENT (full-frame-fit vs. a face crop) so
 * `splitTilesAreDistinct`'s "both tiles show the identical source region"
 * failure mode can't happen here — but that is a much narrower guarantee
 * than "the bottom tile always tracks the speaker." For output aspect
 * ratios wide/square enough that the tile ratio (`tileWidth / bottomHeight`,
 * DOUBLE the output's own aspect since the tile is only part-height) demands
 * a crop at least as wide as the source has (1:1, 16:9 against a landscape
 * source), `cropXForCenter`'s `x` clamps to the same single value for every
 * possible center, so a sendcmd track driving it would be a pure no-op —
 * `screenBottomIsTrackable` is the gate `applyScreenSpeakerLayout` uses to
 * skip building that dead script and render an honest static-center bottom
 * tile instead.
 */
import type { ClipAspectRatio } from "@narriflow/validators";
import { clipAspectRatioOptions } from "@narriflow/validators";
import { cropXForCenter } from "./reframe";
import { computeTileCrop } from "./two-up";

const aspectRatioDimensions = new Map(
  clipAspectRatioOptions.map((option) => [option.value, { width: option.width, height: option.height }]),
);

export interface ScreenTileGeometry {
  tileWidth: number;
  /** TOP tile height in px — the FIT tile. See doc comment on
   *  `screenTileGeometry` for why this isn't just `H - bottomHeight`'s twin
   *  (`Math.round(H / 2)`). */
  topHeight: number;
  /** BOTTOM (speaker) tile height in px. */
  bottomHeight: number;
  /** `tileWidth / bottomHeight` — the aspect ratio `computeTileCrop` sizes
   *  the BOTTOM tile's crop rectangle against (double the output's own
   *  aspect ratio, since the tile is only part-height). */
  tileRatio: number;
  /** BOTTOM tile crop width against `probe` — `null` when no `probe` was
   *  given (geometry-only query, e.g. just the tile heights). */
  cropW: number | null;
  /** BOTTOM tile crop height against `probe` — `null` when no `probe` was
   *  given. */
  cropH: number | null;
}

/**
 * H1 (adversarial review): the SOLE source of screen-layout tile geometry —
 * both `buildScreenSpeakerFilterChain` (below) and render-clips.ts's
 * `applyScreenSpeakerLayout` consume this instead of each re-deriving
 * tileWidth/tileHeight/tileRatio independently, which is exactly how C1's
 * odd-tile-height bug could have been half-fixed in one call site and not
 * the other with no error (ffmpeg clamps a wrong `x`, it doesn't reject it).
 *
 * C1: the two tile heights are NOT both `Math.round(H / 2)` — for 4:5
 * (1080x1350) that rounds to 675, an ODD height, and `pad`'s yuv420p output
 * floors an odd dimension to the even value below it (top tile emits
 * 1080x674 while the bottom tile, built the same way, independently emits
 * 675 since `crop`+`scale` don't have `pad`'s floor-to-even behavior) —
 * `vstack`ing 674 + 675 produces 1080x1349, which `libx264` refuses to
 * encode ("height not divisible by 2"). Instead, `bottomHeight` is forced
 * even by construction (`2 * Math.floor(H / 4)`), and `topHeight` is
 * whatever's left (`H - bottomHeight`) — since `H` itself is always even
 * (true for all four `ClipAspectRatio` output dimensions), an even number
 * minus an even number is always even too, so BOTH heights are guaranteed
 * even for every target without a per-ratio special case.
 */
export function screenTileGeometry(
  aspectRatio: ClipAspectRatio,
): { tileWidth: number; topHeight: number; bottomHeight: number; tileRatio: number; cropW: null; cropH: null };
export function screenTileGeometry(
  aspectRatio: ClipAspectRatio,
  probe: { width: number; height: number },
): { tileWidth: number; topHeight: number; bottomHeight: number; tileRatio: number; cropW: number; cropH: number };
export function screenTileGeometry(
  aspectRatio: ClipAspectRatio,
  probe?: { width: number; height: number },
): ScreenTileGeometry {
  const dims = aspectRatioDimensions.get(aspectRatio);
  if (!dims) {
    throw new Error(`screenTileGeometry: unsupported aspect ratio ${aspectRatio}`);
  }
  const { width: W, height: H } = dims;
  const tileWidth = W;
  const bottomHeight = 2 * Math.floor(H / 4);
  const topHeight = H - bottomHeight;
  if (tileWidth < 2 || topHeight < 2 || bottomHeight < 2) {
    throw new Error(
      `screenTileGeometry: degenerate tile geometry (tile ${tileWidth}x top${topHeight}/bottom${bottomHeight})`,
    );
  }
  const tileRatio = tileWidth / bottomHeight;

  if (!probe) {
    return { tileWidth, topHeight, bottomHeight, tileRatio, cropW: null, cropH: null };
  }
  if (
    !Number.isFinite(probe.width) ||
    !Number.isFinite(probe.height) ||
    probe.width < 2 ||
    probe.height < 2
  ) {
    throw new Error(
      `screenTileGeometry: degenerate source geometry (source ${probe.width}x${probe.height})`,
    );
  }
  const { cropW, cropH } = computeTileCrop(probe.width, probe.height, tileRatio);
  return { tileWidth, topHeight, bottomHeight, tileRatio, cropW, cropH };
}

/**
 * H3 (adversarial review): whether the screen-layout BOTTOM (speaker) tile
 * for this OUTPUT aspect ratio has any lateral room to track a face in at
 * all, given the source dimensions — the screen-layout analog of
 * `two-up.ts`'s `splitTilesAreDistinct`. When `computeTileCrop`'s crop width
 * equals the full source width, `cropXForCenter`'s clamp range collapses to
 * `[0, 0]`, so every possible face position maps to the identical `x`: a
 * sendcmd script driving it is a mathematically inert no-op that still
 * costs a script file and an extra filter stage, and (before this fix)
 * still logged `bottomTracking: "face"` even though nothing was actually
 * tracked. `applyScreenSpeakerLayout` calls this per output BEFORE deciding
 * whether to build a sendcmd script at all.
 */
export function screenBottomIsTrackable(
  aspectRatio: ClipAspectRatio,
  probe: { width: number; height: number },
): boolean {
  const { cropW } = screenTileGeometry(aspectRatio, probe);
  return cropW < probe.width;
}

/** FFmpeg instance name of the screen-layout bottom (speaker) crop filter,
 *  targeted by sendcmd. Deliberately its OWN name — never `REFRAME_CROP_NAME`
 *  (reframe.ts's single-speaker crop) or either of `two-up.ts`'s
 *  `TWO_UP_TOP_CROP_NAME`/`TWO_UP_BOTTOM_CROP_NAME`. `sendcmd` dispatches by
 *  filter NAME graph-wide, not per-branch (the same gotcha `two-up.ts`'s
 *  `buildTwoUpFilterChain` doc comment explains at length): reusing any of
 *  those names here would mean a command meant for THIS clip's screen-mode
 *  bottom tile could also silently retarget an unrelated crop instance (or
 *  vice versa) if both ever coexisted in one filter_complex. Per-output
 *  callers (render-clips.ts's `applyScreenSpeakerLayout`, mirroring
 *  `applyAutoReframe`) further suffix this per output index when rendering
 *  more than one aspect ratio, exactly like `REFRAME_CROP_NAME` does. */
export const SCREEN_BOTTOM_CROP_NAME = "crop@screen_speaker";

export interface ScreenSpeakerBottomSpec {
  /** Static normalized horizontal crop center (used unless `reframe` is
   *  set) — the static-center fallback when no face was detected/detection
   *  is unavailable. Vertical stays centered (v1: no vertical tracking, same
   *  policy as `two-up.ts`'s tiles). */
  cx: number;
  /** Sendcmd-driven horizontal crop track (reframe.ts style) — when set,
   *  overrides `cx` for x. `cropName` MUST be unique within the ffmpeg
   *  invocation this chain is embedded in — see `SCREEN_BOTTOM_CROP_NAME`'s
   *  doc comment. */
  reframe?: { scriptPath: string; cropName: string } | null;
}

export interface BuildScreenSpeakerFilterChainParams {
  aspectRatio: ClipAspectRatio;
  /** Source video dimensions (post any upstream probe/scale — same contract
   *  as `buildTwoUpFilterChain`'s `probe`). */
  probe: { width: number; height: number };
  bottom: ScreenSpeakerBottomSpec;
  videoInputLabel?: string;
  outputLabel?: string;
  /** Suffix appended to internal split/crop-output labels so multiple calls
   *  can coexist in one bigger filter_complex without label collisions
   *  (mirrors `buildTwoUpFilterChain`'s `labelSuffix`). */
  labelSuffix?: string;
  /** Appended after vstack, before the output label — same `[outvbase]`-
   *  style contract `buildFitAndBackgroundFilter`/`buildTwoUpFilterChain`
   *  satisfy. */
  trailingChain?: string;
}

/**
 * Builds the split=2 -> TOP fit-and-pad / BOTTOM face-crop -> vstack FFmpeg
 * filtergraph for the "screen" framing mode: one source split into two
 * branches, the top branch letterboxed (never cropped) into a `W x topHeight`
 * tile, the bottom branch cropped/scaled into a `W x bottomHeight` tile
 * around a (static or sendcmd-driven) speaker center (`screenTileGeometry`
 * decides `topHeight`/`bottomHeight` — NOT both `H/2`, see its doc comment),
 * then stacked top-over-bottom into the full `W x H` output — the same
 * `[outv]`/`[outvbase]`-style single output label contract
 * `buildFitAndBackgroundFilter`/`buildTwoUpFilterChain` satisfy.
 *
 * GOTCHA (two-up.ts spike, reapplied here): a differently-rounded crop/scale/
 * pad rectangle between the two branches emits a different SAR even for the
 * same nominal tile size (fit's `scale...decrease` rounds down to preserve
 * aspect; the bottom crop's `computeTileCrop` rounds a crop rect to the
 * source's own pixel grid) — `vstack`ing two branches with mismatched SAR is
 * exactly the class of bug `two-up.ts`'s split layout hit with `concat`.
 * BOTH branches pin `setsar=1` on their own output (not just once after
 * vstack) before the join, so this can never depend on which branch's
 * rounding happened to agree with the other's this time.
 */
export function buildScreenSpeakerFilterChain(
  params: BuildScreenSpeakerFilterChainParams,
): string[] {
  // H1 (adversarial review): geometry comes ONLY from the shared
  // `screenTileGeometry` — this used to re-derive tileHeight/tileRatio/cropW
  // independently of render-clips.ts's `applyScreenSpeakerLayout`, which is
  // exactly how C1's odd-tile-height bug could have been fixed here and not
  // there with no error (a mismatched `x` just clamps silently). It throws
  // on an unsupported aspect ratio or degenerate tile/source geometry, same
  // "throw, caller's try/catch logs ffmpeg_render_failed" contract
  // `buildSplitFilterChain`/`buildTwoUpFilterChain` already rely on.
  const { tileWidth, topHeight, bottomHeight, cropW, cropH } = screenTileGeometry(
    params.aspectRatio,
    params.probe,
  );

  const videoInputLabel = params.videoInputLabel ?? "[0:v]";
  const outputLabel = params.outputLabel ?? "[outv]";
  const suffix = params.labelSuffix ?? "";
  const topSrcLabel = `[screen_top_src${suffix}]`;
  const botSrcLabel = `[screen_bot_src${suffix}]`;
  const topOutLabel = `[screen_top${suffix}]`;
  const botOutLabel = `[screen_bot${suffix}]`;
  const trailing = params.trailingChain ? `,${params.trailingChain}` : "";

  // TOP: fit (scale-to-contain, force_divisible_by=2 for encodability) +
  // letterbox pad to the exact tile canvas, centered, black bars — the same
  // generic scale+pad idiom `buildFitAndBackgroundFilter`'s color branch
  // uses for the FULL output canvas, parameterized down to just this tile.
  // "force_original_aspect_ratio=decrease" is what makes this generic across
  // BOTH source orientations without any JS-side branching: a source wider
  // than the tile (the common landscape-screen-share case) becomes
  // width-constrained (scaled to tile width, padded top/bottom); a source
  // narrower than tall (portrait) becomes height-constrained (scaled to tile
  // height, padded left/right) — ffmpeg's `scale` filter resolves which
  // dimension is the binding constraint at run time from the actual input
  // dimensions, so this single filter chain covers both without a
  // srcRatio-vs-tileRatio branch the way `computeTileCrop` needs for a crop.
  const topFilter =
    `${topSrcLabel}scale=${tileWidth}:${topHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
    `pad=${tileWidth}:${topHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1${topOutLabel}`;

  // BOTTOM: tile-aspect crop of the source (`computeTileCrop`, the same
  // geometry `two-up.ts`'s tiles use), x driven by sendcmd when a face path
  // exists, else the static center fallback. L3 (adversarial review):
  // `computeTileCrop` can never return a `cropH` greater than the source
  // height, and `cropXForCenter` already clamps its result to
  // `[0, srcHeight - cropH]` (which collapses to exactly `[0, 0]` when
  // `cropH === srcHeight`) — so the old `cropH >= height ? 0 : ...` guard
  // was dead: `cropXForCenter` returns the same `0` on its own in that case.
  const y = cropXForCenter(0.5, params.probe.height, cropH);
  let botFilter: string;
  if (params.bottom.reframe) {
    const escaped = params.bottom.reframe.scriptPath.replace(/'/g, "'\\''");
    const x = Math.round((params.probe.width - cropW) / 2); // sendcmd drives x at runtime; this is just the initial value
    botFilter =
      `${botSrcLabel}sendcmd=f='${escaped}',` +
      `${params.bottom.reframe.cropName}=w=${cropW}:h=${cropH}:x=${x}:y=${y},` +
      `scale=${tileWidth}:${bottomHeight},setsar=1${botOutLabel}`;
  } else {
    const x = cropXForCenter(params.bottom.cx, params.probe.width, cropW);
    botFilter = `${botSrcLabel}crop=${cropW}:${cropH}:${x}:${y},scale=${tileWidth}:${bottomHeight},setsar=1${botOutLabel}`;
  }

  return [
    `${videoInputLabel}split=2${topSrcLabel}${botSrcLabel}`,
    topFilter,
    botFilter,
    `${topOutLabel}${botOutLabel}vstack=inputs=2,format=yuv420p,setsar=1${trailing}${outputLabel}`,
  ];
}
