"""Four offline native seek cases, separate from the frozen render golden suite.

Only control/storage replies are fixtures. The renderer and conditional ranged
source server are real. --host skips pinned Linux runtime verification and must
not be reported as deployed-image qualification.
"""
from __future__ import annotations

import argparse
import array
import asyncio
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

from apps.media.python.tests.test_render_runtime import RenderRuntimeTests
from narriflow_media.clip_preparation_runtime import verify_prepare_runtime
from narriflow_media.source_server import INITIAL_CHUNK_BYTES

FPS = 30
START_FRAME = 69
START = START_FRAME / FPS
DURATION = 3
LUMA_TOLERANCE = 2
AUDIO_TOLERANCE = 1 / FPS


def run(*args: str) -> bytes:
    return subprocess.run(args, check=True, capture_output=True, timeout=30).stdout


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def atoms(path: Path) -> list[dict]:
    result = []
    with path.open('rb') as stream:
        size = path.stat().st_size
        offset = 0
        while offset < size:
            stream.seek(offset)
            header = stream.read(8)
            require(len(header) == 8, 'truncated atom header')
            length = int.from_bytes(header[:4], 'big')
            header_bytes = 8
            if length == 1:
                extended = stream.read(8)
                require(len(extended) == 8, 'truncated extended atom')
                length = int.from_bytes(extended, 'big')
                header_bytes = 16
            elif length == 0:
                length = size - offset
            require(header_bytes <= length <= size - offset, 'invalid atom extent')
            result.append({'type': header[4:8].decode('ascii'), 'offset': offset, 'bytes': length})
            offset += length
    return result


def validate_fixture_facts(atom_facts: list[dict], keyframes: list[int], frame_count: int, gop: int, placement: str) -> None:
    moov = [item['offset'] for item in atom_facts if item['type'] == 'moov']
    mdat = [item['offset'] for item in atom_facts if item['type'] == 'mdat']
    require(len(moov) == len(mdat) == 1, 'fixture must have one moov and mdat')
    require((moov[0] < mdat[0]) == (placement == 'head'), 'fixture moov position differs from declared variant')
    require(frame_count == 8 * FPS, 'fixture frame count differs')
    require(keyframes == list(range(0, frame_count, gop)), 'fixture GOP/keyframe facts differ from declared variant')
    require(START_FRAME not in keyframes, 'seek must start off a keyframe')


