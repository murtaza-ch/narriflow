#!/usr/bin/env python3
"""
Facecam PiP (picture-in-picture) region detector for Narriflow's "screen"
framing mode (vizard-parity.md "Screen+speaker layout" element-segmentation
spike, 2026-08-05). Samples a clip's frames at a low rate, works on a
downscaled grayscale copy, and locates a facecam overlay by TEMPORAL MOTION
rather than face detection — a screencast's facecam is usually the only
region of the frame that's continuously moving frame-to-frame; the "screen"
content itself (slides, a static app window) is mostly still except for
occasional slide-flip-style jumps.

Spike finding: per-pixel MEDIAN ABSOLUTE frame-to-frame difference is the
right statistic here, NOT variance/std — a single large-magnitude event (a
slide flip) inflates std/variance across the WHOLE clip's window for a pixel
that is otherwise perfectly still, while the median is robust to a handful of
such outliers and only lights up on pixels that are moving on MOST frame
pairs (a talking face). Do not swap this back to std without re-validating
against the spike's fixtures — that was a measured failure, not a hypothesis.

This script does NOT decide screencast-vs-not or which candidate is the
facecam — it only reports raw signal (`movingPxFrac`) and candidate regions
(connected components of the thresholded motion map, each annotated with
whether it's corner-adjacent and how large it is). `classifyScreencast` and
`selectPipRect` (screen-layout.ts) apply the structural prior (corner-
adjacent + compact) and the classification gate on top of this — deliberately
kept out of Python so the selection policy is unit-testable pure TS, exactly
like `reframe_detect.py`'s detection/`reframe.ts`'s smoothing split.

Usage:
  python3 pip_detect.py <video> <start_sec> <duration_sec> [model_unused]

  L1 (adversarial review): the fourth argument is accepted and ignored —
  kept only so this script's CLI shape matches `reframe_detect.py`'s own
  positional layout as far as it goes. NOT identical past that: this
  script's own 4th arg lines up with `reframe_detect.py`'s FPS argument
  (`reframe_detect.py video start dur fps model` — fps is 4th, the model
  path is 5th), not `reframe_detect.py`'s model path. This script has no
  model to load (motion-only, no face detector), so whatever a caller
  passes as its own 4th arg is simply discarded either way — the point of
  matching the shape is only so a caller iterating over both scripts can
  pass the same argv without a script-specific branch, not that the 4th
  argument MEANS the same thing in both.

Output (stdout):
  {
    "movingPxFrac": 0..1 or null, // share of analyzed pixels whose median
                                // frame-to-frame diff exceeds a small fixed
                                // noise floor — the classification signal
                                // (`classifyScreencast` in screen-layout.ts).
                                // `null` iff `insufficientSamples` is true.
    "insufficientSamples": bool,  // M4/L4 (adversarial review): true when
                                // fewer than `MIN_SAMPLES` frames were
                                // actually sampled, or the samples covered
                                // less than `MIN_COVERAGE_FRAC` of the
                                // requested duration (e.g. the source ended
                                // early) — too little signal to trust
                                // `movingPxFrac` either way. Callers MUST
                                // treat this (or a null `movingPxFrac`) as
                                // "couldn't analyze," never as "measured
                                // zero motion" (0.0 is a real, meaningful
                                // value elsewhere in this contract).
    "candidates": [
      {
        "x": 0..1, "y": 0..1, "w": 0..1, "h": 0..1,  // normalized rect
        "areaFrac": 0..1,          // w * h (frame-area share)
        "fillFrac": 0..1,          // M1 (adversarial review): pixel area /
                                    // bbox area — how much of the bounding
                                    // box the actual thresholded blob fills;
                                    // a low fillFrac (e.g. an L-shaped or
                                    // sparse scatter of motion) is a much
                                    // weaker PiP signal than a dense, mostly-
                                    // filled rectangle even at the same
                                    // areaFrac (`selectPipRect` gates on it).
        "cornerAdjacent": bool,    // near a frame edge on BOTH axes AND
                                    // compact on BOTH axes — see
                                    // `CORNER_MARGIN`'s doc comment
        "medianDiffMean": float    // mean median-diff value inside the region
      }, ...
    ]
  }
  On any failure (no python deps, can't open video, etc.): {"error": "..."}
  with a non-zero exit code — same "log-and-continue to the existing path"
  contract `reframe_detect.py`'s callers already rely on.
"""
import json
import sys

