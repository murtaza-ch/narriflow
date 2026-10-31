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

from gates.executor_r2_transfer import _GENERATE, _Timings, run_executor_r2_transfer


class ExecutorTransferGateTests(unittest.IsolatedAsyncioTestCase):
    async def test_timings_are_fixed_size_numeric_aggregates_including_failure(self):
        clock = [0.0]
        timings = _Timings(lambda: clock[0])
        async def succeed():
            clock[0] += 2.5
            return 'private-grant-not-retained'
        async def fail():
            clock[0] += 0.25
            raise ValueError('private-url-not-retained')
        self.assertEqual(await timings.measure('authorize_part', succeed()), 'private-grant-not-retained')
        with self.assertRaises(ValueError):
            await timings.measure('authorize_part', fail())
        report = timings.snapshot()['authorize_part']
        self.assertEqual(report['calls'], 2)
        self.assertEqual(report['failures'], 1)
        self.assertEqual(report['sumSeconds'], 2.75)
        self.assertEqual(report['maxConcurrentCalls'], 1)
        self.assertEqual(report['unfinishedCalls'], 0)
        self.assertEqual(sum(report['histogramCounts']), 2)
        self.assertEqual(len(report['histogramCounts']), 15)
        self.assertNotIn('private', json.dumps(report))

    async def test_timings_observe_concurrent_calls_without_retaining_samples(self):
        timings, release = _Timings(), asyncio.Event()
        async def operation():
            await release.wait()
        tasks = [asyncio.create_task(timings.measure('storage_put', operation())) for _ in range(4)]
        await asyncio.sleep(0)
        self.assertEqual(timings.snapshot()['storage_put']['maxConcurrentCalls'], 4)
        release.set()
        await asyncio.gather(*tasks)
        self.assertEqual(timings.snapshot()['storage_put']['unfinishedCalls'], 0)
        self.assertEqual(timings.snapshot()['storage_put']['calls'], 4)

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
