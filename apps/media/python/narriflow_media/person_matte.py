"""Person matte for captions drawn behind the speaker (dynamic captions spec 5.12).

Runs the MediaPipe Selfie Segmenter (``selfie_segmenter.tflite``, Apache-2.0,
256x256 float16) through LiteRT (``ai-edge-litert``), or through OpenCV DNN's
TFLite importer (``--runtime opencv``), which needs no new wheel because
``opencv-python-headless`` and ``numpy`` are already pinned in the render image
but is about 5x slower per tile.

For each requested source range it samples frames at 15 fps, segments each
sample, smooths the masks over time, sharpens the edge against the frame and
feathers it, then writes a grayscale matte video at the source's aspect, at
most 540 px tall (the render scales it to the source size first). The
matte runs at 15 fps; consumers hold each matte frame until the next one
(FFmpeg's ``alphamerge``/``overlay`` frame sync already does that).

The matte video starts at the first range's start. Time between ranges is
black. The JSON summary on stdout gives ``startSec`` so a caller can place the
matte on the source clock.

Pipeline per sample:

1. Work frame: the source scaled so its short side is 256 px.
2. Square tiles: ``ceil(long / short) + 1`` overlapping full-height (or
   full-width) squares, each run through the 256x256 model and merged with
   ``max``. On 16:9 sources that is 3 tiles. One stretched pass of the whole
   16:9 frame (or the 256x144 landscape model) leaves background bleeding into
   the word above the head; tiles give the speaker about 1.8x more model pixels.
   With ``region`` (the source rectangle the layout shows, such as a 9:16
   crop) one stretched pass of that rectangle replaces the tiles: a third of
   the inference, more model pixels on the speaker, and 0 outside it.
3. Temporal smoothing, exponential with alpha 0.6 on the new mask. Reset at
   the start of each merged range.
4. Upscale to matte size, then a fast grey-guided filter against the source
   frame (coefficients at about 270 px tall, applied at full size) so the edge
   follows hair and shoulders instead of the blocky 256 px mask.
5. Edge contrast: smoothstep from 0.4 to 0.8, which removes the soft grey
   halo the background leaves around hair.
6. Feather: 1.5 px Gaussian at matte size.

Usage:
  python3 -m narriflow_media.person_matte <source> <output.mkv> --range 12.0:27.5 [--range ...]
      [--model selfie_segmenter.tflite] [--fps 15] [--no-guided] [--runtime litert|opencv]
      [--matte-height 540] [--region x:y:w:h]
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
# The matte is written at most this tall; the render scales it to the source size
# before the shared visual stack. Full 1080p costs about 4x the CPU for no visible gain.
MATTE_HEIGHT = 540


class PersonMatteUnavailable(RuntimeError):
    """The matte cannot be made (model load, decode or inference failed).

    The render maps this to the notice ``caption_matte_unavailable`` and draws
    the hero in front. A failed matte must never hide the hero.
    """


@dataclass(frozen=True)
class TimeRange:
    start: float
    end: float


def merge_ranges(ranges: Iterable[tuple[float, float]], duration: float | None = None) -> list[TimeRange]:
    """Sorted, clamped to ``[0, duration]``, overlapping or touching ranges merged, empties dropped."""
    clamped: list[TimeRange] = []
    for start, end in ranges:
        if not (math.isfinite(start) and math.isfinite(end)):
            raise ValueError("matte range must be finite")
        start = max(0.0, start)
        if duration is not None:
            end = min(end, duration)
        if end > start:
            clamped.append(TimeRange(start, end))
    clamped.sort(key=lambda r: r.start)
    merged: list[TimeRange] = []
    for current in clamped:
        if merged and current.start <= merged[-1].end:
            merged[-1] = TimeRange(merged[-1].start, max(merged[-1].end, current.end))
        else:
            merged.append(current)
    return merged


def output_frame_count(span: TimeRange, fps: int) -> int:
    """Frames of the matte video between ``span.start`` and ``span.end``."""
    return max(1, math.ceil((span.end - span.start) * fps - 1e-9))


def frame_in_ranges(index: int, origin: float, fps: int, ranges: Sequence[TimeRange]) -> int | None:
    """Index of the range output frame ``index`` (at ``origin + index / fps``) falls in, or None."""
    t = origin + index / fps
    for position, r in enumerate(ranges):
        if r.start - 1e-9 <= t < r.end - 1e-9:
            return position
    return None


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
    """The 256x256 selfie segmenter. Input RGB uint8 256x256 (stretched, not letterboxed); output person confidence 0..1.

    ``runtime="litert"`` uses ``ai-edge-litert`` (XNNPACK, about 2-3 ms a tile on an M1 Pro core).
    ``runtime="opencv"`` uses OpenCV DNN's TFLite importer (about 14 ms a tile, no new wheel).
    Both match MediaPipe's own ImageSegmenter output to within about 1% mean absolute difference.
    """

    def __init__(self, model_path: str, runtime: str = "litert", threads: int = 1):
        self.runtime = runtime
        try:
            if runtime == "litert":
                import numpy as np
                from ai_edge_litert.interpreter import Interpreter

                self._np = np
                self._interpreter = Interpreter(model_path=model_path, num_threads=threads)
                self._interpreter.allocate_tensors()
                self._input = self._interpreter.get_input_details()[0]["index"]
                self._output = self._interpreter.get_output_details()[0]["index"]
            elif runtime == "opencv":
                import cv2

                self._cv2 = cv2
                self._net = cv2.dnn.readNetFromTFLite(model_path)
            else:
                raise ValueError(f"unknown runtime {runtime}")
        except Exception as error:
            raise PersonMatteUnavailable(f"model_load_failed: {error}") from error

    def __call__(self, rgb_square):
        if self.runtime == "litert":
            np = self._np
            self._interpreter.set_tensor(self._input, (rgb_square.astype(np.float32) * (1 / 255.0))[None])
            self._interpreter.invoke()
            return self._interpreter.get_tensor(self._output)[0, :, :, 0]
        cv2 = self._cv2
        self._net.setInput(cv2.dnn.blobFromImage(rgb_square, 1 / 255.0, (MODEL_SIDE, MODEL_SIDE)))
        return self._net.forward()[0, 0]


def work_size(width: int, height: int) -> tuple[int, int]:
    """Frame size whose short side is the model side (never below 1 px)."""
    scale = MODEL_SIDE / min(width, height)
    return max(1, round(width * scale)), max(1, round(height * scale))


def segment_region(segment: Callable, bgr, region: tuple[int, int, int, int]):
    """Person confidence for one frame from a single stretched pass over ``region`` (x, y, w, h in frame px).

    Used when the layout says which part of the source is on screen (a 9:16 crop):
    one inference instead of three tiles, and more model pixels on the speaker.
    Outside the region the matte is 0.
    """
    import cv2
    import numpy as np

    x, y, w, h = region
    out = np.zeros(bgr.shape[:2], np.float32)
    rgb = cv2.cvtColor(cv2.resize(bgr[y:y + h, x:x + w], (MODEL_SIDE, MODEL_SIDE), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
    out[y:y + h, x:x + w] = cv2.resize(segment(rgb), (w, h), interpolation=cv2.INTER_LINEAR)
    return out


def clamp_region(region: tuple[float, float, float, float], source: tuple[int, int], frame: tuple[int, int]) -> tuple[int, int, int, int]:
    """A source-pixel rectangle scaled to matte pixels and clamped inside the frame."""
    (sw, sh), (fw, fh) = source, frame
    kx, ky = fw / sw, fh / sh
    x0 = min(max(0, round(region[0] * kx)), fw - 1)
    y0 = min(max(0, round(region[1] * ky)), fh - 1)
    x1 = min(fw, max(x0 + 1, round((region[0] + region[2]) * kx)))
    y1 = min(fh, max(y0 + 1, round((region[1] + region[3]) * ky)))
    return x0, y0, x1 - x0, y1 - y0


def segment_frame(segment: Callable, bgr) -> object:
    """Person confidence at work size for one BGR frame, merged over square tiles."""
    import cv2
    import numpy as np

    height, width = bgr.shape[:2]
    ww, wh = work_size(width, height)
    rgb = cv2.cvtColor(cv2.resize(bgr, (ww, wh), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
    side = min(ww, wh)
    merged = np.zeros((wh, ww), np.float32)
    for offset in tile_offsets(ww, wh):
        if ww >= wh:
            tile = rgb[:, offset:offset + side]
            out = segment(cv2.resize(tile, (MODEL_SIDE, MODEL_SIDE), interpolation=cv2.INTER_AREA))
            region = merged[:, offset:offset + side]
        else:
            tile = rgb[offset:offset + side]
            out = segment(cv2.resize(tile, (MODEL_SIDE, MODEL_SIDE), interpolation=cv2.INTER_AREA))
            region = merged[offset:offset + side]
        np.maximum(region, cv2.resize(out, (region.shape[1], region.shape[0]), interpolation=cv2.INTER_LINEAR), out=region)
    return merged


def edge_contrast(mask, low: float = EDGE_LOW, high: float = EDGE_HIGH):
    """Smoothstep from ``low`` to ``high``: narrows the soft band where the model is unsure.

    Without it the background shows through the word as a 20-30 px grey halo
    around dark or grey hair (measured on the G3 clips).
    """
    import numpy as np

    t = np.clip((mask - low) * (1.0 / (high - low)), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def finish_mask(bgr, work_mask, guided: bool = True, feather_sigma: float = FEATHER_SIGMA_PX):
    """Upscale a work-size mask to the frame, follow the frame's edges, feather; uint8 0..255."""
    import cv2
    import numpy as np

    height, width = bgr.shape[:2]
    mask = cv2.resize(work_mask, (width, height), interpolation=cv2.INTER_LINEAR)
    if guided:
        grey = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32) * (1 / 255.0)
        mask = guided_filter(grey, mask, radius=max(4, height // 120), subsample=max(1, height // 270))
    mask = edge_contrast(mask)
    if feather_sigma > 0:
        mask = cv2.GaussianBlur(mask, (0, 0), feather_sigma)
    return (np.clip(mask, 0, 1) * 255 + 0.5).astype(np.uint8)


def matte_size(width: int, height: int, matte_height: int | None) -> tuple[int, int]:
    """Matte frame size: the source scaled to at most ``matte_height`` tall, even dimensions."""
    if not matte_height or height <= matte_height:
        return width, height
    scaled_width = max(2, round(width * matte_height / height / 2) * 2)
    return scaled_width, matte_height


def probe_video(source: str) -> tuple[int, int, float | None]:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
         "-of", "json", source], capture_output=True, text=True, check=True)
    data = json.loads(result.stdout)
    stream = data["streams"][0]
    duration = data.get("format", {}).get("duration")
    return int(stream["width"]), int(stream["height"]), float(duration) if duration else None


