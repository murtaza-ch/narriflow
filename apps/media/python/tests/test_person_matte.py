from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

from narriflow_media.person_matte import (
    MatteRange,
    TimeRange,
    clamp_ranges,
    clamp_region,
    is_full_frame,
    main,
    matte_size,
    output_frame_count,
    parse_spec,
    tile_offsets,
)

HAS_NUMPY_CV2 = all(importlib.util.find_spec(name) for name in ("numpy", "cv2"))
HAS_LITERT = importlib.util.find_spec("ai_edge_litert") is not None
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
MODEL = os.environ.get("PERSON_MATTE_MODEL_PATH", os.path.join(REPO, "apps/media/models/selfie_segmenter.tflite"))
FULL = ((0.0, 0.0, 64.0, 36.0),)


class RangeTests(unittest.TestCase):
    def test_ranges_are_clamped_to_the_window_sorted_and_empties_dropped(self):
        ranges = [MatteRange(8.0, 9.0, FULL), MatteRange(-1.0, 2.0, FULL), MatteRange(11.0, 14.0, FULL), MatteRange(20.0, 25.0, FULL)]
        self.assertEqual(
            [(r.start, r.end) for r in clamp_ranges(ranges, TimeRange(0.0, 12.0))],
            [(0.0, 2.0), (8.0, 9.0), (11.0, 12.0)],
        )

    def test_touching_ranges_stay_separate_so_smoothing_restarts_at_a_cut(self):
        ranges = [MatteRange(1.0, 2.0, FULL), MatteRange(2.0, 3.0, FULL)]
        self.assertEqual(len(clamp_ranges(ranges, TimeRange(0.0, 5.0))), 2)

    def test_overlapping_or_non_finite_ranges_are_refused(self):
        with self.assertRaises(ValueError):
            clamp_ranges([MatteRange(1.0, 3.0, FULL), MatteRange(2.0, 4.0, FULL)], TimeRange(0.0, 5.0))
        with self.assertRaises(ValueError):
            clamp_ranges([MatteRange(0.0, float("inf"), FULL)], TimeRange(0.0, 5.0))

    def test_frame_count_covers_the_range_on_the_sample_grid(self):
        self.assertEqual(output_frame_count(TimeRange(0.0, 2.0), 15), 30)
        self.assertEqual(output_frame_count(TimeRange(1.0, 1.01), 15), 1)
        self.assertEqual(output_frame_count(TimeRange(0.0, 2.05), 15), 31)

    def test_spec_parses_into_typed_ranges_with_regions(self):
        parsed = parse_spec({"source": "s.mp4", "output": "m.mkv", "window": [10, 40], "size": [1920, 1080],
                             "ranges": [{"start": 12, "end": 14.5, "regions": [[656, 0, 608, 1080], [0, 0, 960, 1080]]}]})
        self.assertEqual(parsed["window"], TimeRange(10.0, 40.0))
        self.assertEqual(parsed["size"], (1920, 1080))
        self.assertEqual(parsed["ranges"][0].regions, ((656.0, 0.0, 608.0, 1080.0), (0.0, 0.0, 960.0, 1080.0)))

    def test_malformed_spec_is_a_usage_error(self):
        with self.assertRaises(ValueError):
            parse_spec({"source": "s", "output": "o", "window": [0, 1], "size": [10, 10], "ranges": [{"start": 0, "end": 1, "regions": [[0, 0, 0, 5]]}]})


class GeometryTests(unittest.TestCase):
    def test_landscape_work_frame_takes_three_overlapping_square_tiles(self):
        self.assertEqual(tile_offsets(455, 256), [0, 100, 199])

    def test_portrait_and_square_frames(self):
        self.assertEqual(tile_offsets(256, 455), [0, 100, 199])
        self.assertEqual(tile_offsets(256, 256), [0])

    def test_matte_is_at_most_540_tall_with_even_size(self):
        self.assertEqual(matte_size(1920, 1080, 540), (960, 540))
        self.assertEqual(matte_size(1920, 960, 540), (1080, 540))
        self.assertEqual(matte_size(1280, 720, 540), (960, 540))
        self.assertEqual(matte_size(640, 360, 540), (640, 360))
        self.assertEqual(matte_size(641, 361, 540), (642, 362))
        self.assertEqual(matte_size(1920, 1080, None), (1920, 1080))

    def test_region_is_scaled_to_matte_pixels_and_clamped(self):
        self.assertEqual(clamp_region((770, 0, 608, 1080), (1920, 1080), (960, 540)), (385, 0, 304, 540))
        self.assertEqual(clamp_region((1800, -50, 400, 2000), (1920, 1080), (960, 540)), (900, 0, 60, 540))

    def test_a_region_covering_the_frame_uses_tiles(self):
        self.assertTrue(is_full_frame((0, 0, 960, 540), (960, 540)))
        self.assertFalse(is_full_frame((385, 0, 304, 540), (960, 540)))