# Analysis runs on a 320-wide grayscale downscale, same idiom as
# `reframe_detect.py`'s DETECT_MAX_DIM — motion mapping doesn't need full
# resolution, and normalizing coordinates in this downscaled space is
# IDENTICAL to normalizing in source-pixel space (a uniform aspect-preserving
# downscale, unlike the detector's fixed-size letterboxed input), so no
# separate scale-back step is needed the way `reframe_detect.py`'s per-axis
# scale_x/scale_y correction is.
ANALYZE_WIDTH = 320
SAMPLE_FPS = 2.0

# Fixed absolute noise floor for `movingPxFrac` (grayscale levels, 0-255
# scale) — deliberately NOT the same value as the percentile threshold below.
# A percentile-based threshold always lights up ~(100 - percentile)% of
# pixels by construction, which makes it useless for telling "this clip is
# mostly still" apart from "this clip is mostly moving": both cases produce
# the same percentile-mask area. `movingPxFrac` instead measures against a
# small ABSOLUTE floor so a mostly-still screencast (nearly every pixel's
# median diff near 0) reads near 0, while a talking-head video (most of the
# frame moving on most frame pairs) reads high. This floor itself is NOT the
# classification threshold — `classifyScreencast`'s `pipMotionThreshold()`
# (screen-layout.ts) owns that, calibrated against `movingPxFrac` values
# this floor produces; see `docs/plans/vizard-parity.md`'s landed note (H1,
# adversarial review) for the full raw-vs-proxy measurement table, and
# `apps/worker/scripts/pip_calibrate.sh` to reproduce it.
MOVING_NOISE_FLOOR = 4.0

# Percentile threshold for the CANDIDATE mask (connected components) — a
# different concern from `movingPxFrac` above. 92nd percentile matches the
# spike's own approach_b_variance.py. Clamped to a minimum absolute value so
# a near-perfectly-still clip (diff map ~0 everywhere) doesn't threshold on
# sub-pixel-noise level percentile noise.
#
# H3 (adversarial review): this floor MUST equal `MOVING_NOISE_FLOOR`, not
# some other small constant — a value below the noise floor the classifier
# itself treats as "not really moving" means the candidate mask can threshold
# on plain sensor noise on grainy/low-light footage where the 92nd percentile
# of the diff map is itself near zero, producing spurious connected
# components from noise rather than real motion. Sharing one constant also
# means a future retune of the noise floor can't silently leave this one
# behind.
CANDIDATE_PERCENTILE = 92
CANDIDATE_MIN_THRESHOLD = MOVING_NOISE_FLOOR

# Connected-component size gates (analyze-space pixel area, normalized by
# frame area) — drop single-pixel noise specks and drop blobs that cover most
# of the frame (never a compact PiP candidate; `selectPipRect`'s own
# 0.5%-15% acceptance window narrows this further, this is just cheap
# python-side pre-filtering).
MIN_COMPONENT_AREA_PX = 6
MAX_COMPONENT_AREA_FRAC = 0.6

# Margin (fraction of frame width/height) a component's bounding box must
# fall within of an edge to count as "near" that edge.
#
# M2 (adversarial review): the spike's own `approach_b_variance.py`
# `is_corner` helper this used to claim parity with ONLY checks the edge-
# margin condition below — it does NOT also require the component to be
# COMPACT on both axes, so a full-width motion strip (a ticker, a status
# bar, a horizontal wipe) that merely starts within `CORNER_MARGIN` of one
# edge and ends within `CORNER_MARGIN` of the opposite edge on the SAME axis
# satisfies "near an edge on both axes" without being anything like a
# facecam overlay. `CORNER_EXTENT_MAX_FRAC` below closes that gap: corner-
# adjacent now ALSO requires the component's own extent to stay under half
# the frame on BOTH axes, which a full-width/full-height strip can never
# satisfy. Do not describe this pair as "matches the spike" again without
# re-checking — the spike's helper was strictly weaker than what ships here.
CORNER_MARGIN = 0.15
CORNER_EXTENT_MAX_FRAC = 0.5

