"""Credential-free Linux resource observation at the native render entry seam.

The fixture generator hashes its local three-hour source before the operation.
Only scoped source-server reads count as execution source I/O. RSS is sampled
and summed across this process tree, so shared pages may be counted twice.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import threading
import time

from apps.media.python.tests.test_render_runtime import RenderRuntimeTests


def observe(stop: threading.Event, measured: dict) -> None:
    while not stop.wait(0.025):
        rows = {}
        for path in Path('/proc').iterdir():
            if not path.name.isdigit():
                continue
            try:
                fields = dict(line.split(':', 1) for line in (path / 'status').read_text().splitlines() if ':' in line)
                rows[int(path.name)] = (int(fields['PPid']), int(fields.get('VmRSS', '0 kB').split()[0]) * 1024,
                                        int(fields['Threads']), fields['Name'].strip())
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                continue
        owned = {os.getpid()}
        while True:
            descendants = {pid for pid, row in rows.items() if row[0] in owned}
            if descendants <= owned:
                break
            owned |= descendants
        values = [row for pid, row in rows.items() if pid in owned]
        measured['samples'] += 1
        measured['sampledPeakTreeRssBytes'] = max(measured['sampledPeakTreeRssBytes'], sum(row[1] for row in values))
        for _, rss, threads, command in values:
            peak = measured['byCommand'].setdefault(command, {'rssBytes': 0, 'threads': 0})
            peak['rssBytes'] = max(peak['rssBytes'], rss)
            peak['threads'] = max(peak['threads'], threads)


async def main() -> None:
    from narriflow_media.clip_preparation_runtime import verify_prepare_runtime
    class Verification:
        remaining_seconds = 180
        cancel_event = threading.Event()
        def assert_live(self):
            pass
    fingerprint = await verify_prepare_runtime(Verification())
    started = time.monotonic()
    measured = {'samples': 0, 'sampleIntervalMs': 25, 'sampledPeakTreeRssBytes': 0, 'byCommand': {}}
    stop = threading.Event()
    thread = threading.Thread(target=observe, args=(stop, measured), daemon=True)
    thread.start()
    try:
        result = await RenderRuntimeTests().actual_operation(fingerprint=fingerprint, enforce_runtime=True, long_source=True)
    finally:
        stop.set()
        thread.join(timeout=2)
    assert result['detectorExecutions'] == 0
    assert result['bytesTransferred'] * 5 <= result['sourceByteLength']
    print(json.dumps({'scope': 'actual native Bun/FFmpeg with controlled signed-control and conditional file-backed storage ports',
                      'fingerprint': fingerprint, 'seconds': round(time.monotonic() - started, 3),
                      'operation': result, 'resources': measured}, indent=2))


if __name__ == '__main__':
    asyncio.run(main())