@unittest.skipUnless(HAS_NUMPY_CV2, "numpy and opencv are not installed")
class MaskTests(unittest.TestCase):
    def test_smoothing_follows_a_step_at_alpha_and_resets(self):
        import numpy as np
        from narriflow_media.person_matte import TemporalSmoother

        smoother = TemporalSmoother(0.6)
        zero, one = np.zeros((2, 2), np.float32), np.ones((2, 2), np.float32)
        self.assertEqual(float(smoother.push(zero)[0, 0]), 0.0)
        self.assertAlmostEqual(float(smoother.push(one)[0, 0]), 0.6, places=6)
        self.assertAlmostEqual(float(smoother.push(one)[0, 0]), 0.84, places=6)
        smoother.reset()
        self.assertEqual(float(smoother.push(zero)[0, 0]), 0.0)

    def test_smoothing_does_not_alias_its_input(self):
        import numpy as np
        from narriflow_media.person_matte import TemporalSmoother

        smoother = TemporalSmoother(0.6)
        first = np.ones((2, 2), np.float32)
        smoother.push(first)
        smoother.push(np.zeros((2, 2), np.float32))
        self.assertEqual(float(first[0, 0]), 1.0)

    def test_edge_contrast_drops_unsure_background_and_keeps_the_person(self):
        import numpy as np
        from narriflow_media.person_matte import edge_contrast

        out = edge_contrast(np.array([0.0, 0.4, 0.6, 0.8, 1.0], np.float32))
        self.assertTrue(np.allclose(out, [0.0, 0.0, 0.5, 1.0, 1.0], atol=1e-6), out)

    def test_guided_filter_keeps_a_flat_mask_flat_and_sharpens_toward_the_guide_edge(self):
        import numpy as np
        from narriflow_media.person_matte import guided_filter

        guide = np.zeros((64, 64), np.float32)
        guide[:, 32:] = 1.0
        flat = np.full((64, 64), 0.7, np.float32)
        self.assertTrue(np.allclose(guided_filter(guide, flat, 4), 0.7, atol=1e-4))
        blurry = np.clip((np.arange(64, dtype=np.float32) - 24) / 16, 0, 1)[None].repeat(64, 0)
        sharp = guided_filter(guide, blurry, 4, eps=1e-4)
        self.assertLess(float(sharp[32, 28]), float(blurry[32, 28]))
        self.assertGreater(float(sharp[32, 35]), float(blurry[32, 35]))

    def test_two_regions_each_segmented_and_zero_outside_both(self):
        import numpy as np
        from narriflow_media.person_matte import segment_frame

        frame = np.zeros((54, 96, 3), np.uint8)
        out = segment_frame(lambda square: np.ones((256, 256), np.float32), frame, [(0, 0, 30, 54), (60, 0, 30, 54)])
        self.assertEqual(float(out[:, :30].min()), 1.0)
        self.assertEqual(float(out[:, 30:60].max()), 0.0)
        self.assertEqual(float(out[:, 60:90].min()), 1.0)
        self.assertEqual(float(out[:, 90:].max()), 0.0)