# M4/L4 (adversarial review): minimum sampled-frame count and minimum share
# of the REQUESTED duration those samples must actually cover before
# `movingPxFrac`/candidates are trusted at all. A short window (e.g. the
# source ends well before `start + duration`, or `duration` itself is tiny)
# produces a `movingPxFrac` computed from too few frame-to-frame pairs to
# mean anything — the old behavior of emitting `movingPxFrac: 0.0` in that
# case is actively dangerous: 0.0 reads as "definitely screencast-like" to
# `classifyScreencast`, when it actually means "couldn't tell." See
# `insufficientSamples` in the module doc comment for the output contract.
MIN_SAMPLES = 8
MIN_COVERAGE_FRAC = 0.6


def _compute_analyze_size(width: int, height: int, max_dim: int = ANALYZE_WIDTH):
    """Returns (analyze_w, analyze_h, scale) to downscale a width x height
    frame so its WIDTH is exactly max_dim (never upscales a narrower source —
    matches `reframe_detect.py`'s `_compute_detect_size` never-upscale rule,
    though this only constrains width since motion analysis has no fixed
    target shape a detector requires)."""
    if width <= 0 or height <= 0:
        return width, height, 1.0
    scale = min(1.0, max_dim / width)
    analyze_w = max(1, round(width * scale))
    analyze_h = max(1, round(height * scale))
    return analyze_w, analyze_h, scale


