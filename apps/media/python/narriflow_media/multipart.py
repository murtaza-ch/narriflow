"""Bounded file upload and conditional ranged pinning with scoped grants only."""
from __future__ import annotations

import asyncio
import base64
from collections import deque
from dataclasses import dataclass, field
import hashlib
import http.client
import os
from pathlib import Path
import re
import socket
import ssl
from threading import Event, Thread
import time
from typing import Awaitable, Callable, Mapping, Protocol
from urllib.parse import urlsplit

from .fetch import FileSnapshot
from .manifest import MAX_SOURCE_BYTES

PART_SIZE_BYTES = 16 * 1024 * 1024
MIN_PART_SIZE_BYTES = 5 * 1024 * 1024
MAX_CONCURRENCY = 4


class MultipartTransferError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class SignedGrant:
    url: str = field(repr=False)
    headers: Mapping[str, str] = field(default_factory=dict, repr=False)


@dataclass(frozen=True)
class MultipartDestination:
    artifact_id: str
    upload_id: str = field(repr=False)
    byte_length: int
    part_size_bytes: int = PART_SIZE_BYTES


@dataclass(frozen=True)
class CompletedPart:
    part_number: int
    etag: str
    checksum_sha256: str
    checksum_md5: str


@dataclass(frozen=True)
class CompletedObject:
    key: str
    etag: str
    byte_length: int
    sha256: str


@dataclass(frozen=True)
class TransferResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes | memoryview = field(repr=False)


class MultipartControl(Protocol):
    async def authorize_part(self, part_number: int, byte_length: int, checksum_sha256: str, checksum_md5: str) -> SignedGrant: ...
    async def complete(self, parts: tuple[CompletedPart, ...], sha256: str) -> CompletedObject: ...
    async def abort(self, reason: str) -> None: ...


class PinControl(MultipartControl, Protocol):
    async def authorize_source_range(self, start: int, end: int, source_etag: str) -> SignedGrant: ...


class TransferTransport(Protocol):
    async def request(self, grant: SignedGrant, method: str, body: bytes | None, headers: Mapping[str, str],
                      max_response_bytes: int, cancelled: Callable[[], bool]) -> TransferResponse: ...


def _header(headers: Mapping[str, str], name: str):
    return next((value for key, value in headers.items() if key.lower() == name.lower()), None)


def _etag(value: object):
    if not isinstance(value, str) or not re.fullmatch(r'[\x21-\x7e]{1,160}', value):
        raise MultipartTransferError('multipart_response_invalid')
    return value


class SignedHttpTransport:
    """No redirects, environment proxies, credentials or unbounded response bodies."""
    def __init__(self, *, timeout_seconds: float = 60, allow_loopback_http: bool = False):
        if not 0 < timeout_seconds <= 60:
            raise MultipartTransferError('multipart_configuration_invalid')
        self._timeout, self._local = timeout_seconds, allow_loopback_http

    async def request(self, grant, method, body, headers, max_response_bytes, cancelled):
        stopped = Event()
        task = asyncio.create_task(asyncio.to_thread(
            self._request, grant, method, body, headers, max_response_bytes,
            lambda: stopped.is_set() or cancelled(),
        ))
        try:
            return await asyncio.shield(task)
        except BaseException:
            stopped.set()
            while not task.done():
                try:
                    await asyncio.shield(task)
                except asyncio.CancelledError:
                    continue
                except Exception:
                    break
            try:
                task.result()
            except BaseException:
                pass
            raise

    def _request(self, grant, method, body, headers, max_response_bytes, cancelled):
        try:
            parsed = urlsplit(grant.url)
            local = self._local and parsed.scheme == 'http' and parsed.hostname in {'localhost', '127.0.0.1', '::1'}
            if (parsed.scheme != 'https' and not local or not parsed.hostname or parsed.username is not None
                    or parsed.fragment or len(grant.url) > 8192 or method not in {'GET', 'PUT'}
                    or not 0 <= max_response_bytes <= PART_SIZE_BYTES):
                raise ValueError()
            combined = dict(grant.headers)
            for name, value in headers.items():
                existing = _header(combined, name)
                if existing is not None and existing != value:
                    raise ValueError()
                combined[name] = value
            if any(not isinstance(name, str) or not isinstance(value, str) or re.search(r'[\r\n\x00]', name + value)
                   for name, value in combined.items()):
                raise ValueError()
        except (ValueError, TypeError):
            raise MultipartTransferError('multipart_grant_invalid') from None
        connection = (http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=self._timeout) if local else
                      http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=self._timeout,
                                                  context=ssl.create_default_context()))
        finished = Event()
        deadline = time.monotonic() + self._timeout
        wall_deadline = time.time() + self._timeout
        active_socket = None
        def monitor():
            while not finished.wait(0.05):
                if cancelled() or time.monotonic() >= deadline or time.time() >= wall_deadline:
                    # HTTPResponse owns the socket after Connection:close.
                    # connection.close() alone cannot interrupt that read.
                    sock = connection.sock or active_socket
                    if sock is not None:
                        try:
                            sock.shutdown(socket.SHUT_RDWR)
                        except OSError:
                            pass
                    connection.close()
                    return
        watcher = Thread(target=monitor, daemon=True)
        watcher.start()
        try:
            if cancelled():
                raise MultipartTransferError('multipart_cancelled')
            target = parsed.path or '/'
            if parsed.query:
                target += '?' + parsed.query
            connection.request(method, target, body=body, headers=combined)
            active_socket = connection.sock
            response = connection.getresponse()
            buffer, size = bytearray(max_response_bytes + 1), 0
            while received := response.readinto(memoryview(buffer)[size:]):
                size += received
                if size > max_response_bytes:
                    raise MultipartTransferError('multipart_response_too_large')
            if cancelled() or time.monotonic() >= deadline or time.time() >= wall_deadline:
                raise MultipartTransferError('multipart_cancelled')
            return TransferResponse(response.status, dict(response.getheaders()), memoryview(buffer)[:size])
        except (OSError, http.client.HTTPException):
            raise MultipartTransferError('multipart_transport_failed') from None
        finally:
            finished.set()
            connection.close()
            watcher.join(timeout=0.1)


