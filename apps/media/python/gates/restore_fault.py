"""Isolated restore gate. Never register this client on a product executor.

The real visual validator records process-start and completes assigned uploads.
This deliberately untrusted invocation then stops renewing, waits for one private
R2 release key, and sends its exact old commit with fresh authentication. Only a
server-side superseded reply passes. It cannot reacquire, publish, or reset a budget.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import http.client
import json
from pathlib import Path
import re
import ssl
import tempfile
import time
from typing import Any, Callable, Mapping
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

from narriflow_media.control import ExecutionControlClient, ExecutionControlError, ExecutorSession


def _error(code):
    return ExecutionControlError('restore_fault_' + code)


def _uuid(value):
    return isinstance(value, str) and str(UUID(value)) == value


@dataclass(frozen=True)
class RestoreFaultGate:
    run_id: str
    nonce: str = field(repr=False)
    source_epoch: int
    target_epoch: int
    release_url: str = field(repr=False)
    maximum_hold_seconds: int = 300

    def __post_init__(self):
        try:
            url = urlsplit(self.release_url)
            query = parse_qs(url.query, strict_parsing=True)
            host = r'(?:[a-z0-9][a-z0-9.-]{0,62}\.)?[a-f0-9]{32}\.r2\.cloudflarestorage\.com'
            path = rf'/(?:[a-z0-9][a-z0-9.-]{{0,62}}/)?execution/restore-gates/{re.escape(self.run_id)}/release\.json'
            if (not _uuid(self.run_id) or not re.fullmatch(r'[a-f0-9]{64}', self.nonce)
                    or type(self.source_epoch) is not int or not 0 < self.source_epoch < self.target_epoch
                    or type(self.target_epoch) is not int or self.target_epoch > 2**31 - 1
                    or type(self.maximum_hold_seconds) is not int or not 1 <= self.maximum_hold_seconds <= 540
                    or url.scheme != 'https' or not re.fullmatch(host, url.hostname or '') or url.port not in {None, 443}
                    or url.username is not None or url.password is not None or url.fragment or not re.fullmatch(path, url.path)
                    or any(ord(char) <= 32 for char in self.release_url)
                    or query.get('X-Amz-Algorithm') != ['AWS4-HMAC-SHA256'] or len(query.get('X-Amz-Expires', [])) != 1
                    or not 1 <= int(query['X-Amz-Expires'][0]) <= 600
                    or len(query.get('X-Amz-Signature', [])) != 1 or not re.fullmatch(r'[a-f0-9]{64}', query['X-Amz-Signature'][0])):
                raise ValueError()
        except (ValueError, TypeError):
            raise _error('gate_invalid') from None


def _read_release(url: str, timeout: float) -> bytes:
    parsed = urlsplit(url)
    connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=timeout, context=ssl.create_default_context())
    try:
        connection.request('GET', parsed.path + '?' + parsed.query, headers={'Cache-Control': 'no-cache, no-store', 'Accept': 'application/json'})
        response = connection.getresponse()
        if response.status != 200:  # No redirects or alternate destinations.
            raise _error('release_unavailable')
        body = response.read(4097)
        if len(body) > 4096:
            raise _error('release_invalid')
        return body
    except (OSError, http.client.HTTPException):
        raise _error('release_unavailable') from None
    finally:
        connection.close()


def _release(body: bytes, gate: RestoreFaultGate):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError()
            result[key] = value
        return result
    try:
        if not isinstance(body, bytes) or not 0 < len(body) <= 4096:
            raise ValueError()
        value = json.loads(body, object_pairs_hook=unique)
        if (not isinstance(value, dict) or set(value) != {'version', 'runId', 'nonce', 'sourceEpoch', 'targetEpoch', 'release'}
                or type(value['version']) is not int or value['version'] != 1 or value['runId'] != gate.run_id or value['nonce'] != gate.nonce
                or type(value['sourceEpoch']) is not int or value['sourceEpoch'] != gate.source_epoch
                or type(value['targetEpoch']) is not int or value['targetEpoch'] != gate.target_epoch or type(value['release']) is not bool):
            raise ValueError()
        return value['release']
    except (ValueError, UnicodeError, TypeError):
        raise _error('release_invalid') from None


class RestoreCommitFaultClient(ExecutionControlClient):
    def __init__(self, *, gate: RestoreFaultGate, notify: Callable[[dict], None], release_read=_read_release,
                 sleep=time.sleep, monotonic=time.monotonic, **control_options):
        super().__init__(**control_options)
        self._gate, self._notify, self._read, self._sleep, self._mono = gate, notify, release_read, sleep, monotonic
        self._fence, self._stop_renewals, self._started, self._held = None, None, False, False
        self.report = None

    def arm(self, fence: Mapping[str, Any], *, remaining_seconds: float, stop_renewals: Callable[[], None]):
        from narriflow_media.entrypoint import invocation_reference
        try:
            frozen = json.loads(json.dumps(fence, allow_nan=False))
            invocation_reference({'reference': frozen['reference'], 'attemptToken': frozen['attemptToken']}, 'asset_validation')
            if (self._fence is not None or not _uuid(frozen['owner']) or frozen['reference']['subject']['kind'] != 'native_validation'
                    or frozen['reference']['deploymentEpoch'] != self._gate.source_epoch or not 10 < remaining_seconds <= 600):
                raise ValueError()
            self._absolute_end = self._mono() + remaining_seconds - 5
            self._fence, self._stop_renewals = frozen, stop_renewals
        except (ValueError, TypeError, KeyError):
            raise _error('identity_invalid') from None

    def command(self, command: Mapping[str, Any], *, deadline_monotonic=None):
        if command.get('action') != 'commit-artifact' or command.get('artifact', {}).get('role') != 'probe':
            result = super().command(command, deadline_monotonic=deadline_monotonic)
            if command.get('action') == 'process-start' and result.disposition['disposition'] == 'started' and command.get('fence') == self._fence:
                self._started = True
            return result
        if not self._started:
            raise _error('start_missing')
        if self._held or command.get('fence') != self._fence or command['artifact'].get('contentType') != 'application/json':
            raise _error('identity_invalid')
        frozen = json.loads(json.dumps(command, separators=(',', ':'), sort_keys=True, allow_nan=False))
        digest = hashlib.sha256(json.dumps(frozen, separators=(',', ':'), sort_keys=True).encode()).hexdigest()
        self._held = True
        self._stop_renewals()
        ready = {'event': 'restore_fault_ready', 'runId': self._gate.run_id, 'sourceEpoch': self._gate.source_epoch,
            'dispatchId': self._fence['reference']['dispatchId'], 'attemptToken': self._fence['attemptToken'],
            'artifactId': frozen['artifact']['artifactId'], 'commandSha256': digest}
        self._notify(ready)
        end = min(self._mono() + self._gate.maximum_hold_seconds, self._absolute_end)
        while self._mono() < end:
            try:
                released = _release(self._read(self._gate.release_url, min(5, end - self._mono())), self._gate)
            except ExecutionControlError as error:
                if error.code != 'restore_fault_release_unavailable':
                    raise
                released = False
            if released:
                if self._mono() >= end:
                    break
                # Fault injection only: the owner was intentionally stopped above.
                # Start fresh transport authentication, preserving the complete old
                # domain fence/artifact command. Never inherit the expired local lease.
                result = super().command(frozen, deadline_monotonic=time.monotonic() + min(40, end - self._mono()))
                if result.disposition['disposition'] != 'superseded':
                    raise _error('stale_commit_accepted')
                self.report = {**ready, 'event': 'restore_fault_refused', 'targetEpoch': self._gate.target_epoch, 'refusal': 'superseded'}
                return result
            self._sleep(min(1, max(0, end - self._mono())))
        raise _error('hold_expired')


async def run_restore_fault(client: RestoreCommitFaultClient, invocation: Mapping[str, Any], *, transfer_transport=None) -> dict:
    """Run the unchanged real PNG validator, holding only its final probe commit."""
    from narriflow_media.artifacts import ArtifactCommitUnconfirmed
    from narriflow_media.entrypoint import invocation_reference
    from narriflow_media.native_runtime import run_asset_validation
    from narriflow_media.transfer import load_work_package
    value = invocation_reference(invocation, 'asset_validation')
    session = ExecutorSession.acquire(client, reference=value['reference'], attempt_token=value['attemptToken'], max_operation_seconds=600)
    try:
        client.arm(session.fence, remaining_seconds=session.remaining_seconds, stop_renewals=session.close)
        package = await load_work_package(session, transport=transfer_transport)
        command = package.command
        if (package.function_name != 'asset_validation' or command.get('kind') != 'visual'
                or command.get('expected', {}).get('contentType') != 'image/png'
                or type(command.get('expected', {}).get('byteLength')) is not int or not 0 < command['expected']['byteLength'] <= 1024 * 1024):
            raise _error('png_assignment_required')
        with tempfile.TemporaryDirectory(prefix='restore-fault-') as directory:
            try:
                await run_asset_validation(session, package, Path(directory), transport=transfer_transport)
            except ArtifactCommitUnconfirmed:
                if client.report is None:
                    raise
        if client.report is None:
            raise _error('commit_not_observed')
        return client.report
    finally:
        session.close()