def fixture_facts(path: Path, gop: int, placement: str) -> dict:
    frames = json.loads(run('ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_frames',
        '-show_entries', 'frame=key_frame,best_effort_timestamp_time', '-of', 'json', str(path)))['frames']
    for index, frame in enumerate(frames):
        require(abs(float(frame['best_effort_timestamp_time']) - index / FPS) < 0.00001, 'fixture is not the declared CFR clock')
    keyframes = [index for index, frame in enumerate(frames) if frame['key_frame'] == 1]
    atom_facts = atoms(path)
    validate_fixture_facts(atom_facts, keyframes, len(frames), gop, placement)
    require(path.stat().st_size > 2 * INITIAL_CHUNK_BYTES, 'fixture must exceed initial source read-ahead')
    if placement == 'tail':
        require(next(item['offset'] for item in atom_facts if item['type'] == 'moov') > INITIAL_CHUNK_BYTES,
            'tail moov must lie beyond initial source read-ahead')
    return {'atoms': atom_facts, 'frameCount': len(frames), 'keyframeIndices': keyframes,
        'seekFrame': START_FRAME, 'precedingKeyframe': max(value for value in keyframes if value < START_FRAME),
        'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'byteLength': path.stat().st_size}


def luma(path: Path, start_frame: int) -> list[float]:
    # The central 96x96 fixture clock survives the square center crop. Sampling
    # only its middle 16x16 excludes texture, watermark, captions and borders.
    data = run('ffmpeg', '-nostdin', '-v', 'error', '-i', str(path), '-an', '-vf',
        f'select=between(n\\,{start_frame}\\,{start_frame + 2}),extractplanes=y,crop=16:16:(iw-16)/2:(ih-16)/2',
        '-frames:v', '3', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1')
    require(len(data) == 3 * 256, 'missing decoded clock frames')
    return [sum(data[index:index + 256]) / 256 for index in range(0, len(data), 256)]


def audio_clock(path: Path) -> dict:
    data = run('ffmpeg', '-nostdin', '-v', 'error', '-i', str(path), '-vn', '-ac', '1', '-ar', '48000',
        '-f', 'f32le', 'pipe:1')
    samples = array.array('f', data)
    if sys.byteorder != 'little':
        samples.byteswap()
    # Five-ms RMS blocks reject AAC pre-echo below the audible test burst.
    for offset in range(0, len(samples) - 239, 240):
        block = samples[offset:offset + 240]
        if (sum(value * value for value in block) / len(block)) ** 0.5 >= 0.02:
            return {'onset': offset / 48000, 'decodedSamples': len(samples), 'duration': len(samples) / 48000}
    raise AssertionError('decoded test burst is absent')


def validate_clock(actual_luma: list[float], expected_luma: list[float], onset: float, expected_onset: float) -> None:
    require(len(actual_luma) == len(expected_luma) == 3, 'three decoded start frames required')
    require(all(abs(actual - expected) <= LUMA_TOLERANCE for actual, expected in zip(actual_luma, expected_luma)),
        'decoded start frame clock shifted')
    require(abs(onset - expected_onset) <= AUDIO_TOLERANCE, 'decoded audio onset shifted')


def inspect_output(path: Path, reads: list[dict], expected_luma: list[float], expected_onset: float, source_size: int) -> dict:
    require(bool(reads), 'native renderer did not read the conditional source server')
    require(any(item['start'] > 0 for item in reads), 'fixture did not exercise a later conditional byte range')
    require(all(item['ifMatch'] == '"source"' and 0 <= item['start'] <= item['end'] < source_size for item in reads),
        'source read lost its exact ETag or range bound')
    decoded = run('ffmpeg', '-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode', '-i', str(path),
        '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-')
    require(not decoded, 'unexpected full-decode stdout')
    facts = json.loads(run('ffprobe', '-v', 'error', '-count_frames', '-show_streams', '-of', 'json', str(path)))
    video = next(item for item in facts['streams'] if item['codec_type'] == 'video')
    audio = next(item for item in facts['streams'] if item['codec_type'] == 'audio')
    require(video['codec_name'] == 'h264' and audio['codec_name'] == 'aac', 'unexpected output codecs')
    require((video['width'], video['height']) == (720, 720), 'output canvas differs')
    require(int(video['nb_read_frames']) == DURATION * FPS, 'decoded output frame count differs')
    require(video['avg_frame_rate'] == f'{FPS}/1', 'output frame rate differs')
    require(abs(float(video['duration']) - DURATION) < 1 / FPS, 'video duration differs')
    require(abs(float(audio['duration']) - DURATION) < 1 / FPS, 'audio duration differs')
    require(abs(float(video['start_time'])) < 1 / FPS and abs(float(audio['start_time'])) < 1 / FPS, 'output clock is not rebased')
    actual_luma, audio_facts = luma(path, 0), audio_clock(path)
    require(abs(audio_facts['duration'] - DURATION) < 1 / FPS, 'decoded audio duration differs')
    validate_clock(actual_luma, expected_luma, audio_facts['onset'], expected_onset)
    return {'fullDecode': True, 'videoFrames': int(video['nb_read_frames']), 'dimensions': [720, 720],
        'videoDuration': float(video['duration']), 'audioDuration': float(audio['duration']),
        'firstFrameLuma': actual_luma, 'expectedFrameLuma': expected_luma, 'lumaTolerance': LUMA_TOLERANCE,
        'audioOnset': audio_facts['onset'], 'decodedAudioSamples': audio_facts['decodedSamples'],
        'decodedAudioDuration': audio_facts['duration'], 'expectedAudioOnset': expected_onset, 'audioToleranceSeconds': AUDIO_TOLERANCE,
        'conditionalSourceReads': reads, 'byteLength': path.stat().st_size,
        'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def create_sources(directory: Path, gop: int) -> dict[str, Path]:
    tail = directory / f'gop-{gop}-tail.mp4'
    head = directory / f'gop-{gop}-head.mp4'
    run('ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
        "nullsrc=s=320x180:r=30:d=8,geq=lum='if(between(X,112,207)*between(Y,42,137),32+mod(N*7,180),16+mod(X*13+Y*17+N*19,220))':cb=128:cr=128", '-f', 'lavfi', '-i',
        "sine=f=1000:r=48000:d=8,volume='if(between(t,2.5,2.7),0.8,0)':eval=frame",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-threads', '1', '-pix_fmt', 'yuv420p',
        '-g', str(gop), '-keyint_min', str(gop), '-sc_threshold', '0', '-flags', '+cgop',
        '-c:a', 'aac', '-b:a', '128k', '-shortest', str(tail))
    run('ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(tail), '-map', '0', '-c', 'copy', '-movflags', '+faststart', str(head))
    return {'head': head, 'tail': tail}


async def main(host: bool) -> dict:
    class Verification:
        remaining_seconds = 60
        cancel_event = threading.Event()
        def assert_live(self):
            pass
    fingerprint = 'a' * 64 if host else await verify_prepare_runtime(Verification())
    cases = []
    document = {'version': 1, 'clipStartSec': START, 'clipEndSec': START + DURATION,
        'captionPreset': {'visible': False}, 'transcriptSlice': [], 'studioEdits': {'framing': {'mode': 'center'}},
        'brollUrl': None, 'deletedRanges': []}
    with tempfile.TemporaryDirectory() as directory:
        for gop in (15, 120):
            for placement, source in create_sources(Path(directory), gop).items():
                fixture = fixture_facts(source, gop, placement)
                expected_luma = luma(source, START_FRAME)
                expected_onset = audio_clock(source)['onset'] - START
                require(abs(expected_onset - 0.2) <= AUDIO_TOLERANCE, 'fixture burst is not at its declared source time')
                # Prove the oracle distinguishes both a one-frame slip and a
                # seek snapped to the preceding keyframe for this actual fixture.
                for wrong_frame in (START_FRAME + 1, fixture['precedingKeyframe']):
                    require(any(abs(a - b) > LUMA_TOLERANCE for a, b in zip(luma(source, wrong_frame), expected_luma)),
                        'fixture clock cannot distinguish a wrong seek')
                result = await RenderRuntimeTests().actual_operation(fingerprint=fingerprint, enforce_runtime=not host,
                    source_path=source, fixture_document=document,
                    inspect_output=lambda path, reads: inspect_output(path, reads, expected_luma, expected_onset, fixture['byteLength']))
                moov_offset = next(item['offset'] for item in fixture['atoms'] if item['type'] == 'moov')
                require(any(item['start'] <= moov_offset <= item['end'] for item in result['outputValidation']['conditionalSourceReads']),
                    'native conditional reads did not cover the actual moov index')
                cases.append({'gopFrames': gop, 'moov': placement, 'fixture': fixture, 'operation': result})
    return {'status': 'passed', 'scope': 'actual native render and conditional source server; fixture control/storage, no DB/providers',
        'pinnedRuntimeVerified': not host, 'fingerprint': fingerprint, 'seekStartSeconds': START, 'durationSeconds': DURATION,
        'ffmpegVersion': run('ffmpeg', '-version').decode().splitlines()[0],
        'bunVersion': run('bun', '--version').decode().strip(), 'pythonVersion': sys.version.split()[0], 'cases': cases}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', action='store_true', help='diagnostic only: skip pinned Linux runtime verification')
    args = parser.parse_args()
    print(json.dumps(asyncio.run(main(args.host)), indent=2))
