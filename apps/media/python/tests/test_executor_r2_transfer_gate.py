from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from gates.executor_r2_transfer import _GENERATE, run_executor_r2_transfer


class ExecutorTransferGateTests(unittest.IsolatedAsyncioTestCase):
    async def test_long_lived_credentials_are_rejected_before_any_control_request(self):
        class UnusedClient:
            def command(self, *_args, **_kwargs):
                raise AssertionError('No control request expected')
        with patch.dict(os.environ, {'R2_SECRET_ACCESS_KEY':'poisoned'}):
            with self.assertRaisesRegex(ValueError, 'gate_long_lived_credentials_forbidden'):
                await run_executor_r2_transfer({}, phase='upload', client=UnusedClient())

    async def test_expired_combined_budget_is_rejected_before_acquiring_another_owner(self):
        source = {'runId':str(uuid4()), 'object':{'key':'execution/1/source/owner/artifact', 'etag':'"source"',
            'byteLength':10*1024**3, 'sha256':'a'*64}, 'startedAtUnixMs':1000, 'combinedDeadlineUnixMs':2701000}
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, 'gate_combined_deadline_expired'):
                await run_executor_r2_transfer({}, phase='pin', client=None, source=source)

    async def test_sparse_fixture_is_generated_by_a_real_process_with_the_exact_markers_and_full_sha(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'source.bin'
            result = await asyncio.to_thread(subprocess.run, [sys.executable,'-c',_GENERATE],
                input=json.dumps({'path':str(path),'byteLength':17*1024**2}).encode(),env={},
                capture_output=True,timeout=30,check=True)
            facts=json.loads(result.stdout)
            self.assertEqual(facts['byteLength'],17*1024**2)
            actual=hashlib.sha256()
            with path.open('rb') as source:
                self.assertEqual(source.read(len(b'narriflow-executor-r2-start')),b'narriflow-executor-r2-start')
                source.seek(0)
                while block:=source.read(65536):actual.update(block)
                source.seek(-len(b'narriflow-executor-r2-end'),2)
                self.assertEqual(source.read(),b'narriflow-executor-r2-end')
            self.assertEqual(actual.hexdigest(),facts['sha256'])
            self.assertEqual(path.stat().st_mode & 0o777,0o400)


if __name__ == '__main__':
    unittest.main()
