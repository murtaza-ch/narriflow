"""Regional transfer-only gate using the deployed signed Executor protocol.

This module never publishes synthetic media evidence. Each accepted fixture
ends with an explicit permanent test failure after storage verification.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import sys
import tempfile
import time
import tracemalloc
from uuid import UUID

from narriflow_media.control import ExecutionControlError, ExecutorSession
from narriflow_media.entrypoint import invocation_reference
from narriflow_media.multipart import PART_SIZE_BYTES, SignedHttpTransport, pin_source, upload_file
from narriflow_media.native_runtime import download_assigned_source
from narriflow_media.process import run_owned_process_async
from narriflow_media.transfer import ScopedMultipartControl, TARGET, load_work_package, parse_transfer_disposition

MAX_BYTES = 10 * 1024**3
GATE_SECONDS = 2700
START = b'narriflow-executor-r2-start'
END = b'narriflow-executor-r2-end'
_SHA = re.compile(r'[a-f0-9]{64}')
_FORBIDDEN = ('DATABASE_URL', 'DIRECT_URL', 'NEON_DATABASE_URL', 'PGPASSWORD',
              'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY')
_GENERATE = r'''
import hashlib,json,os,sys
from pathlib import Path
value=json.loads(sys.stdin.buffer.read(4097));path=Path(value['path']);size=value['byteLength']
if type(size) is not int or not 16*1024**2<size<=10*1024**3 or path.exists() or path.is_symlink():raise ValueError('gate_source_invalid')
fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
try:
 os.ftruncate(fd,size);os.pwrite(fd,b'narriflow-executor-r2-start',0);os.pwrite(fd,b'narriflow-executor-r2-end',size-len(b'narriflow-executor-r2-end'))
finally:os.close(fd)
sha=hashlib.sha256()
with path.open('rb') as source:
 while block:=source.read(1024*1024):sha.update(block)
path.chmod(0o400)
print(json.dumps({'byteLength':size,'sha256':sha.hexdigest()}))
'''


def _rss_bytes():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == 'darwin' else 1024)


def _cgroup_number(name):
    try:
        value=(Path('/sys/fs/cgroup')/name).read_text().strip()
        return int(value) if value.isdecimal() else None
    except (OSError,ValueError):
        return None


def _source_receipt(value):
    if (type(value) is not dict or set(value) != {'runId', 'object', 'startedAtUnixMs', 'combinedDeadlineUnixMs'} or
            str(UUID(value['runId'])) != value['runId']):
        raise ValueError('gate_source_receipt_invalid')
    obj = value['object']
    if (type(obj) is not dict or set(obj) != {'key', 'etag', 'byteLength', 'sha256'} or
            not isinstance(obj['key'], str) or not re.fullmatch(r'execution/[A-Za-z0-9/_.-]{1,1014}', obj['key']) or
            not isinstance(obj['etag'], str) or not re.fullmatch(r'[\x21-\x7e]{1,160}', obj['etag']) or
            type(obj['byteLength']) is not int or not PART_SIZE_BYTES < obj['byteLength'] <= MAX_BYTES or
            not isinstance(obj['sha256'], str) or not _SHA.fullmatch(obj['sha256']) or
            any(type(value[name]) is not int for name in ('startedAtUnixMs', 'combinedDeadlineUnixMs')) or
            not 0 < value['combinedDeadlineUnixMs'] - value['startedAtUnixMs'] <= GATE_SECONDS*1000):
        raise ValueError('gate_source_receipt_invalid')
    return value


def _output(package, phase, size, source):
    outputs = [output for output in package.outputs if output['role'] == 'source_video']
    if len(outputs) != 1 or outputs[0]['maxBytes'] < size or 'application/octet-stream' not in outputs[0]['contentTypes']:
        raise ValueError('gate_assignment_invalid')
    output = outputs[0]
    if phase == 'upload':
        if package.function_name != 'fetch_source' or 'sourceEtag' in output or package.command.get('kind') != 'direct_source':
            raise ValueError('gate_assignment_invalid')
    else:
        expected = source['object']
        declared = package.command.get('source', {})
        sources = [item for item in package.sources if item['name'] == 'upload_source']
        if (package.function_name != 'pin_source' or package.command.get('kind') != 'upload_source' or len(sources) != 1 or
                any(declared.get(name) != expected[name] for name in ('etag', 'byteLength')) or
                declared.get('storageKey') != expected['key'] or declared.get('contentType') != 'application/octet-stream' or
                sources[0].get('storageKey') != expected['key'] or sources[0].get('etag') != expected['etag'] or
                sources[0].get('byteLength') != size or output.get('sourceEtag') != expected['etag'] or
                output.get('sourceByteLength') != size or output['maxBytes'] != size):
            raise ValueError('gate_assignment_invalid')
    return output


class _Timings:
    """Gate-only fixed-size aggregate. Never retain grants, IDs or body bytes."""
    _limits = (0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128)
    _labels = frozenset({'work_package', 'fixture_generation', 'source_prefix', 'upload_initialize',
                         'authorize_part', 'authorize_range', 'storage_get', 'storage_put', 'complete', 'abort'})

    def __init__(self, clock=time.monotonic):
        self._clock, self._values = clock, {}

    async def measure(self, label, operation):
        if label not in self._labels:
            raise ValueError('gate_timing_label_invalid')
        value = self._values.setdefault(label, {'calls': 0, 'failures': 0, 'busy': 0.0, 'max': 0.0,
                                                'active': 0, 'peak': 0, 'buckets': [0]*(len(self._limits)+1)})
        value['active'] += 1
        value['peak'] = max(value['peak'], value['active'])
        started = self._clock()
        try:
            return await operation
        except BaseException:
            value['failures'] += 1
            raise
        finally:
            elapsed = max(0.0, self._clock()-started)
            value['active'] -= 1
            value['calls'] += 1
            value['busy'] += elapsed
            value['max'] = max(value['max'], elapsed)
            bucket = next((index for index, limit in enumerate(self._limits) if elapsed <= limit), len(self._limits))
            value['buckets'][bucket] += 1

    def snapshot(self):
        return {label: {'calls': value['calls'], 'failures': value['failures'],
                        'sumSeconds': round(value['busy'], 6), 'maxSeconds': round(value['max'], 6),
                        'meanSeconds': round(value['busy']/value['calls'], 6) if value['calls'] else None,
                        'maxConcurrentCalls': value['peak'], 'unfinishedCalls': value['active'],
                        'histogramUpperSeconds': [*self._limits, None], 'histogramCounts': list(value['buckets'])}
                for label, value in self._values.items()}


class _MeasuredTransport:
    def __init__(self, timings=None):
        self.timings = timings or _Timings()
        self.native = SignedHttpTransport(timeout_seconds=60)
        self.uploaded = self.downloaded = self.puts = self.gets = 0
        self.peak_rss = _rss_bytes()

    async def request(self, grant, method, body, headers, maximum, cancelled):
        response = await self.timings.measure('storage_get' if method == 'GET' else 'storage_put',
            self.native.request(grant, method, body, headers, maximum, cancelled))
        if method == 'PUT' and response.status == 200:
            self.uploaded += len(body)
            self.puts += 1
        if method == 'GET' and response.status == 206:
            self.downloaded += len(response.body)
            self.gets += 1
        self.peak_rss = max(self.peak_rss, _rss_bytes())
        return response


class _RecordedControl:
    def __init__(self, actual, timings=None):
        self.actual = actual
        self.timings = timings or _Timings()
        self.last = None

    async def authorize_part(self, number, size, sha, md5):
        grant = await self.timings.measure('authorize_part', self.actual.authorize_part(number, size, sha, md5))
        self.last = (number, size, sha, md5, grant)
        return grant

    async def authorize_source_range(self, start, end, etag):
        return await self.timings.measure('authorize_range', self.actual.authorize_source_range(start, end, etag))

    async def complete(self, parts, sha):
        return await self.timings.measure('complete', self.actual.complete(parts, sha))

    async def abort(self, reason):
        return await self.timings.measure('abort', self.actual.abort(reason))


async def run_executor_r2_transfer(invocation, *, phase, client, source=None, byte_length=MAX_BYTES):
    """Called only by a private Modal gate Function with executor-control Secret.

    ``source`` comes from the preceding upload report. It only checks the pin
    package already selected by the API, and never grants a caller-chosen key.
    """
    if any(os.environ.get(name) for name in _FORBIDDEN):
        raise ValueError('gate_long_lived_credentials_forbidden')
    if phase not in {'upload', 'pin'} or type(byte_length) is not int or not PART_SIZE_BYTES < byte_length <= MAX_BYTES:
        raise ValueError('gate_configuration_invalid')
    if phase == 'pin':
        source = _source_receipt(source)
        if byte_length != source['object']['byteLength'] or source['combinedDeadlineUnixMs'] <= int(time.time()*1000)+60000:
            raise ValueError('gate_combined_deadline_expired')
    elif source is not None:
        raise ValueError('gate_configuration_invalid')
    function = 'fetch_source' if phase == 'upload' else 'pin_source'
    value = invocation_reference(invocation, function)
    session = await asyncio.to_thread(ExecutorSession.acquire, client, reference=value['reference'],
                                      attempt_token=value['attemptToken'], max_operation_seconds=GATE_SECONDS)
    started, mono = int(time.time()*1000), time.monotonic()
    cutoff = min(started+int(session.remaining_seconds*1000), source['combinedDeadlineUnixMs'] if source else started+GATE_SECONDS*1000)
    report = {'version':1, 'phase':phase, 'status':'failed', 'scope':'actual deployed Core authority and transfer only; no synthetic media commit',
              'runId':source['runId'] if source else str(UUID(value['attemptToken'])),
              'startedAtUnixMs':source['startedAtUnixMs'] if source else started, 'combinedDeadlineUnixMs':cutoff,
              'phaseStartedAtUnixMs':started, 'operationDeadlineSeconds':GATE_SECONDS, 'requestedBytes':byte_length,
              'qualifies10GiBUpload':phase == 'upload' and byte_length == MAX_BYTES,
              'qualifiesGreaterThan5GiBPin':phase == 'pin' and byte_length > 5*1024**3, 'stage':'work_package'}
    control = None
    timings = _Timings()
    tracing = not tracemalloc.is_tracing()
    if tracing:
        tracemalloc.start()
    try:
        # Keep time for the terminal command and its fresh authority checks.
        async with asyncio.timeout((cutoff-int(time.time()*1000))/1000-60):
            package = await timings.measure('work_package', load_work_package(session))
            output = _output(package, phase, byte_length, source)
            report['artifactId'] = output['artifactId']
            transport = _MeasuredTransport(timings)
            with tempfile.TemporaryDirectory(prefix='narriflow-executor-r2-gate-') as directory:
                work = Path(directory)
                if phase == 'upload':
                    report['stage'] = 'synthetic_file'
                    path = work/'synthetic-source.bin'
                    result = await timings.measure('fixture_generation', run_owned_process_async([sys.executable, '-c', _GENERATE],
                        input_bytes=json.dumps({'path':str(path), 'byteLength':byte_length}).encode(),
                        timeout_seconds=min(300, session.remaining_seconds), env={},
                        on_start=session.on_process_start, cancel_event=session.cancel_event, max_file_bytes=byte_length))
                    measured = json.loads(result.stdout)
                    if result.returncode or measured['byteLength'] != byte_length or not _SHA.fullmatch(measured['sha256']):
                        raise ValueError('gate_fixture_generation_failed')
                    expected_sha = measured['sha256']
                    report['allocatedFixtureBytes'] = path.stat().st_blocks*512
                    actual = await timings.measure('upload_initialize', ScopedMultipartControl.initialize(session, artifact_id=output['artifactId'],
                        byte_length=byte_length, content_type='application/octet-stream'))
                    control = _RecordedControl(actual, timings)
                    report['stage'] = 'upload'
                    completed = await upload_file(path, actual.destination, control=control, transport=transport,
                        assert_owned=session.assert_live, cancel_event=session.cancel_event, expected_sha256=expected_sha)
                else:
                    report['stage'] = 'conditional_prefix'
                    # The real signed prefix GET starts the real curl process
                    # and renewal before the long conditional range transfer.
                    await timings.measure('source_prefix', download_assigned_source(session, package, work, source_name='upload_source',
                        maximum_bytes=PART_SIZE_BYTES, range_end=PART_SIZE_BYTES))
                    expected_sha = source['object']['sha256']
                    actual = await timings.measure('upload_initialize', ScopedMultipartControl.initialize(session, artifact_id=output['artifactId'],
                        byte_length=byte_length, content_type='application/octet-stream', source_etag=source['object']['etag']))
                    control = _RecordedControl(actual, timings)
                    report['stage'] = 'conditional_pin'
                    completed = await pin_source(actual.destination, source_etag=source['object']['etag'], control=control,
                        transport=transport, assert_owned=session.assert_live, cancel_event=session.cancel_event, expected_sha256=expected_sha)
                if (completed.byte_length != byte_length or completed.sha256 != expected_sha or transport.uploaded < byte_length or
                        phase == 'pin' and transport.downloaded < byte_length):
                    raise ValueError('gate_byte_or_hash_mismatch')
                report['object'] = {'key':completed.key, 'etag':completed.etag, 'byteLength':completed.byte_length, 'sha256':completed.sha256}
                report['stage'] = 'completed_mpu_replay'
                # Recreate the last synthetic part after transfer has freed its
                # four buffers. This holds no fifth buffer during the transfer.
                number, size, sha, md5, grant = control.last
                block = bytearray(size)
                if (number-1)*PART_SIZE_BYTES == 0:
                    block[:len(START)] = START
                if (number-1)*PART_SIZE_BYTES+size == byte_length:
                    block[-len(END):] = END
                if (base64.b64encode(hashlib.sha256(block).digest()).decode() != sha or
                        base64.b64encode(hashlib.md5(block,usedforsecurity=False).digest()).decode() != md5):
                    raise ValueError('gate_synthetic_part_changed')
                replay = await transport.native.request(grant, 'PUT', block, {'Content-Length':str(size), 'Content-MD5':md5},
                    65536, session.cancel_event.is_set)
                del block
                if replay.status != 404:
                    raise ValueError('gate_completed_mpu_still_writable')
                report.update(uploadedBytes=transport.uploaded, downloadedBytes=transport.downloaded,
                    putRequests=transport.puts, conditionalRangeRequests=transport.gets,
                    peakRssBytes=max(transport.peak_rss,_rss_bytes()), stalePartStatus=replay.status)
                report['stage'] = 'terminal_fence'
                terminal = await asyncio.to_thread(session.command, 'fail', failureCode='transfer_gate_complete', retryable=False)
                if terminal.disposition.get('disposition') != 'failed':
                    raise ValueError('gate_terminal_fence_unconfirmed')
                # Session correctly refuses locally after terminal. This fixed
                # signed HTTP probe also proves the deployed API refuses it.
                try:
                    await asyncio.to_thread(client._post, TARGET, {'action':'upload-parts', 'fence':session.fence,
                        'artifactId':output['artifactId'], 'parts':[{'partNumber':number, 'byteLength':size,
                            'checksumSha256':sha, 'checksumMd5':md5}]}, parse_transfer_disposition,
                        deadline_monotonic=time.monotonic()+30)
                except ExecutionControlError as error:
                    if error.status not in {403, 409, 410}:
                        raise
                    report['revokedGrantStatus'] = error.status
                else:
                    raise ValueError('gate_terminal_owner_granted_parts')
                report['status'] = 'passed'
    except BaseException as error:
        code = getattr(error, 'code', '')
        if isinstance(error,ValueError) and re.fullmatch(r'gate_[a-z_]+',str(error)):
            code=str(error)
        report['failureCode'] = code if isinstance(code,str) and re.fullmatch(r'[a-z][a-z0-9_]{0,99}',code) else type(error).__name__
        try:
            await asyncio.to_thread(session.command, 'fail', failureCode='transfer_gate_failed', retryable=False)
        except BaseException:
            report['terminalAcknowledgementUnconfirmed'] = True
    finally:
        report['timings'] = timings.snapshot()
        report['timingScope'] = 'Outer native calls including control retries; stage sums overlap under concurrency. No per-SQL, per-retry, renewal, DNS or TLS phase measurement.'
        report['elapsedSeconds'] = round(time.monotonic()-mono,3)
        report['combinedElapsedSeconds'] = round((int(time.time()*1000)-report['startedAtUnixMs'])/1000,3)
        report['peakRssBytes'] = max(report.get('peakRssBytes',0), _rss_bytes())
        report['containerLifetimePeakBytes'] = _cgroup_number('memory.peak')
        report['containerMemoryLimitBytes'] = _cgroup_number('memory.max')
        if tracing:
            report['tracedPeakBytes'] = tracemalloc.get_traced_memory()[1]
            tracemalloc.stop()
        if report['combinedElapsedSeconds'] > GATE_SECONDS:
            report.update(status='failed', failureCode='gate_combined_deadline_exceeded')
        await asyncio.to_thread(session.close)
    return report
