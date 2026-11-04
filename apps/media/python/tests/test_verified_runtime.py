import asyncio
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from narriflow_media import clip_preparation_runtime, process, source_runtime
from narriflow_media.process import verified_runtime_id


class Session:
    remaining_seconds = 60
    cancel_event = None
    def assert_live(self): pass


class VerifiedRuntimeTests(unittest.TestCase):
    def test_the_image_record_supplies_the_fingerprint(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'verified-runtime.json'
            path.write_text(json.dumps({'id': 'a' * 64, 'facts': {}}))
            self.assertEqual(verified_runtime_id(path), 'a' * 64)

    def test_a_host_without_a_usable_record_has_no_fingerprint(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'verified-runtime.json'
            self.assertIsNone(verified_runtime_id(path))
            path.write_text('not json')
            self.assertIsNone(verified_runtime_id(path))
            path.write_text(json.dumps({'id': 'short'}))
            self.assertIsNone(verified_runtime_id(path))

    def test_jobs_in_a_verified_image_never_start_the_environment_check(self):
        async def refuse(*_args, **_kwargs):
            raise AssertionError('environment check started')
        for module, verify in ((clip_preparation_runtime, clip_preparation_runtime.verify_prepare_runtime),
                               (source_runtime, source_runtime.verify_source_runtime)):
            with patch.object(module, 'verified_runtime_id', return_value='b' * 64), patch.object(module, 'run_owned_process_async', refuse):
                self.assertEqual(asyncio.run(verify(Session())), 'b' * 64)


if __name__ == '__main__':
    unittest.main()