def decode_samples(source: str, r: TimeRange, width: int, height: int, fps: int) -> Iterator:
    """BGR frames of ``source`` on the ``r.start + k / fps`` grid inside ``r``, scaled to ``width`` x ``height``."""
    import numpy as np

    frame_bytes = width * height * 3
    proc = subprocess.Popen(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-skip_loop_filter", "all", "-ss", f"{r.start:.6f}", "-i", source,
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
    if code != 0:
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
    ranges: Iterable[tuple[float, float]],
    *,
    model_path: str | None = None,
    fps: int = SAMPLE_FPS,
    guided: bool = True,
    runtime: str = "litert",
    matte_height: int | None = MATTE_HEIGHT,
    region: tuple[float, float, float, float] | None = None,
    segmenter: Callable | None = None,
    frames: Callable[[TimeRange], Iterable] | None = None,
    size: tuple[int, int, float | None] | None = None,
) -> dict:
    """Write the matte video for ``ranges`` of ``source``. ``segmenter``/``frames``/``size`` are test seams."""
    import numpy as np

    source_width, source_height, duration = size or probe_video(source)
    width, height = matte_size(source_width, source_height, matte_height)
    rect = clamp_region(region, (source_width, source_height), (width, height)) if region else None
    merged = merge_ranges(ranges, duration)
    if not merged:
        raise ValueError("no matte range inside the source")
    segment = segmenter or SelfieSegmenter(model_path or os.environ.get(MODEL_PATH_ENV, DEFAULT_MODEL_PATH), runtime)
    read = frames or (lambda r: decode_samples(source, r, width, height, fps))
    span = TimeRange(merged[0].start, merged[-1].end)
    total = output_frame_count(span, fps)
    black = np.zeros((height, width), np.uint8).tobytes()
    writer = open_matte_writer(output, width, height, fps)
    assert writer.stdin is not None
    smoother = TemporalSmoother()
    timings = {"decodeSec": 0.0, "segmentSec": 0.0, "finishSec": 0.0}
    written = samples = 0
    try:
        for r in merged:
            first = round((r.start - span.start) * fps)
            while written < first:
                writer.stdin.write(black)
                written += 1
            smoother.reset()
            count = min(output_frame_count(r, fps), total - written)
            last = black
            produced = 0
            clock = time.perf_counter()
            for bgr in read(r):
                if produced >= count:
                    break
                started = time.perf_counter()
                timings["decodeSec"] += started - clock
                try:
                    work = segment_region(segment, bgr, rect) if rect else segment_frame(segment, bgr)
                except PersonMatteUnavailable:
                    raise
                except Exception as error:
                    raise PersonMatteUnavailable(f"inference_failed: {error}") from error
                segmented = time.perf_counter()
                last = finish_mask(bgr, smoother.push(work), guided=guided).tobytes()
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
        while written < total:
            writer.stdin.write(black)
            written += 1
    finally:
        writer.stdin.close()
        code = writer.wait()
    if code != 0:
        raise PersonMatteUnavailable("encode_failed")
    return {
        "output": output, "sourceWidth": source_width, "sourceHeight": source_height,
        "width": width, "height": height, "fps": fps,
        "startSec": span.start, "endSec": span.end, "frames": written, "samples": samples,
        "ranges": [[r.start, r.end] for r in merged], "region": list(rect) if rect else None,
        **{key: round(value, 3) for key, value in timings.items()},
    }


def _parse_range(text: str) -> tuple[float, float]:
    start, _, end = text.partition(":")
    return float(start), float(end)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("source")
    parser.add_argument("output")
    parser.add_argument("--range", dest="ranges", action="append", type=_parse_range, required=True)
    parser.add_argument("--model")
    parser.add_argument("--fps", type=int, default=SAMPLE_FPS)
    parser.add_argument("--no-guided", dest="guided", action="store_false")
    parser.add_argument("--runtime", choices=["litert", "opencv"], default="litert")
    parser.add_argument("--matte-height", type=int, default=MATTE_HEIGHT, help="0 = source height")
    parser.add_argument("--region", type=lambda t: tuple(float(v) for v in t.split(":")), help="x:y:w:h in source px")
    args = parser.parse_args(argv)
    started = time.perf_counter()
    try:
        summary = build_matte(args.source, args.output, args.ranges, model_path=args.model, fps=args.fps, guided=args.guided, runtime=args.runtime,
                              matte_height=args.matte_height or None, region=args.region)
    except PersonMatteUnavailable as error:
        print(json.dumps({"error": "caption_matte_unavailable", "detail": str(error)}))
        return 3
    summary["wallSec"] = round(time.perf_counter() - started, 3)
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
