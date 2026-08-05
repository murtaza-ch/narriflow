#!/usr/bin/env python3
"""
Auto-reframe face detector for Narriflow.

Samples a clip's frames at a low rate, runs the OpenCV YuNet face detector
(MIT, ~232 KB, CPU-friendly), and emits a JSON list of normalized face centers
the worker smooths into a crop path. Dominant (largest) face per frame — good
for the 1-speaker case; multi-speaker active-speaker selection is a later step.

Usage:
  python3 reframe_detect.py <video> <start_sec> <duration_sec> <fps> <model.onnx> [--multi]

Output (stdout), default mode (byte-identical to before --multi existed):
  {"width": W, "height": H, "samples": [{"t": s, "cx": 0..1|null}]}

Output (stdout), --multi mode (vizard-parity.md "Split-screen 2-up" spike):
  every sample becomes {"t": s, "faces": [{"cx","cy","w","h","score"}, ...]},
  all normalized 0..1 and source-pixel-corrected the same way the default
  mode's "cx" is, sorted by ascending cx. Empty list (not null) when no faces
  were detected in that sample.
"""
import json
import sys

# YuNet is a small CNN designed for ~320x320 inputs. Feeding it a full 1080p+
# frame is pure wasted compute — detection quality holds up fine on a
# downscaled frame (preserving aspect ratio, never upscaling), as long as the
# detected box is scaled back to source pixels before normalizing so the
# emitted cx matches what full-resolution detection would have produced.
DETECT_MAX_DIM = 320


def _compute_detect_size(width: int, height: int, max_dim: int = DETECT_MAX_DIM):
    """Returns (detect_w, detect_h, scale_x, scale_y) to downscale a
    width x height frame so its longer side is at most max_dim (never
    upscales small/vertical sources)."""
    if width <= 0 or height <= 0:
        return width, height, 1.0, 1.0
    scale = min(1.0, max_dim / max(width, height))
    detect_w = max(1, round(width * scale))
    detect_h = max(1, round(height * scale))
    return detect_w, detect_h, detect_w / width, detect_h / height


def main() -> int:
    if len(sys.argv) < 6:
        print(json.dumps({"error": "usage: reframe_detect.py video start dur fps model"}))
        return 2

    video_path = sys.argv[1]
    start = float(sys.argv[2])
    duration = float(sys.argv[3])
    fps = float(sys.argv[4]) or 4.0
    model_path = sys.argv[5]
    multi = len(sys.argv) > 6 and sys.argv[6] == "--multi"

    try:
        import cv2  # opencv-python-headless
    except Exception as exc:  # pragma: no cover - import guard
        print(json.dumps({"error": f"opencv import failed: {exc}"}))
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

    detect_w, detect_h, scale_x, scale_y = _compute_detect_size(width, height)

    try:
        detector = cv2.FaceDetectorYN.create(
            model_path, "", (max(1, detect_w), max(1, detect_h)),
            score_threshold=0.6, nms_threshold=0.3, top_k=50,
        )
    except Exception as exc:
        cap.release()
        print(json.dumps({"error": f"detector init failed: {exc}"}))
        return 5

    frame_interval = max(1, int(round(src_fps / fps)))

    # Seek once to the clip start (as before), then step through frames with
    # grab() — which decodes but skips the expensive color-convert + copy —
    # and only fully retrieve + run detection on the 1-in-`frame_interval`
    # frames we actually sample. Measured on a real 60s/1920x1080 clip against
    # a hard per-sample cv2.CAP_PROP_POS_MSEC seek (seeking to each sampled
    # timestamp directly instead): the hard seek was consistently *slower* —
    # ~1.8x on a ~8.3s-GOP encode, ~4x on a ~0.27s-GOP encode — because each
    # seek re-walks from the nearest prior keyframe (plus fixed per-call seek
    # overhead) even when the target is only a few frames away, while grab()
    # has no such cost. Combined with the downscale above, this measured
    # ~4.5x faster overall than the original full-res/decode-every-frame
    # implementation (8.37s -> 1.84s mean on that same clip), with a max
    # crop-center (cx) deviation of 0.008 against the original output.
    cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, start) * 1000.0)

    samples = []
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
                detect_w, detect_h, scale_x, scale_y = _compute_detect_size(width, height)
                detector.setInputSize((max(1, detect_w), max(1, detect_h)))

            # Downscale to the detector's intended input size before inference.
            detect_frame = (
                cv2.resize(frame, (detect_w, detect_h), interpolation=cv2.INTER_AREA)
                if (detect_w, detect_h) != (fw, fh)
                else frame
            )

            try:
                _, faces = detector.detect(detect_frame)
            except Exception:
                faces = None

            if multi:
                out_faces = []
                if faces is not None:
                    for f in faces:
                        # Scale the detected box back up to source pixels
                        # (per-axis, so rounding in the downscaled size can't
                        # skew it) before normalizing — same correction as
                        # the default-mode cx below.
                        x_src = float(f[0]) / scale_x
                        y_src = float(f[1]) / scale_y
                        w_src = float(f[2]) / scale_x
                        h_src = float(f[3]) / scale_y
                        fcx = max(0.0, min(1.0, (x_src + w_src / 2.0) / max(1, width)))
                        fcy = max(0.0, min(1.0, (y_src + h_src / 2.0) / max(1, height)))
                        out_faces.append({
                            "cx": fcx,
                            "cy": fcy,
                            "w": float(w_src) / max(1, width),
                            "h": float(h_src) / max(1, height),
                            "score": float(f[14]),
                        })
                out_faces.sort(key=lambda ff: ff["cx"])
                samples.append({"t": round(t, 3), "faces": out_faces})
            else:
                cx = None
                if faces is not None and len(faces) > 0:
                    best = max(faces, key=lambda f: float(f[2]) * float(f[3]))
                    # Scale the detected box back up to source pixels (per-axis,
                    # so rounding in the downscaled size can't skew it) before
                    # normalizing, so cx matches full-resolution detection.
                    x_src = float(best[0]) / scale_x
                    w_src = float(best[2]) / scale_x
                    center = (x_src + w_src / 2.0) / max(1, width)
                    cx = max(0.0, min(1.0, center))
                samples.append({"t": round(t, 3), "cx": cx})

        idx += 1

    cap.release()
    print(json.dumps({"width": width, "height": height, "samples": samples}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