def _validate(destination: MultipartDestination, concurrency: int):
    if (type(destination.byte_length) is not int or not 0 < destination.byte_length <= MAX_SOURCE_BYTES
            or type(destination.part_size_bytes) is not int or not MIN_PART_SIZE_BYTES <= destination.part_size_bytes <= PART_SIZE_BYTES
            or type(concurrency) is not int or not 1 <= concurrency <= MAX_CONCURRENCY
            or not destination.artifact_id or not destination.upload_id):
        raise MultipartTransferError('multipart_configuration_invalid')


async def _abort(control: MultipartControl):
    try:
        await asyncio.wait_for(control.abort('native_transfer_failed'), timeout=5)
    except BaseException:
        # The API retains the upload ID for recovery and orphan cleanup.
        pass


async def _transfer(destination: MultipartDestination, *, read: Callable[[int, int], Awaitable[bytes]],
                    control: MultipartControl, transport: TransferTransport, assert_owned: Callable[[], None],
                    cancel_event: Event, concurrency: int, verify: Callable[[], None], expected_sha256: str | None):
    _validate(destination, concurrency)
    failed = Event()
    active: set[asyncio.Task] = set()
    first_error: list[BaseException] = []
    def live():
        if failed.is_set() or cancel_event.is_set():
            raise MultipartTransferError('multipart_cancelled')
        assert_owned()
    async def part(number: int):
        start = (number - 1) * destination.part_size_bytes
        end = min(start + destination.part_size_bytes, destination.byte_length)
        body = None
        for attempt in range(3):
            live()
            try:
                if body is None:
                    body = await read(start, end)
                    if len(body) != end - start:
                        raise MultipartTransferError('multipart_short_read')
                checksum = base64.b64encode(hashlib.sha256(body).digest()).decode('ascii')
                md5 = hashlib.md5(body, usedforsecurity=False).digest()
                checksum_md5 = base64.b64encode(md5).decode("ascii")
                grant = await control.authorize_part(number, len(body), checksum, checksum_md5)
                live()
                response = await transport.request(grant, 'PUT', body,
                    {'Content-Length': str(len(body)), 'Content-MD5': checksum_md5}, 65536,
                    lambda: failed.is_set() or cancel_event.is_set())
                if response.status in {403, 408, 429, 500, 502, 503, 504}:
                    raise MultipartTransferError('multipart_transport_failed')
                if response.status != 200:
                    raise MultipartTransferError('multipart_part_refused')
                etag = _etag(_header(response.headers, 'etag'))
                if etag not in {md5.hex(), f'"{md5.hex()}"'}:
                    raise MultipartTransferError('multipart_part_checksum_mismatch')
                return CompletedPart(number, etag, checksum, checksum_md5), body
            except MultipartTransferError as error:
                if error.code != 'multipart_transport_failed' or attempt == 2:
                    raise
        raise MultipartTransferError('multipart_transport_failed')
    async def guarded_part(number: int):
        try:
            return await part(number)
        except BaseException as error:
            if not failed.is_set():
                first_error.append(error)
                failed.set()
                for sibling in active:
                    if sibling is not asyncio.current_task():
                        sibling.cancel()
            raise
    def schedule(number: int):
        task = asyncio.create_task(guarded_part(number))
        active.add(task)
        task.add_done_callback(active.discard)
        return task
    count = (destination.byte_length + destination.part_size_bytes - 1) // destination.part_size_bytes
    pending: deque[asyncio.Task] = deque()
    parts, digest, next_number, completing = [], hashlib.sha256(), 1, False
    try:
        live()
        while next_number <= min(concurrency, count):
            pending.append(schedule(next_number))
            next_number += 1
        while pending:
            task = pending.popleft()
            uploaded, body = await task
            digest.update(body)
            parts.append(uploaded)
            del task, body
            if next_number <= count:
                live()
                pending.append(schedule(next_number))
                next_number += 1
        verify()
        sha256 = digest.hexdigest()
        if expected_sha256 is not None and sha256 != expected_sha256:
            raise MultipartTransferError('multipart_source_changed')
        live()
        completing = True
        # The API alone completes the upload and verifies target HEAD. If the
        # acknowledgement is lost, never infer that this object is unreferenced.
        result = await control.complete(tuple(parts), sha256)
        if result.byte_length != destination.byte_length or result.sha256 != sha256:
            raise MultipartTransferError('multipart_completion_unconfirmed')
        return result
    except BaseException:
        failed.set()
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        if not completing:
            await _abort(control)
        if first_error:
            raise first_error[0]
        raise