def main() -> int:
    if len(sys.argv) < 4:
        print(json.dumps({"error": "usage: pip_detect.py video start dur [model_unused]"}))
        return 2

    video_path = sys.argv[1]
    start = float(sys.argv[2])
    duration = float(sys.argv[3])
    # sys.argv[4], if present, is accepted and ignored (see module doc comment).

    try:
        import cv2  # opencv-python-headless
        import numpy as np
    except Exception as exc:  # pragma: no cover - import guard
        print(json.dumps({"error": f"opencv/numpy import failed: {exc}"}))
        return 3

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(json.dumps({"error": "cannot open video"}))
        return 4

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 0
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 0
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    if src_fps <= 0:
        src_fps = 30.0

    analyze_w, analyze_h, _scale = _compute_analyze_size(width, height)
    frame_interval = max(1, int(round(src_fps / SAMPLE_FPS)))

    # Same seek-once-then-grab()-through idiom as `reframe_detect.py` — grab()
    # decodes but skips the expensive color-convert + copy, so only the
    # 1-in-`frame_interval` frames actually sampled pay the full cost.
    cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, start) * 1000.0)

    # M5 (adversarial review): frames are kept as uint8 (their native
    # decode/grayscale-convert dtype), NOT upcast to float32 — a 320-wide
    # analyze frame is small, but this script (like `reframe_detect.py`)
    # already pays a SEPARATE full decode of the same segment for the
    # PiP/motion pass and another for the reframe/face-detection pass (two
    # independent `cv2.VideoCapture` reads over the same bytes) — keeping
    # each pass's own frame buffer 4x smaller (uint8 vs float32) matters more
    # than it looks given that duplication, and `cv2.absdiff` below computes
    # the frame-to-frame difference as a proper SATURATING uint8 subtraction
    # (never wraps negative like a plain `uint8 - uint8` would), so no
    # float intermediate is needed to get a correct diff map either.
    frames = []
    last_sampled_t = 0.0
    idx = 0
    while True:
        t = idx / src_fps
        if t >= duration:
            break

        is_sample = idx % frame_interval == 0
        if is_sample:
            ok, frame = cap.read()
        else:
            ok = cap.grab()
            frame = None

        if not ok:
            break

        if is_sample and frame is not None:
            fh, fw = frame.shape[:2]
            if (fw, fh) != (width, height):
                width, height = fw, fh
                analyze_w, analyze_h, _scale = _compute_analyze_size(width, height)

            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            small = (
                cv2.resize(gray, (analyze_w, analyze_h), interpolation=cv2.INTER_AREA)
                if (analyze_w, analyze_h) != (fw, fh)
                else gray
            )
            frames.append(small)
            last_sampled_t = t

        idx += 1

    cap.release()

    coverage_frac = (last_sampled_t / duration) if duration > 0 else 0.0

    if len(frames) < MIN_SAMPLES or coverage_frac < MIN_COVERAGE_FRAC:
        # M4/L4 (adversarial review): too few samples, or the samples that
        # WERE taken didn't cover enough of the requested window (source
        # ended early, a degenerate tiny `duration`, etc.) — `movingPxFrac`
        # computed from this little signal isn't trustworthy either
        # direction, so report it as unavailable (`null` + `insufficientSamples:
        # true`) rather than a numeric value a caller could mistake for a
        # real (and, worse, screencast-reading-as-zero-motion) measurement.
        print(json.dumps({"movingPxFrac": None, "insufficientSamples": True, "candidates": []}))
        return 0

    diffs = np.stack(
        [cv2.absdiff(frames[i + 1], frames[i]) for i in range(len(frames) - 1)],
        axis=0,
    )
    diff_map = np.median(diffs, axis=0)

    frame_h, frame_w = diff_map.shape
    frame_area = frame_h * frame_w
    moving_px_frac = float(np.mean(diff_map > MOVING_NOISE_FLOOR))

    percentile_threshold = max(
        float(np.percentile(diff_map, CANDIDATE_PERCENTILE)), CANDIDATE_MIN_THRESHOLD
    )
    mask = (diff_map >= percentile_threshold).astype("uint8") * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    candidates = []
    n_labels, labels, stats, _centroids = cv2.connectedComponentsWithStats(mask, connectivity=8)
    for label in range(1, n_labels):
        x, y, cw, ch, area = stats[label]
        if area < MIN_COMPONENT_AREA_PX:
            continue
        if area > MAX_COMPONENT_AREA_FRAC * frame_area:
            continue

        x_norm = x / frame_w
        y_norm = y / frame_h
        w_norm = cw / frame_w
        h_norm = ch / frame_h
        area_frac = (cw * ch) / frame_area
        # M1 (adversarial review): pixel area (the connected component's
        # actual `area`, from `connectedComponentsWithStats`) over its own
        # bounding-box area — how densely the thresholded blob fills its
        # bbox. `selectPipRect` gates on this alongside `cornerAdjacent`.
        fill_frac = (area / (cw * ch)) if (cw * ch) > 0 else 0.0

        near_x_edge = x_norm < CORNER_MARGIN or (x_norm + w_norm) > (1 - CORNER_MARGIN)
        near_y_edge = y_norm < CORNER_MARGIN or (y_norm + h_norm) > (1 - CORNER_MARGIN)
        # M2 (adversarial review): near-an-edge on both axes is necessary but
        # not sufficient — also require the component's own extent to stay
        # compact (< `CORNER_EXTENT_MAX_FRAC`) on BOTH axes, or a full-width/
        # full-height motion strip (e.g. a ticker or a horizontal wipe, which
        # can easily start within `CORNER_MARGIN` of one edge and end within
        # `CORNER_MARGIN` of the opposite edge) would otherwise pass as
        # "corner-adjacent" despite not being remotely overlay-shaped.
        compact_x = w_norm < CORNER_EXTENT_MAX_FRAC
        compact_y = h_norm < CORNER_EXTENT_MAX_FRAC
        corner_adjacent = bool(near_x_edge and near_y_edge and compact_x and compact_y)

        region_values = diff_map[labels == label]
        median_diff_mean = float(np.mean(region_values)) if region_values.size > 0 else 0.0

        candidates.append(
            {
                "x": float(x_norm),
                "y": float(y_norm),
                "w": float(w_norm),
                "h": float(h_norm),
                "areaFrac": float(area_frac),
                "fillFrac": float(fill_frac),
                "cornerAdjacent": corner_adjacent,
                "medianDiffMean": median_diff_mean,
            }
        )

    # Deterministic, smallest-first — a stable, arbitrary-but-reproducible
    # output order for the JSON blob itself. NOT a claim about selection
    # policy: `selectPipRect` (screen-layout.ts) owns candidate selection
    # (merge corner-qualifying candidates, then pick by highest
    # `medianDiffMean` with size as tiebreak — see its own doc comment), and
    # does not rely on this script's output order to do it.
    candidates.sort(key=lambda c: c["areaFrac"])

    print(
        json.dumps(
            {
                "movingPxFrac": moving_px_frac,
                "insufficientSamples": False,
                "candidates": candidates,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
