from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import tempfile
import unittest

from narriflow_media.person_matte import (
    TimeRange,
    clamp_region,
    matte_size,
    merge_ranges,
    output_frame_count,
    tile_offsets,
)

HAS_NUMPY_CV2 = all(importlib.util.find_spec(name) for name in ("numpy", "cv2"))


class RangeTests(unittest.TestCase):
    def test_ranges_are_sorted_clamped_merged_and_empties_dropped(self):
        self.assertEqual(
            merge_ranges([(8.0, 9.0), (-1.0, 2.0), (1.5, 3.0), (3.0, 4.0), (5.0, 5.0), (11.0, 14.0)], duration=12.0),
            [TimeRange(0.0, 4.0), TimeRange(8.0, 9.0), TimeRange(11.0, 12.0)],
        )

    def test_a_range_wholly_outside_the_source_is_dropped(self):
        self.assertEqual(merge_ranges([(20.0, 25.0)], duration=12.0), [])

    def test_non_finite_ranges_are_refused(self):
        with self.assertRaises(ValueError):
            merge_ranges([(0.0, float("inf"))])

    def test_frame_count_covers_the_range_on_the_sample_grid(self):
        self.assertEqual(output_frame_count(TimeRange(0.0, 2.0), 15), 30)
        self.assertEqual(output_frame_count(TimeRange(1.0, 1.01), 15), 1)
        self.assertEqual(output_frame_count(TimeRange(0.0, 2.05), 15), 31)


class GeometryTests(unittest.TestCase):
    def test_landscape_work_frame_takes_three_overlapping_square_tiles(self):
        self.assertEqual(tile_offsets(455, 256), [0, 100, 199])

    def test_portrait_and_square_frames(self):
        self.assertEqual(tile_offsets(256, 455), [0, 100, 199])
        self.assertEqual(tile_offsets(256, 256), [0])

    def test_matte_is_at_most_540_tall_with_even_width(self):
        self.assertEqual(matte_size(1920, 1080, 540), (960, 540))
        self.assertEqual(matte_size(1920, 960, 540), (1080, 540))
        self.assertEqual(matte_size(1280, 720, 540), (960, 540))
        self.assertEqual(matte_size(640, 360, 540), (640, 360))
        self.assertEqual(matte_size(1920, 1080, None), (1920, 1080))

    def test_region_is_scaled_to_matte_pixels_and_clamped(self):
        self.assertEqual(clamp_region((770, 0, 608, 1080), (1920, 1080), (960, 540)), (385, 0, 304, 540))
        self.assertEqual(clamp_region((1800, -50, 400, 2000), (1920, 1080), (960, 540)), (900, 0, 60, 540))


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

    def test_region_mode_is_zero_outside_the_region(self):
        import numpy as np
        from narriflow_media.person_matte import segment_region

        frame = np.zeros((54, 96, 3), np.uint8)
        out = segment_region(lambda square: np.ones((256, 256), np.float32), frame, (40, 0, 30, 54))
        self.assertEqual(float(out[:, :40].max()), 0.0)
        self.assertEqual(float(out[:, 70:].max()), 0.0)
        self.assertEqual(float(out[:, 40:70].min()), 1.0)


@unittest.skipUnless(HAS_NUMPY_CV2 and shutil.which("ffmpeg"), "numpy, opencv or ffmpeg is not installed")
class BuildMatteTests(unittest.TestCase):
    def test_ranges_with_a_gap_write_black_between_them_and_hold_the_last_sample(self):
        import numpy as np
        from narriflow_media.person_matte import build_matte

        width, height, fps = 64, 36, 15
        frame = np.full((height, width, 3), 128, np.uint8)
        served: list[TimeRange] = []

        def frames(r):
            served.append(r)
            # One frame short of the grid in the second range, as at the end of a file.
            count = output_frame_count(r, fps) - (1 if len(served) == 2 else 0)
            return iter([frame] * count)

        def person(square):
            mask = np.zeros((256, 256), np.float32)
            mask[64:192, 64:192] = 1.0
            return mask

        with tempfile.TemporaryDirectory() as work:
            output = os.path.join(work, "matte.mkv")
            summary = build_matte("unused.mp4", output, [(2.0, 3.0), (4.0, 5.0)], fps=fps, matte_height=None,
                                  segmenter=person, frames=frames, size=(width, height, 10.0))
            raw = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", output, "-f", "rawvideo",
                                  "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout
        matte = np.frombuffer(raw, np.uint8).reshape(-1, height, width)
        self.assertEqual(served, [TimeRange(2.0, 3.0), TimeRange(4.0, 5.0)])
        self.assertEqual((summary["startSec"], summary["endSec"], summary["frames"]), (2.0, 5.0, 45))
        self.assertEqual(summary["samples"], 29)
        self.assertEqual(len(matte), 45)
        centre = matte[:, height // 2, width // 2]
        self.assertTrue((centre[:15] > 200).all(), centre[:15])
        self.assertTrue((matte[15:30] < 8).all())
        self.assertTrue((centre[30:] > 200).all(), centre[30:])
        self.assertLess(int(matte[0, 2, 2]), 8)


if __name__ == "__main__":
    unittest.main()