async def upload_file(path: Path, destination: MultipartDestination, *, control: MultipartControl,
                      transport: TransferTransport, assert_owned: Callable[[], None], cancel_event: Event,
                      concurrency: int = MAX_CONCURRENCY, expected_sha256: str | None = None):
    _validate(destination, concurrency)
    try:
        handle = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    except OSError:
        await _abort(control)
        raise MultipartTransferError('multipart_source_invalid') from None
    transferring = False
    try:
        snapshot = FileSnapshot.read(path)
        if snapshot.size != destination.byte_length or os.fstat(handle).st_ino != snapshot.inode:
            raise MultipartTransferError('multipart_source_changed')
        def unchanged():
            if FileSnapshot.read(path) != snapshot:
                raise MultipartTransferError('multipart_source_changed')
        async def read(start, end):
            unchanged()
            body = await asyncio.to_thread(os.pread, handle, end - start, start)
            unchanged()
            return body
        transferring = True
        return await _transfer(destination, read=read, control=control, transport=transport, assert_owned=assert_owned,
                               cancel_event=cancel_event, concurrency=concurrency, verify=unchanged, expected_sha256=expected_sha256)
    except BaseException:
        if not transferring:
            await _abort(control)
        raise
    finally:
        os.close(handle)


async def pin_source(destination: MultipartDestination, *, source_etag: str, control: PinControl,
                     transport: TransferTransport, assert_owned: Callable[[], None], cancel_event: Event,
                     concurrency: int = MAX_CONCURRENCY, expected_sha256: str | None = None):
    _validate(destination, concurrency)
    _etag(source_etag)
    async def read(start, end):
        assert_owned()
        grant = await control.authorize_source_range(start, end, source_etag)
        response = await transport.request(grant, 'GET', None,
            {'If-Match': source_etag, 'Range': f'bytes={start}-{end - 1}'}, end - start,
            cancel_event.is_set)
        if response.status == 412:
            raise MultipartTransferError('multipart_source_changed')
        if response.status in {403, 408, 429, 500, 502, 503, 504}:
            raise MultipartTransferError('multipart_transport_failed')
        if (response.status != 206 or _header(response.headers, 'etag') != source_etag
                or _header(response.headers, 'content-range') != f'bytes {start}-{end - 1}/{destination.byte_length}'
                or _header(response.headers, 'content-length') != str(end - start)):
            raise MultipartTransferError('multipart_source_changed')
        return response.body
    return await _transfer(destination, read=read, control=control, transport=transport, assert_owned=assert_owned,
                           cancel_event=cancel_event, concurrency=concurrency, verify=assert_owned, expected_sha256=expected_sha256)
