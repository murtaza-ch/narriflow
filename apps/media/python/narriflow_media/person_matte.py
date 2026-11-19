"""Person matte for captions drawn behind the speaker (dynamic captions spec 5.12).

Runs the MediaPipe Selfie Segmenter (``selfie_segmenter.tflite`` v1, square,
float16, Apache-2.0) through LiteRT (``ai-edge-litert``, render image only).
The render worker calls it with a JSON spec (``--spec``) taken from the
composition plan's ``mattes``:

    {"source": "<path or URL>", "output": "<matte.mkv>", "window": [start, end],
     "size": [width, height], "fps": 15, "model": "<path>",
     "ranges": [{"start": s, "end": e, "regions": [[x, y, w, h], ...]}, ...]}

``window`` is the clip's source window and ``size`` the source's display size;
times are source seconds and regions source pixels. The output is a grayscale
video at the source's aspect, at most 540 px tall, at ``fps``, covering the
whole window: frame ``k`` is source time ``window[0] + k / fps``, so the render
can treat it exactly like its source input. Time outside the ranges is black.

Each range is segmented on its own: temporal smoothing restarts at its start.
The plan splits ranges at scene boundaries (camera cuts) and at edits.

Pipeline per sample (15 fps, decoded by FFmpeg straight to the matte size):

1. Segment each region with one stretched 256x256 pass (MediaPipe stretches
   too) and merge the regions with ``max``; outside every region the matte is
   0. A region covering the whole frame (Fit layouts) is segmented as
   ``ceil(long / short) + 1`` overlapping square tiles instead, because one
   stretched pass of a 16:9 frame leaves the speaker too few model pixels.
2. Temporal smoothing, exponential with alpha 0.6 on the new mask.
3. A fast grey-guided filter against the frame, so the edge follows hair and
   shoulders instead of the blocky 256 px mask.
4. Edge contrast: smoothstep from 0.4 to 0.8 (removes the grey halo around
   dark hair).
5. Feather: 1.5 px Gaussian at matte size.

Any failure (model load, decode, inference, encode) raises
``PersonMatteUnavailable``; the command prints
``{"error": "caption_matte_unavailable", "detail": ...}`` and exits 3. The
render then draws those heroes in front. A failed matte never hides a hero.

Usage:
  python3 person_matte.py --spec spec.json
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import time
from collections.abc import Callable, Iterable, Iterator, Sequence
from dataclasses import dataclass

DEFAULT_MODEL_PATH = "/usr/local/share/narriflow/selfie_segmenter.tflite"
MODEL_PATH_ENV = "PERSON_MATTE_MODEL_PATH"
SAMPLE_FPS = 15
SMOOTH_ALPHA = 0.6
FEATHER_SIGMA_PX = 1.5
MODEL_SIDE = 256
GUIDED_EPS = 1e-3
EDGE_LOW = 0.4
EDGE_HIGH = 0.8
# The matte is written at most this tall; the render scales it to the size it needs.
# Full 1080p costs about 4x the CPU for no visible gain (G3 spike).
MATTE_HEIGHT = 540
# Ranges closer than this share one decode (one seek); smoothing still restarts at each range.
DECODE_GAP_SEC = 1.5
# A region covering at least this fraction of the frame on both axes is segmented with tiles.
FULL_FRAME_FRACTION = 0.99
EXIT_UNAVAILABLE = 3
HTTP_RECONNECT = ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1",
                  "-reconnect_on_http_error", "429,500,502,503,504", "-reconnect_delay_max", "10"]


class PersonMatteUnavailable(RuntimeError):
    """The matte cannot be made (model load, decode, inference or encode failed).

    The render maps this to the notice ``caption_matte_unavailable`` and draws
    the hero in front.
    """


@dataclass(frozen=True)
class TimeRange:
    start: float
    end: float


@dataclass(frozen=True)
class MatteRange:
    start: float
    end: float
    regions: tuple[tuple[float, float, float, float], ...]


def output_frame_count(span: TimeRange, fps: int) -> int:
    """Frames of the matte video between ``span.start`` and ``span.end`` on the ``1 / fps`` grid."""
    return max(1, math.ceil((span.end - span.start) * fps - 1e-9))


def clamp_ranges(ranges: Iterable[MatteRange], window: TimeRange) -> list[MatteRange]:
    """Ranges clamped to the window, empties dropped, sorted. Ranges must not overlap; touching
    ranges stay separate, because each one restarts the temporal smoothing (camera cuts)."""
    clamped: list[MatteRange] = []
    for r in ranges:
        if not (math.isfinite(r.start) and math.isfinite(r.end)):
            raise ValueError("matte range must be finite")
        if not r.regions:
            raise ValueError("matte range needs at least one region")
        start, end = max(window.start, r.start), min(window.end, r.end)
        if end > start:
            clamped.append(MatteRange(start, end, r.regions))
    clamped.sort(key=lambda r: r.start)
    for left, right in zip(clamped, clamped[1:]):
        if right.start < left.end - 1e-6:
            raise ValueError("matte ranges overlap")
    return clamped


def decode_spans(ranges: Sequence[MatteRange], gap: float = DECODE_GAP_SEC) -> list[list[MatteRange]]:
    """Consecutive ranges less than ``gap`` apart, grouped so each group is read by one decode."""
    spans: list[list[MatteRange]] = []
    for r in ranges:
        if spans and r.start - spans[-1][-1].end < gap:
            spans[-1].append(r)
        else:
            spans.append([r])
    return spans


def tile_offsets(width: int, height: int) -> list[int]:
    """Offsets along the long side of the square tiles that cover a frame."""
    long_side, short_side = max(width, height), min(width, height)
    if long_side == short_side:
        return [0]
    count = math.ceil(long_side / short_side) + 1
    return [round(i * (long_side - short_side) / (count - 1)) for i in range(count)]


class TemporalSmoother:
    """Exponential smoothing of successive masks: ``m = a * new + (1 - a) * previous``."""

    def __init__(self, alpha: float = SMOOTH_ALPHA):
        if not 0 < alpha <= 1:
            raise ValueError("alpha must be in (0, 1]")
        self.alpha = alpha
        self._state = None

    def reset(self) -> None:
        self._state = None

    def push(self, mask):
        if self._state is None or self._state.shape != mask.shape:
            self._state = mask.astype("float32", copy=True)
        else:
            self._state *= 1 - self.alpha
            self._state += self.alpha * mask
        return self._state


def guided_filter(guide, mask, radius: int, eps: float = GUIDED_EPS, subsample: int = 1):
    """Grey-guided filter (He, Sun, Tang 2010), optionally the fast form (He and Sun 2015):
    coefficients at ``1/subsample`` size, applied at full size. Inputs float32 in [0, 1]."""
    import cv2
    import numpy as np

    height, width = guide.shape[:2]
    small_guide, small_mask = guide, mask
    if subsample > 1:
        small = (max(1, width // subsample), max(1, height // subsample))
        small_guide = cv2.resize(guide, small, interpolation=cv2.INTER_AREA)
        small_mask = cv2.resize(mask, small, interpolation=cv2.INTER_AREA)
        radius = max(1, round(radius / subsample))
    size = (2 * radius + 1, 2 * radius + 1)

    def mean(x):
        return cv2.boxFilter(x, -1, size, borderType=cv2.BORDER_REFLECT)

    mean_i, mean_p = mean(small_guide), mean(small_mask)
    cov = mean(small_guide * small_mask) - mean_i * mean_p
    var = mean(small_guide * small_guide) - mean_i * mean_i
    a = cov / (var + eps)
    b = mean_p - a * mean_i
    mean_a, mean_b = mean(a), mean(b)
    if subsample > 1:
        mean_a = cv2.resize(mean_a, (width, height), interpolation=cv2.INTER_LINEAR)
        mean_b = cv2.resize(mean_b, (width, height), interpolation=cv2.INTER_LINEAR)
    return np.clip(mean_a * guide + mean_b, 0.0, 1.0)


class SelfieSegmenter:
    """The 256x256 selfie segmenter on LiteRT (XNNPACK). Input RGB uint8 256x256, stretched rather
    than letterboxed as MediaPipe does; output person confidence 0..1."""

    def __init__(self, model_path: str, threads: int = 1):
        try:
            import numpy as np
            from ai_edge_litert.interpreter import Interpreter

            self._np = np
            self._interpreter = Interpreter(model_path=model_path, num_threads=threads)
            self._interpreter.allocate_tensors()
            self._input = self._interpreter.get_input_details()[0]["index"]
            self._output = self._interpreter.get_output_details()[0]["index"]
        except Exception as error:
            raise PersonMatteUnavailable(f"model_load_failed: {error}") from error

    def __call__(self, rgb_square):
        np = self._np
        self._interpreter.set_tensor(self._input, (rgb_square.astype(np.float32) * (1 / 255.0))[None])
        self._interpreter.invoke()
        return self._interpreter.get_tensor(self._output)[0, :, :, 0]


def segment_region(segment: Callable, bgr, region: tuple[int, int, int, int]):
    """Person confidence for one frame from a single stretched pass over ``region`` (x, y, w, h in
    frame px). Outside the region the matte is 0."""
    import cv2
    import numpy as np

    x, y, w, h = region
    out = np.zeros(bgr.shape[:2], np.float32)
    rgb = cv2.cvtColor(cv2.resize(bgr[y:y + h, x:x + w], (MODEL_SIDE, MODEL_SIDE), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
    out[y:y + h, x:x + w] = cv2.resize(segment(rgb), (w, h), interpolation=cv2.INTER_LINEAR)
    return out


def segment_tiles(segment: Callable, bgr):
    """Person confidence at frame size for one BGR frame, merged over overlapping square tiles."""
    import cv2
    import numpy as np

    height, width = bgr.shape[:2]
    scale = MODEL_SIDE / min(width, height)
    ww, wh = max(1, round(width * scale)), max(1, round(height * scale))
    rgb = cv2.cvtColor(cv2.resize(bgr, (ww, wh), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
    side = min(ww, wh)
    merged = np.zeros((wh, ww), np.float32)
    for offset in tile_offsets(ww, wh):
        tile = rgb[:, offset:offset + side] if ww >= wh else rgb[offset:offset + side]
        region = merged[:, offset:offset + side] if ww >= wh else merged[offset:offset + side]
        out = segment(cv2.resize(tile, (MODEL_SIDE, MODEL_SIDE), interpolation=cv2.INTER_AREA))
        np.maximum(region, cv2.resize(out, (region.shape[1], region.shape[0]), interpolation=cv2.INTER_LINEAR), out=region)
    return cv2.resize(merged, (width, height), interpolation=cv2.INTER_LINEAR)


def clamp_region(region: tuple[float, float, float, float], source: tuple[int, int], frame: tuple[int, int]) -> tuple[int, int, int, int]:
    """A source-pixel rectangle scaled to matte pixels and clamped inside the frame."""
    (sw, sh), (fw, fh) = source, frame
    kx, ky = fw / sw, fh / sh
    x0 = min(max(0, round(region[0] * kx)), fw - 1)
    y0 = min(max(0, round(region[1] * ky)), fh - 1)
    x1 = min(fw, max(x0 + 1, round((region[0] + region[2]) * kx)))
    y1 = min(fh, max(y0 + 1, round((region[1] + region[3]) * ky)))
    return x0, y0, x1 - x0, y1 - y0


def is_full_frame(region: tuple[int, int, int, int], frame: tuple[int, int]) -> bool:
    return region[2] >= FULL_FRAME_FRACTION * frame[0] and region[3] >= FULL_FRAME_FRACTION * frame[1]


def segment_frame(segment: Callable, bgr, regions: Sequence[tuple[int, int, int, int]]):
    """Person confidence at frame size: each region segmented on its own, merged with ``max``."""
    import numpy as np

    frame = (bgr.shape[1], bgr.shape[0])
    merged = None
    for region in regions:
        out = segment_tiles(segment, bgr) if is_full_frame(region, frame) else segment_region(segment, bgr, region)
        merged = out if merged is None else np.maximum(merged, out)
    return merged


def edge_contrast(mask, low: float = EDGE_LOW, high: float = EDGE_HIGH):
    """Smoothstep from ``low`` to ``high``: narrows the soft band where the model is unsure."""
    import numpy as np

    t = np.clip((mask - low) * (1.0 / (high - low)), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def finish_mask(bgr, mask, guided: bool = True, feather_sigma: float = FEATHER_SIGMA_PX):
    """Follow the frame's edges, sharpen the unsure band, feather; uint8 0..255 at frame size."""
    import cv2
    import numpy as np

    height = bgr.shape[0]
    if guided:
        grey = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32) * (1 / 255.0)
        mask = guided_filter(grey, mask, radius=max(4, height // 120), subsample=max(1, height // 270))
    mask = edge_contrast(mask)
    if feather_sigma > 0:
        mask = cv2.GaussianBlur(mask, (0, 0), feather_sigma)
    return (np.clip(mask, 0, 1) * 255 + 0.5).astype(np.uint8)


def union_rect(rects: Sequence[tuple[int, int, int, int]]) -> tuple[int, int, int, int]:
    """The smallest rectangle holding every region."""
    x0 = min(r[0] for r in rects)
    y0 = min(r[1] for r in rects)
    x1 = max(r[0] + r[2] for r in rects)
    y1 = max(r[1] + r[3] for r in rects)
    return x0, y0, x1 - x0, y1 - y0


def finish_in(bgr, mask, area: tuple[int, int, int, int], guided: bool = True):
    """``finish_mask`` over ``area`` only (the regions' union); the matte is 0 outside it anyway."""
    import numpy as np

    x, y, w, h = area
    if (w, h) == (bgr.shape[1], bgr.shape[0]):
        return finish_mask(bgr, mask, guided=guided)
    out = np.zeros(bgr.shape[:2], np.uint8)
    out[y:y + h, x:x + w] = finish_mask(np.ascontiguousarray(bgr[y:y + h, x:x + w]), np.ascontiguousarray(mask[y:y + h, x:x + w]), guided=guided)
    return out


def matte_size(width: int, height: int, matte_height: int | None) -> tuple[int, int]:
    """Matte frame size: the source scaled to at most ``matte_height`` tall, even dimensions."""
    if not matte_height or height <= matte_height:
        return width + width % 2, height + height % 2
    scaled_width = max(2, round(width * matte_height / height / 2) * 2)
    return scaled_width, matte_height


def decode_samples(source: str, r: TimeRange, width: int, height: int, fps: int) -> Iterator:
    """BGR frames of ``source`` on the ``r.start + k / fps`` grid inside ``r``, scaled to ``width`` x ``height``."""
    import numpy as np

    frame_bytes = width * height * 3
    http = HTTP_RECONNECT if source.startswith(("http://", "https://")) else []
    proc = subprocess.Popen(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-skip_loop_filter", "all", *http, "-ss", f"{r.start:.6f}", "-i", source,
         "-t", f"{r.end - r.start:.6f}", "-map", "0:v:0", "-vf", f"fps={fps}:round=near,scale={width}:{height}:flags=area",
         "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
        stdout=subprocess.PIPE)
    assert proc.stdout is not None
    finished = False
    try:
        while True:
            chunk = proc.stdout.read(frame_bytes)
            if len(chunk) < frame_bytes:
                break
            yield np.frombuffer(chunk, np.uint8).reshape(height, width, 3)
        finished = True
    finally:
        proc.stdout.close()
        if not finished:
            proc.kill()
        code = proc.wait()
    if finished and code != 0:
        raise PersonMatteUnavailable("decode_failed")


def open_matte_writer(output: str, width: int, height: int, fps: int) -> subprocess.Popen:
    return subprocess.Popen(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray",
         "-s", f"{width}x{height}", "-r", str(fps), "-i", "-",
         "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-pix_fmt", "gray", output],
        stdin=subprocess.PIPE)


def build_matte(
    source: str,
    output: str,
    window: TimeRange,
    size: tuple[int, int],
    ranges: Iterable[MatteRange],
    *,
    model_path: str | None = None,
    fps: int = SAMPLE_FPS,
    threads: int = 1,
    guided: bool = True,
    matte_height: int | None = MATTE_HEIGHT,
    segmenter: Callable | None = None,
    frames: Callable[[TimeRange], Iterable] | None = None,
) -> dict:
    """Write the matte video for ``window`` of ``source``. ``segmenter``/``frames`` are test seams."""
    import numpy as np

    source_width, source_height = size
    width, height = matte_size(source_width, source_height, matte_height)
    planned = clamp_ranges(ranges, window)
    if not planned:
        raise ValueError("no matte range inside the window")
    segment = segmenter or SelfieSegmenter(model_path or os.environ.get(MODEL_PATH_ENV, DEFAULT_MODEL_PATH), threads)
    read = frames or (lambda r: decode_samples(source, r, width, height, fps))
    total = output_frame_count(window, fps)
    black = np.zeros((height, width), np.uint8).tobytes()
    writer = open_matte_writer(output, width, height, fps)
    assert writer.stdin is not None
    smoother = TemporalSmoother()
    timings = {"decodeSec": 0.0, "segmentSec": 0.0, "finishSec": 0.0}
    written = samples = 0
    try:
        try:
            for span in decode_spans(planned):
                # One decode per span on the span's own 1/fps grid; frames between its ranges are skipped.
                frames_in = iter(read(TimeRange(span[0].start, span[-1].end)))
                position = 0
                clock = time.perf_counter()
                for r in span:
                    first = min(total, round((r.start - window.start) * fps))
                    while written < first:
                        writer.stdin.write(black)
                        written += 1
                    smoother.reset()
                    rects = [clamp_region(region, (source_width, source_height), (width, height)) for region in r.regions]
                    area = union_rect(rects)
                    count = min(output_frame_count(TimeRange(r.start, r.end), fps), total - written)
                    skip = round((r.start - span[0].start) * fps) - position
                    for _ in range(max(0, skip)):
                        if next(frames_in, None) is None:
                            break
                        position += 1
                    last = black
                    produced = 0
                    while produced < count:
                        bgr = next(frames_in, None)
                        if bgr is None:
                            break
                        position += 1
                        started = time.perf_counter()
                        timings["decodeSec"] += started - clock
                        try:
                            work = segment_frame(segment, bgr, rects)
                        except PersonMatteUnavailable:
                            raise
                        except Exception as error:
                            raise PersonMatteUnavailable(f"inference_failed: {error}") from error
                        segmented = time.perf_counter()
                        last = finish_in(bgr, smoother.push(work), area, guided=guided).tobytes()
                        clock = time.perf_counter()
                        timings["segmentSec"] += segmented - started
                        timings["finishSec"] += clock - segmented
                        writer.stdin.write(last)
                        produced += 1
                        samples += 1
                    # Hold the last sample when the decoder returns fewer frames than the grid (end of file).
                    while produced < count:
                        writer.stdin.write(last)
                        produced += 1
                    written += produced
                close = getattr(frames_in, "close", None)
                if close:
                    close()
            while written < total:
                writer.stdin.write(black)
                written += 1
        except BrokenPipeError as error:
            raise PersonMatteUnavailable("encode_failed") from error
    finally:
        try:
            writer.stdin.close()
        except BrokenPipeError:
            pass
        code = writer.wait()
    if code != 0:
        raise PersonMatteUnavailable("encode_failed")
    if samples == 0:
        raise PersonMatteUnavailable("decode_failed: no frames")
    return {
        "output": output, "width": width, "height": height, "fps": fps,
        "startSec": window.start, "endSec": window.end, "frames": written, "samples": samples,
        "ranges": [[r.start, r.end] for r in planned],
        **{key: round(value, 3) for key, value in timings.items()},
    }


def parse_spec(spec: dict) -> dict:
    """The JSON spec as typed arguments for ``build_matte``. Raises ValueError on a malformed spec."""
    def number(value) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError("spec numbers must be finite")
        return float(value)

    window = spec["window"]
    size = spec["size"]
    ranges = [
        MatteRange(number(r["start"]), number(r["end"]), tuple(tuple(number(v) for v in region) for region in r["regions"]))
        for r in spec["ranges"]
    ]
    if any(len(region) != 4 or region[2] <= 0 or region[3] <= 0 for r in ranges for region in r.regions):
        raise ValueError("regions are [x, y, width, height] with a positive size")
    width, height = int(number(size[0])), int(number(size[1]))
    if width <= 0 or height <= 0:
        raise ValueError("size must be positive")
    return {
        "source": str(spec["source"]), "output": str(spec["output"]),
        "window": TimeRange(number(window[0]), number(window[1])), "size": (width, height), "ranges": ranges,
        "fps": int(spec.get("fps", SAMPLE_FPS)), "threads": int(spec.get("threads", 1)),
        "model_path": spec.get("model"),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("--spec", required=True, help="JSON spec file")
    args = parser.parse_args(argv)
    started = time.perf_counter()
    try:
        with open(args.spec, encoding="utf-8") as handle:
            parsed = parse_spec(json.load(handle))
    except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
        print(json.dumps({"error": "usage: invalid spec", "detail": str(error)}))
        return 2
    try:
        summary = build_matte(parsed.pop("source"), parsed.pop("output"), parsed.pop("window"), parsed.pop("size"), parsed.pop("ranges"), **parsed)
    except PersonMatteUnavailable as error:
        print(json.dumps({"error": "caption_matte_unavailable", "detail": str(error)}))
        return EXIT_UNAVAILABLE
    except ValueError as error:
        print(json.dumps({"error": "usage: invalid spec", "detail": str(error)}))
        return 2
    except Exception as error:  # noqa: BLE001 - any other failure degrades to the hero in front
        print(json.dumps({"error": "caption_matte_unavailable", "detail": f"{type(error).__name__}: {error}"}))
        return EXIT_UNAVAILABLE
    summary["wallSec"] = round(time.perf_counter() - started, 3)
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