@unittest.skipUnless(HAS_NUMPY_CV2 and shutil.which("ffmpeg"), "numpy, opencv or ffmpeg is not installed")
class BuildMatteTests(unittest.TestCase):
    def test_close_ranges_share_one_decode_and_far_ranges_get_their_own(self):
        from narriflow_media.person_matte import decode_spans

        ranges = [MatteRange(1.0, 2.0, FULL), MatteRange(2.0, 3.0, FULL), MatteRange(4.0, 5.0, FULL), MatteRange(9.0, 10.0, FULL)]
        self.assertEqual([[(r.start, r.end) for r in span] for span in decode_spans(ranges)],
                         [[(1.0, 2.0), (2.0, 3.0), (4.0, 5.0)], [(9.0, 10.0)]])

    def test_the_matte_covers_the_window_black_outside_ranges_and_holds_the_last_sample(self):
        import numpy as np
        from narriflow_media.person_matte import build_matte

        width, height, fps = 64, 36, 15
        frame = np.full((height, width, 3), 128, np.uint8)
        served: list[TimeRange] = []

        def frames(r):
            served.append(r)
            # One decode for both ranges (1 s apart), one frame short of its grid, as at the end of a file.
            return iter([frame] * (output_frame_count(r, fps) - 1))

        def person(square):
            mask = np.zeros((256, 256), np.float32)
            mask[64:192, 64:192] = 1.0
            return mask

        with tempfile.TemporaryDirectory() as work:
            output = os.path.join(work, "matte.mkv")
            summary = build_matte("unused.mp4", output, TimeRange(1.0, 6.0), (width, height),
                                  [MatteRange(2.0, 3.0, FULL), MatteRange(4.0, 5.0, FULL)], fps=fps, matte_height=None,
                                  segmenter=person, frames=frames)
            raw = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", output, "-f", "rawvideo",
                                  "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout
        matte = np.frombuffer(raw, np.uint8).reshape(-1, height, width)
        self.assertEqual(served, [TimeRange(2.0, 5.0)])
        self.assertEqual((summary["startSec"], summary["endSec"], summary["frames"]), (1.0, 6.0, 75))
        self.assertEqual(summary["samples"], 29)
        self.assertEqual(len(matte), 75)
        centre = matte[:, height // 2, width // 2]
        self.assertTrue((matte[:15] < 8).all())
        self.assertTrue((centre[15:30] > 200).all(), centre[15:30])
        self.assertTrue((matte[30:45] < 8).all())
        self.assertTrue((centre[45:60] > 200).all(), centre[45:60])
        self.assertTrue((matte[60:] < 8).all())

    def test_a_failed_model_load_exits_with_the_typed_notice(self):
        with tempfile.TemporaryDirectory() as work:
            spec = os.path.join(work, "spec.json")
            with open(spec, "w", encoding="utf-8") as handle:
                json.dump({"source": os.path.join(work, "missing.mp4"), "output": os.path.join(work, "m.mkv"),
                           "window": [0, 1], "size": [64, 36], "model": os.path.join(work, "missing.tflite"),
                           "ranges": [{"start": 0, "end": 1, "regions": [[0, 0, 64, 36]]}]}, handle)
            result = subprocess.run([sys.executable, "-m", "narriflow_media.person_matte", "--spec", spec],
                                    capture_output=True, text=True, cwd=os.path.join(REPO, "apps/media/python"),
                                    env={**os.environ, "PYTHONPATH": os.path.join(REPO, "apps/media/python")})
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(json.loads(result.stdout)["error"], "caption_matte_unavailable")

    def test_main_rejects_a_malformed_spec_with_usage(self):
        with tempfile.TemporaryDirectory() as work:
            spec = os.path.join(work, "spec.json")
            with open(spec, "w", encoding="utf-8") as handle:
                handle.write("{}")
            self.assertEqual(main(["--spec", spec]), 2)


@unittest.skipUnless(HAS_NUMPY_CV2 and HAS_LITERT and shutil.which("ffmpeg") and os.path.exists(MODEL),
                     "LiteRT, the model, numpy, opencv or ffmpeg is not available")
class ModelTests(unittest.TestCase):
    def test_the_model_finds_a_person_shape_and_leaves_a_flat_frame_empty(self):
        import numpy as np
        from narriflow_media.person_matte import SelfieSegmenter

        segment = SelfieSegmenter(MODEL)
        flat = np.full((256, 256, 3), 90, np.uint8)
        self.assertLess(float(segment(flat).mean()), 0.2)


if __name__ == "__main__":
    unittest.main()
