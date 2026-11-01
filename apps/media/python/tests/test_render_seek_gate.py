import unittest

from apps.media.python.gates.render_seek_matrix import validate_clock, validate_fixture_facts


class RenderSeekGateTests(unittest.TestCase):
    def test_clock_allows_small_encode_variation_but_refuses_frame_and_audio_shifts(self):
        expected = [155, 162, 169]
        validate_clock([156, 161, 170], expected, 0.205, 0.2)
        for wrong in ([162, 169, 176], [32, 39, 46], [92, 99, 106]):
            with self.subTest(wrong=wrong), self.assertRaisesRegex(AssertionError, 'frame clock shifted'):
                validate_clock(wrong, expected, 0.2, 0.2)
        with self.assertRaisesRegex(AssertionError, 'audio onset shifted'):
            validate_clock(expected, expected, 0.3, 0.2)

    def test_fixture_facts_refuse_mislabeled_moov_and_gop_variants(self):
        head = [{'type': 'moov', 'offset': 32}, {'type': 'mdat', 'offset': 4096}]
        tail = [{'type': 'mdat', 'offset': 32}, {'type': 'moov', 'offset': 4096}]
        for gop in (15, 120):
            keys = list(range(0, 240, gop))
            validate_fixture_facts(head, keys, 240, gop, 'head')
            validate_fixture_facts(tail, keys, 240, gop, 'tail')
            with self.assertRaisesRegex(AssertionError, 'moov position'):
                validate_fixture_facts(tail, keys, 240, gop, 'head')
            with self.assertRaisesRegex(AssertionError, 'GOP/keyframe'):
                validate_fixture_facts(head, keys + [69], 240, gop, 'head')
            with self.assertRaisesRegex(AssertionError, 'frame count'):
                validate_fixture_facts(head, keys, 239, gop, 'head')


if __name__ == '__main__':
    unittest.main()
