"""Signed executor commands and invocation-local lease ownership.

No credentials are discovered from the environment. HTTPS transport identity
never replaces the API's durable domain fence and replay receipt.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
import http.client
import json
import logging
import math
from queue import Full, Queue
import re
import socket
import ssl
from threading import Event, Lock, Thread
import time
from typing import Any, Callable, Mapping, Protocol
from urllib.parse import urlsplit
from uuid import uuid4, UUID

from .signing import COMMAND_MAX_BYTES, sign_execution_request

TARGET = '/api/execution/command'
MAX_RESPONSE_BYTES = 64 * 1024
_logger = logging.getLogger(__name__)
# One blocked sink can retain only one active and one pending sanitized
# record. Native permission, renewal and close paths never wait for a flush.
_diagnostics: Queue[str] = Queue(maxsize=1)


def _dispatch_diagnostics():
    while True:
        record = _diagnostics.get()
        try:
            _logger.warning(record)
        except Exception:
            pass
        finally:
            _diagnostics.task_done()


try:
    Thread(target=_dispatch_diagnostics, name='execution-diagnostics', daemon=True).start()
except RuntimeError:
    pass  # An unavailable diagnostic thread must not reject native work.

_CANCELLATION_ERRORS = {
    'execution_transport_unavailable': 'transport', 'execution_command_deadline': 'deadline',
    'execution_clock_changed': 'clock', 'execution_response_invalid': 'response',
    'execution_response_too_large': 'response', 'execution_command_refused': 'refused',
    'execution_authority_lost': 'authority',
}


class ExecutionControlError(RuntimeError):
    def __init__(self, code: str, status: int | None = None):
        super().__init__(code)
        self.code, self.status = code, status


@dataclass(frozen=True)
class ControlResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes = field(repr=False)


@dataclass(frozen=True)
class CommandResult:
    disposition: Mapping[str, Any] = field(repr=False)
    server_time_upper: float
    received_monotonic: float
    received_wall: float


class _PermissionEvent(Event):
    """Native owners poll this event even while no renewal request is due."""
    def __init__(self, permitted: Callable[[], bool]):
        super().__init__()
        self._permitted = permitted

    def is_set(self):
        if not super().is_set() and not self._permitted():
            self.set()
        return super().is_set()


class ControlTransport(Protocol):
    def __call__(self, origin: str, target: str, body: bytes,
                 headers: Mapping[str, str], timeout: float) -> ControlResponse: ...


def _https(origin: str, target: str, body: bytes, headers: Mapping[str, str], timeout: float):
    parsed = urlsplit(origin)
    connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443,
                                              timeout=timeout, context=ssl.create_default_context())
    active_socket = None
    def interrupt():
        sock = connection.sock or active_socket
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        connection.close()
    finished = Event()
    end_mono, end_wall = time.monotonic() + timeout, time.time() + timeout
    def monitor():
        while not finished.wait(0.05):
            if time.monotonic() >= end_mono or time.time() >= end_wall:
                interrupt()
                return
    watcher = Thread(target=monitor, daemon=True)
    watcher.start()
    try:
        connection.request('POST', target, body=body, headers=dict(headers))
        active_socket = connection.sock
        response = connection.getresponse()
        chunks, size = [], 0
        while chunk := response.read1(min(8192, MAX_RESPONSE_BYTES + 1 - size)):
            size += len(chunk)
            if size > MAX_RESPONSE_BYTES:
                raise ExecutionControlError('execution_response_too_large')
            chunks.append(chunk)
        return ControlResponse(response.status, dict(response.getheaders()), b''.join(chunks))
    finally:
        finished.set()
        connection.close()
        watcher.join(timeout=0.1)


def _instant(value: object) -> float:
    try:
        if not isinstance(value, str) or len(value) > 40 or not value.endswith('Z'):
            raise ValueError()
        result = datetime.fromisoformat(value[:-1] + '+00:00').timestamp()
        if not math.isfinite(result) or result <= 0:
            raise ValueError()
        return result
    except (ValueError, OverflowError):
        raise ExecutionControlError('execution_response_invalid') from None


def _disposition(value: object):
    if not isinstance(value, dict):
        raise ExecutionControlError('execution_response_invalid')
    kind = value.get('disposition')
    fields = {
        'acquired': {'fence', 'serverTime', 'leaseExpiresAt', 'operationDeadlineAt'},
        'already_owned': {'leaseExpiresAt'}, 'busy': {'leaseExpiresAt'}, 'renewed': {'leaseExpiresAt'},
        'started': set(), 'committed': {'artifactId'}, 'progress_recorded': set(), 'released': {'dueAt'},
        'retry_due': {'dueAt'}, 'completed': set(), 'failed': {'failureCode'}, 'cancelled': set(),
        'expired': set(), 'superseded': set(), 'publication_recorded': {'result'},
    }
    optional = {'renderGroup'} if kind == 'committed' else set()
    if not isinstance(kind, str) or kind not in fields or not fields[kind] | {'disposition'} <= set(value) <= fields[kind] | {'disposition'} | optional:
        raise ExecutionControlError('execution_response_invalid')
    if 'renderGroup' in value:
        group = value['renderGroup']
        if (not isinstance(group, dict) or set(group) != {'status', 'requested', 'succeeded', 'failed', 'superseded'} or
                group['status'] not in {'queued', 'completed', 'partial', 'failed', 'superseded'} or
                any(type(group[name]) is not int or not 0 <= group[name] <= 4 for name in ('requested', 'succeeded', 'failed', 'superseded')) or
                group['requested'] < 1):
            raise ExecutionControlError('execution_response_invalid')
        settled = group['succeeded'] + group['failed'] + group['superseded']
        consistent = (settled < group['requested'] if group['status'] == 'queued' else
            settled == group['requested'] and (
                group['superseded'] == group['requested'] if group['status'] == 'superseded' else
                group['succeeded'] > 0 and group['failed'] == 0 if group['status'] == 'completed' else
                group['succeeded'] > 0 and group['failed'] > 0 if group['status'] == 'partial' else
                group['failed'] > 0 and group['succeeded'] == 0))
        if not consistent:
            raise ExecutionControlError('execution_response_invalid')
    for name in ('serverTime', 'leaseExpiresAt', 'operationDeadlineAt', 'dueAt'):
        if name in value and value[name] is not None:
            _instant(value[name])
    if kind == 'publication_recorded':
        result = value['result']
        if not isinstance(result,dict):
            raise ExecutionControlError('execution_response_invalid')
        if result.get('kind') == 'recorded':
            if set(result) != {'kind'}:
                raise ExecutionControlError('execution_response_invalid')
        elif result.get('kind') == 'settled':
            required={'kind','outcome','attemptId','socialPostId'}
            if (not required <= set(result) <= required | {'nextActionAt','nextAttemptId','code'} or
                    result['outcome'] not in {'posted','inbox_delivered','failed','needs_attention','processing','reconciling','retry_scheduled','interrupted'}):
                raise ExecutionControlError('execution_response_invalid')
            try:
                for name in ('attemptId','socialPostId','nextAttemptId'):
                    if name in result and (not isinstance(result[name],str) or str(UUID(result[name])) != result[name]):raise ValueError()
            except ValueError:
                raise ExecutionControlError('execution_response_invalid') from None
            if 'nextActionAt' in result:_instant(result['nextActionAt'])
            if 'code' in result and (not isinstance(result['code'],str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,99}',result['code'])):
                raise ExecutionControlError('execution_response_invalid')
        else:
            raise ExecutionControlError('execution_response_invalid')
    if kind == 'acquired':
        if (not isinstance(value['fence'], dict) or _instant(value['leaseExpiresAt']) <= _instant(value['serverTime'])
                or _instant(value['leaseExpiresAt']) > _instant(value['operationDeadlineAt'])):
            raise ExecutionControlError('execution_response_invalid')
    return value


class ExecutionControlClient:
    def __init__(self, *, origin: str, key_id: str, key: bytes,
                 transport: ControlTransport = _https, clock: Callable[[], float] = time.time,
                 timeout_seconds: float = 10, max_attempts: int = 3, retry_delay_seconds: float = 0.25,
                 device_session_token: str | None = None):
        try:
            parsed = urlsplit(origin)
            if (parsed.scheme != 'https' or not parsed.hostname or parsed.path not in {'', '/'} or parsed.query
                    or parsed.fragment or parsed.username is not None or parsed.password is not None
                    or parsed.port is not None and not 0 < parsed.port <= 65535
                    or any(ord(char) <= 32 for char in origin)):
                raise ValueError()
            if not isinstance(key_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', key_id):
                raise ValueError()
            if not isinstance(key, bytes) or not 32 <= len(key) <= 64:
                raise ValueError()
            if device_session_token is not None and (not isinstance(device_session_token, str) or not 1 <= len(device_session_token) <= 2048
                    or not re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', device_session_token)):
                raise ValueError()
            if not 0 < timeout_seconds <= 10 or type(max_attempts) is not int or not 1 <= max_attempts <= 3 or not 0 <= retry_delay_seconds <= 1:
                raise ValueError()
        except (ValueError, TypeError):
            raise ExecutionControlError('execution_client_invalid') from None
        self._origin, self._key_id, self._key = origin.rstrip('/'), key_id, key
        self._transport, self._clock = transport, clock
        self._timeout, self._attempts, self._delay = timeout_seconds, max_attempts, retry_delay_seconds
        self._device_session_token = device_session_token

    def command(self, command: Mapping[str, Any], *, deadline_monotonic: float | None = None) -> CommandResult:
        return self._post(TARGET, command, _disposition, deadline_monotonic=deadline_monotonic)

    def _post(self, target: str, command: Mapping[str, Any], parse: Callable[[object], Mapping[str, Any]],
              *, deadline_monotonic: float | None = None) -> CommandResult:
        if self._device_session_token is not None:
            if target not in {'/api/execution/command', '/api/execution/transfer'}:
                raise ExecutionControlError('execution_client_invalid')
            target = target.replace('/api/execution/', '/api/dev-device/execution/')
        try:
            body = json.dumps(command, separators=(',', ':'), sort_keys=True, allow_nan=False).encode()
            if len(body) > COMMAND_MAX_BYTES:
                raise ValueError()
        except (ValueError, TypeError, UnicodeError):
            raise ExecutionControlError('execution_command_invalid') from None
        signature = sign_execution_request(key_id=self._key_id, key=self._key, audience='dev-device' if self._device_session_token else 'executor-control',
                                           method='POST', target=target, body=body,
                                           timestamp=int(self._clock()), delivery_id=str(uuid4()))
        headers = {'Content-Type': 'application/json', 'Accept': 'application/json', 'Cache-Control': 'no-store',
                   'X-Execution-Signature': json.dumps(signature, separators=(',', ':'))}
        if self._device_session_token is not None:
            headers['X-Local-Fetch-Session'] = self._device_session_token
        # A delivery's exact bytes, signature timestamp and ID never change on
        # a transport retry. The whole sequence is shorter than the 300s window.
        initial_mono, initial_wall = time.monotonic(), self._clock()
        end = min(initial_mono + 40, deadline_monotonic or float('inf'))
        for attempt in range(self._attempts):
            if abs((self._clock() - initial_wall) - (time.monotonic() - initial_mono)) > 1:
                raise ExecutionControlError('execution_clock_changed')
            remaining = min(end - time.monotonic(), 40 - (self._clock() - initial_wall))
            if remaining <= 0:
                raise ExecutionControlError('execution_command_deadline')
            began, began_wall = time.monotonic(), self._clock()
            try:
                response = self._transport(self._origin, target, body, headers, min(self._timeout, remaining))
            except (OSError, TimeoutError, http.client.HTTPException):
                response = None
            received, received_wall = time.monotonic(), self._clock()
            if abs((received_wall - began_wall) - (received - began)) > 1:
                raise ExecutionControlError('execution_clock_changed')
            if response is not None and response.status == 200:
                if received >= end or received_wall - initial_wall >= 40 or len(response.body) > MAX_RESPONSE_BYTES:
                    raise ExecutionControlError('execution_command_deadline')
                try:
                    disposition = parse(json.loads(response.body))
                    server_time = next(value for name, value in response.headers.items() if name.lower() == 'x-execution-server-time')
                    # The current TLS response header is fresh even if the body
                    # is an old inbox receipt. Add the whole RTT and the API's
                    # one-second timestamp quantization conservatively.
                    server_upper = _instant(server_time) + 1 + max(received - began, received_wall - began_wall)
                    return CommandResult(disposition, server_upper, received, received_wall)
                except (ValueError, UnicodeError, StopIteration):
                    raise ExecutionControlError('execution_response_invalid') from None
            if response is not None and response.status not in {408, 425, 429, 500, 502, 503, 504}:
                raise ExecutionControlError('execution_command_refused', response.status)
            if attempt + 1 < self._attempts:
                time.sleep(min(self._delay * (2 ** attempt), max(0, end - time.monotonic())))
        raise ExecutionControlError('execution_transport_unavailable')


class ExecutorSession:
    """One random owner per invocation, with renewal only after native start."""
    @classmethod
    def acquire(cls, client: ExecutionControlClient, *, reference: Mapping[str, Any], attempt_token: str,
                max_operation_seconds: float = 45 * 60):
        if not 0 < max_operation_seconds <= 24 * 60 * 60:
            raise ExecutionControlError('execution_client_invalid')
        owner = str(uuid4())
        fence = {'reference': dict(reference), 'attemptToken': attempt_token, 'owner': owner}
        result = client.command({'action': 'acquire', **fence, 'leaseSeconds': 120})
        if result.disposition['disposition'] != 'acquired':
            raise ExecutionControlError('execution_not_acquired')
        if result.disposition['fence'] != fence:
            raise ExecutionControlError('execution_response_invalid')
        lease = result.received_monotonic + _instant(result.disposition['leaseExpiresAt']) - result.server_time_upper
        deadline = min(result.received_monotonic + max_operation_seconds,
                       result.received_monotonic + _instant(result.disposition['operationDeadlineAt']) - result.server_time_upper)
        lease_wall = result.received_wall + lease - result.received_monotonic
        deadline_wall = result.received_wall + deadline - result.received_monotonic
        if (min(lease, deadline) - time.monotonic() <= 5 or min(lease_wall, deadline_wall) - client._clock() <= 5
                or abs((client._clock() - result.received_wall) - (time.monotonic() - result.received_monotonic)) > 1):
            raise ExecutionControlError('execution_authority_lost')
        return cls(client, fence, lease, deadline, lease_wall, deadline_wall, result.received_wall, result.received_monotonic)

    def __init__(self, client: ExecutionControlClient, fence: Mapping[str, Any], lease: float, deadline: float,
                 lease_wall: float, deadline_wall: float, anchor_wall: float, anchor_mono: float):
        self._client, self._fence = client, dict(fence)
        self._lease, self._deadline = lease, deadline
        self._lease_wall, self._deadline_wall = lease_wall, deadline_wall
        self._anchor_wall, self._anchor_mono = anchor_wall, anchor_mono
        self._stop = Event()
        self._state_lock, self._start_lock = Lock(), Lock()
        self._diagnostic_lock, self._cancel_logged = Lock(), False
        self.cancel_event = _PermissionEvent(self._permission_live)
        self._started = False
        self._renewal: Thread | None = None

    @property
    def fence(self):
        # A caller must not mutate the reference held by subsequent commands.
        return json.loads(json.dumps(self._fence))

    @property
    def remaining_seconds(self):
        self.assert_live()
        return max(0, min(self._deadline - time.monotonic(), self._deadline_wall - self._client._clock()))

    def _permission_live(self):
        with self._state_lock:
            mono, wall = time.monotonic(), self._client._clock()
            stopped = self._stop.is_set()
            permitted = (not stopped and mono < min(self._lease, self._deadline)
                    and wall < min(self._lease_wall, self._deadline_wall)
                    and abs((wall - self._anchor_wall) - (mono - self._anchor_mono)) <= 1)
            reason = ('deadline' if mono >= self._deadline or wall >= self._deadline_wall else
                      'lease' if mono >= self._lease or wall >= self._lease_wall else 'clock')
        if not permitted and not stopped:
            self._cancel('permission', 'permission_'+reason,
                ExecutionControlError('execution_clock_changed' if reason == 'clock' else 'execution_authority_lost'))
        return permitted

    def _cancel(self, action, stage, error, started=None):
        # Cancel first. Diagnostics must never delay permission loss or change
        # the original exception, even if a logging handler fails.
        already_cancelled = Event.is_set(self.cancel_event)
        self.cancel_event.set()
        if already_cancelled: return
        try:
            with self._diagnostic_lock:
                if self._cancel_logged: return
                self._cancel_logged = True
            code = error.code if isinstance(error, ExecutionControlError) and error.code in _CANCELLATION_ERRORS else 'execution_control_unexpected'
            status = error.status if isinstance(error, ExecutionControlError) and type(error.status) is int and 100 <= error.status <= 599 else None
            with self._state_lock:
                mono, wall = time.monotonic(), self._client._clock()
                bounded_ms = lambda seconds: round(max(-86400, min(86400, seconds)) * 1000)
                metrics = {'leaseRemainingMs': bounded_ms(min(self._lease-mono, self._lease_wall-wall)),
                    'operationRemainingMs': bounded_ms(min(self._deadline-mono, self._deadline_wall-wall)),
                    'clockDriftMs': bounded_ms((wall-self._anchor_wall)-(mono-self._anchor_mono)),
                    'rpcElapsedMs': bounded_ms(max(0, mono-started)) if started is not None else None}
            record = json.dumps({'level':'warn','message':'native_execution_cancelled','action':action,'stage':stage,
                'errorCode':code,'failureKind':_CANCELLATION_ERRORS.get(code,'unexpected'),'status':status,**metrics}, separators=(',',':'))
            try:
                _diagnostics.put_nowait(record)
            except Full:
                pass
        except Exception:
            pass

    def assert_live(self):
        if self.cancel_event.is_set():
            raise ExecutionControlError('execution_authority_lost')

    def command(self, action: str, **fields: Any) -> CommandResult:
        if action not in {'read-disposition', 'commit-artifact', 'fail', 'release', 'progress', 'publication-command'} or {'fence', 'action'} & fields.keys():
            raise ExecutionControlError('execution_command_invalid')
        # Auditing never restores permission and remains possible after local
        # cancellation or an uncertain acknowledgement. Mutations require it.
        if action != 'read-disposition':
            self.assert_live()
        try:
            result = self._client.command({'action': action, 'fence': self._fence, **fields},
                deadline_monotonic=None if action == 'read-disposition' else min(self._deadline, self._lease))
        except ExecutionControlError:
            self.cancel_event.set()
            raise
        if result.disposition['disposition'] in {'expired', 'superseded', 'cancelled', 'failed', 'completed', 'released', 'retry_due'}:
            self.cancel_event.set()
        return result

    def transfer(self, action: str, **fields: Any) -> CommandResult:
        from .transfer import TARGET as TRANSFER_TARGET, validate_transfer_command, parse_transfer_disposition, check_transfer_response
        self.assert_live()
        if {'action', 'fence'} & fields.keys():
            raise ExecutionControlError('execution_transfer_invalid')
        command = {'action': action, 'fence': self.fence, **fields}
        validate_transfer_command(command)
        stage, started = 'transfer_rpc', time.monotonic()
        try:
            result = self._client._post(TRANSFER_TARGET, command, parse_transfer_disposition,
                                       deadline_monotonic=min(self._deadline, self._lease))
            stage = 'transfer_permission'
            self.assert_live()
            stage = 'transfer_response'
            check_transfer_response(command, result)
            return result
        except ExecutionControlError as error:
            # An old inbox grant can be refreshed while this owner is still
            # live. Refused authority or an unconfirmed control exchange stops
            # all native siblings through the same permission event.
            if error.code != 'execution_grant_expired':
                self._cancel('source-read' if action == 'source-read' else 'transfer', stage, error, started)
            raise

    def on_process_start(self, pid: int):
        """Pass directly to the process owner's callback, never call before Popen."""
        if type(pid) is not int or pid <= 0:
            raise ExecutionControlError('execution_process_invalid')
        with self._start_lock:
            self.assert_live()
            if self._started:
                return
            try:
                result = self._client.command({'action': 'process-start', 'fence': self._fence},
                                              deadline_monotonic=min(self._deadline, self._lease))
                if result.disposition['disposition'] != 'started':
                    raise ExecutionControlError('execution_authority_lost')
                self.assert_live()
            except BaseException:
                # The server may already have recorded the native start. This
                # is never reported as a proven uncharged startup rejection.
                self.cancel_event.set()
                raise
            self._started = True
            self._renewal = Thread(target=self._renew, name='execution-renewal', daemon=True)
            self._renewal.start()

    def _renew(self):
        while True:
            with self._state_lock:
                remaining = min(self._lease, self._deadline) - time.monotonic()
            if remaining <= 0:
                self._cancel('renew', 'renew_permission', ExecutionControlError('execution_authority_lost'))
                return
            if self.cancel_event.is_set():
                self.cancel_event.set()
                return
            if self._stop.wait(min(30, remaining)):
                return
            stage, started = 'renew_permission', time.monotonic()
            try:
                self.assert_live()
                stage = 'renew_rpc'
                result = self._client.command({'action': 'renew', 'fence': self._fence, 'leaseSeconds': 120},
                                              deadline_monotonic=min(self._deadline, self._lease))
                stage = 'renew_disposition'
                if result.disposition['disposition'] != 'renewed':
                    raise ExecutionControlError('execution_authority_lost')
                stage = 'renew_permission'
                self.assert_live()
                stage = 'renew_lease'
                lease = result.received_monotonic + _instant(result.disposition['leaseExpiresAt']) - result.server_time_upper
                if lease <= time.monotonic():
                    raise ExecutionControlError('execution_authority_lost')
                with self._state_lock:
                    self._lease = min(lease, self._deadline)
                    self._anchor_mono, self._anchor_wall = time.monotonic(), self._client._clock()
                    self._lease_wall = min(result.received_wall + lease - result.received_monotonic, self._deadline_wall)
            except BaseException as error:
                self._cancel('renew', stage, error, started)
                return

    def close(self):
        self._stop.set()
        self.cancel_event.set()
        if self._renewal is not None:
            self._renewal.join(timeout=41)

    def __enter__(self):
        self.assert_live()
        return self

    def __exit__(self, *_exc):
        self.close()
