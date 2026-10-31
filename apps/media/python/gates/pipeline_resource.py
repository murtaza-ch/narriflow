"""Measure original reads across real native preparation and render operations.

Control and multipart storage ports are deterministic local fixtures. The Bun
children, media tools, model and preparation result handoff are the real native
implementations. Source construction and admission-time hashing are excluded
from scoped execution reads. This is a diagnostic, not a latency acceptance gate.
"""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from uuid import uuid4

from apps.media.python.gates.render_resource import observe
from apps.media.python.tests.test_clip_preparation_runtime import ClipPreparationRuntimeTests
from apps.media.python.tests.test_render_runtime import RenderRuntimeTests
from narriflow_media.clip_preparation_runtime import verify_prepare_runtime


async def main(duration: int, count: int, window_seconds: int, source_path: Path | None = None) -> None:
    class Verification:
        remaining_seconds = 180
        cancel_event = threading.Event()
        def assert_live(self):
            pass
    fingerprint = await verify_prepare_runtime(Verification())
    measured = {'samples': 0, 'sampleIntervalMs': 25, 'sampledPeakTreeRssBytes': 0, 'byCommand': {}}
    stop = threading.Event()
    observer = threading.Thread(target=observe, args=(stop, measured), daemon=True)
    operations = []
    started = time.monotonic()
    observer.start()
    try:
        with tempfile.TemporaryDirectory() as directory:
            piece = Path(directory) / 'piece.mp4'
            source = source_path if source_path is not None else Path(directory) / 'original.mp4'
            if source_path is None:
                subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                    'testsrc2=s=320x180:r=30:d=4', '-c:v', 'libx264', '-threads', '1',
                    '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', str(piece)], check=True, timeout=30)
                subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-stream_loop', str((duration + 3) // 4),
                    '-i', str(piece), '-f', 'lavfi', '-i', f'sine=f=330:sample_rate=48000:d={duration}',
                    '-map', '0:v:0', '-map', '1:a:0', '-t', str(duration), '-c:v', 'copy',
                    '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', '-shortest', str(source)],
                    check=True, timeout=120)
            source_bytes = source.stat().st_size
            project_id = str(uuid4())
            for index in range(count):
                start = round((duration - window_seconds) * (index + 1) / (count + 1), 3)
                window = (start, start + window_seconds)
                phase_started = time.monotonic()
                prepared = await ClipPreparationRuntimeTests().actual_operation(video=True,
                    fingerprint=fingerprint, enforce_runtime=True, source_path=source,
                    window=window, project_id=project_id, capture=True)
                rendered = await RenderRuntimeTests().actual_operation(fingerprint=fingerprint,
                    enforce_runtime=True, source_path=source, prepared_bundle=prepared,
                    resolution='1080p', aspect_ratio='ratio_9_16')
                assert prepared['starts'] == rendered['starts'] == 1
                assert rendered['detectorExecutions'] == 0
                assert rendered['outcome'] == {'status': 'completed', 'requested': 1,
                    'succeeded': 1, 'failed': 0, 'superseded': 0}
                row = {'index': index, 'window': {'startSec': window[0], 'endSec': window[1]},
                    'preparation': {key: value for key, value in prepared.items() if key not in {'preparation', 'ready'}},
                    'preparationLayout': prepared['ready']['result']['layout'], 'render': rendered,
                    'seconds': round(time.monotonic() - phase_started, 3)}
                operations.append(row)
                print(json.dumps({'message': 'native_pipeline_window', **row}), flush=True)
            prep_bytes = sum(row['preparation']['measurements']['bytesTransferred'] for row in operations)
            render_bytes = sum(row['render']['bytesTransferred'] for row in operations)
            summary = {'scope': 'real native prepare_clip then render_group; controlled control/storage ports; no DB/providers',
                'fingerprint': fingerprint, 'sourceDurationSec': prepared['preparation']['sourceProbe']['durationSec'], 'sourceByteLength': source_bytes,
                'sourceSha256': prepared['preparation']['source']['sha256'],
                'sourceConstruction': 'Externally prepared source with separately recorded provenance' if source_path is not None else 'CFR30 320x180 four-second video-only loop plus continuous 48kHz mono AAC64k sine',
                'windowDurationSec': window_seconds, 'requested': count, 'completed': len(operations),
                'target': {'resolution': '1080p', 'aspectRatio': 'ratio_9_16'},
                'aggregateOriginalSourceBytes': prep_bytes + render_bytes,
                'preparationOriginalSourceBytes': prep_bytes, 'renderOriginalSourceBytes': render_bytes,
                'sourceReadRatio': (prep_bytes + render_bytes) / source_bytes,
                'withinTwentyPercent': (prep_bytes + render_bytes) * 5 <= source_bytes,
                'seconds': round(time.monotonic() - started, 3), 'resources': measured}
            print(json.dumps({'message': 'native_pipeline_resource', **summary}), flush=True)
    finally:
        stop.set()
        observer.join(timeout=2)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--duration', type=int, default=10800)
    parser.add_argument('--count', type=int, default=12)
    parser.add_argument('--window-seconds', type=int, default=30)
    parser.add_argument('--source-path', type=Path)
    args = parser.parse_args()
    assert args.count > 0 and args.window_seconds > 0 and args.duration > args.window_seconds
    asyncio.run(main(args.duration, args.count, args.window_seconds, args.source_path))
