"""Bounded native process supervision, including abrupt wrapper death.

The supervisor holds no credentials of its own. A pipe connects its lifetime to
its caller, and Linux subreaping adopts grandchildren that outlive Bun. Native
commands still use the TypeScript process module for their own deadlines.
"""

from __future__ import annotations

import ctypes
import asyncio
import json
import os
import selectors
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping, Sequence
from threading import Event

MAX_INPUT_BYTES = 64 * 1024
MAX_OUTPUT_BYTES = 1024 * 1024
MAX_ERROR_BYTES = 8192
FILE_SIZE_LIMIT_EXIT_CODE = 73


@dataclass(frozen=True)
class ProcessResult:
    returncode: int
    stdout: bytes
    stderr: bytes


class MediaProcessError(RuntimeError):
    def __init__(self, code: str, returncode: int | None = None):
        super().__init__(code)
        self.code = code
        self.returncode = returncode


def run_owned_process(
    argv: Sequence[str],
    *,
    input_bytes: bytes = b"",
    timeout_seconds: float,
    kill_grace_seconds: float = 5,
    env: Mapping[str, str] | None = None,
    on_start: Callable[[int], None] | None = None,
    cancel_event: Event | None = None,
    max_file_bytes: int | None = None,
) -> ProcessResult:
    """Run one finite command; never include its argv or raw stderr in errors."""
    if not argv or any(not isinstance(value, str) or "\x00" in value for value in argv):
        raise ValueError("invalid_media_command")
    if len(input_bytes) > MAX_INPUT_BYTES:
        raise ValueError("media_command_too_large")
    if not 0 < timeout_seconds <= 24 * 60 * 60 or not 0 < kill_grace_seconds <= 30:
        raise ValueError("invalid_media_deadline")
    if max_file_bytes is not None and (type(max_file_bytes) is not int or not 0 < max_file_bytes <= 10 * 1024 ** 3):
        raise ValueError("invalid_media_file_limit")
    if cancel_event is not None and cancel_event.is_set():
        raise MediaProcessError("media_execution_cancelled")
    child_env = dict(os.environ if env is None else env)
    for name in ("DATABASE_URL", "DIRECT_URL", "NEON_DATABASE_URL", "PGHOST", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGPORT", "PGSERVICE", "PGSERVICEFILE", "PGPASSFILE"):
        child_env.pop(name, None)
    read_fd, write_fd = os.pipe()
    start_read_fd, start_write_fd = os.pipe()
    os.set_blocking(start_read_fd, False)
    observed_start = False
    def observe_start():
        nonlocal observed_start
        if observed_start:
            return
        try:
            message = os.read(start_read_fd, 32)
        except BlockingIOError:
            return
        if message:
            observed_start = True
            if on_start is not None:
                try:
                    on_start(int(message))
                except Exception:
                    raise MediaProcessError("media_process_start_unconfirmed") from None
            # The supervisor already owns the actual child. Release its stdin
            # only after the control API has acknowledged that native start.
            try:
                os.write(write_fd, b'1')
            except OSError:
                raise MediaProcessError("media_process_start_unconfirmed") from None
    supervisor = None
    try:
        try:
            supervisor = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "--supervise", str(read_fd),
                 json.dumps(list(argv)), str(timeout_seconds), str(kill_grace_seconds), str(start_write_fd), str(max_file_bytes or 0)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                start_new_session=True, pass_fds=(read_fd, start_write_fd), env=child_env,
            )
        except OSError:
            raise MediaProcessError("media_process_spawn_failed") from None
        os.close(read_fd)
        read_fd = -1
        os.close(start_write_fd)
        start_write_fd = -1
        try:
            parent_deadline = time.monotonic() + timeout_seconds + kill_grace_seconds + 5
            first = True
            while True:
                if cancel_event is not None and cancel_event.is_set():
                    raise MediaProcessError("media_execution_cancelled")
                observe_start()
                try:
                    stdout, stderr = supervisor.communicate(input_bytes if first else None, timeout=0.05)
                    observe_start()
                    break
                except subprocess.TimeoutExpired:
                    first = False
                    if time.monotonic() >= parent_deadline:
                        raise MediaProcessError("media_supervisor_timeout") from None
        except BaseException:
            os.close(write_fd)
            write_fd = -1
            try:
                # Keep draining bounded output while the owner pipe makes the
                # supervisor stop its children. A full output pipe must not
                # prevent the supervisor from observing cancellation.
                supervisor.communicate(timeout=kill_grace_seconds + 3)
            except subprocess.TimeoutExpired:
                supervisor.kill()
                supervisor.communicate()
            raise
        return ProcessResult(supervisor.returncode, stdout, stderr)
    finally:
        if read_fd >= 0:
            os.close(read_fd)
        if write_fd >= 0:
            os.close(write_fd)
        os.close(start_read_fd)
        if start_write_fd >= 0:
            os.close(start_write_fd)
        if supervisor is not None:
            for stream in (supervisor.stdin, supervisor.stdout, supervisor.stderr):
                if stream is not None:
                    stream.close()


async def run_owned_process_async(argv: Sequence[str], *, input_bytes: bytes = b"", timeout_seconds: float,
                                  kill_grace_seconds: float = 5, env: Mapping[str, str] | None = None,
                                  on_start: Callable[[int], None] | None = None,
                                  cancel_event: Event | None = None,
                                  max_file_bytes: int | None = None) -> ProcessResult:
    """Cancellation is not complete until the native process group is reaped."""
    cancelled = cancel_event if cancel_event is not None else Event()
    task = asyncio.create_task(asyncio.to_thread(
        run_owned_process, argv, input_bytes=input_bytes, timeout_seconds=timeout_seconds,
        kill_grace_seconds=kill_grace_seconds, env=env, on_start=on_start, cancel_event=cancelled,
        max_file_bytes=max_file_bytes,
    ))
    try:
        return await asyncio.shield(task)
    except BaseException:
        cancelled.set()
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


def _direct_children(pid: int) -> set[int]:
    if sys.platform == "linux":
        try:
            return {int(value) for value in Path(f"/proc/{pid}/task/{pid}/children").read_text().split()}
        except (OSError, ValueError):
            return set()
    # The local development agent also runs on macOS. This reads process
    # metadata only; commands and environment values are never collected.
    result = subprocess.run(
        ["ps", "-axo", "pid=,ppid="], capture_output=True, check=False,
    )
    children = {int(parts[0]) for line in result.stdout.splitlines()
                if len(parts := line.split()) == 2 and int(parts[1]) == pid}
    alive = set()
    for child in children:
        try:
            os.kill(child, 0)
            alive.add(child)
        except ProcessLookupError:
            pass
    return alive


def _descendants(pid: int) -> set[int]:
    found: set[int] = set()
    pending = list(_direct_children(pid))
    while pending:
        child = pending.pop()
        if child in found:
            continue
        found.add(child)
        pending.extend(_direct_children(child))
    return found


def _process_identity(pid: int) -> str | None:
    try:
        if sys.platform == "linux":
            fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
            return None if fields[0] == "Z" else fields[19]
        value = subprocess.run(["ps", "-p", str(pid), "-o", "stat=,lstart="], capture_output=True).stdout.strip().split(None, 1)
        return value[1].decode() if len(value) == 2 and not value[0].startswith(b"Z") else None
    except (OSError, IndexError):
        return None


def _signal_tree(pids: set[int], signum: int, identities: Mapping[int, str]) -> None:
    pids = {pid for pid in pids if _process_identity(pid) == identities.get(pid)}
    own_group = os.getpgrp()
    groups: set[int] = set()
    for pid in pids:
        try:
            group = os.getpgid(pid)
            if group != own_group:
                groups.add(group)
        except ProcessLookupError:
            pass
    for group in groups:
        try:
            os.killpg(group, signum)
        except ProcessLookupError:
            pass
    for pid in pids:
        try:
            os.kill(pid, signum)
        except ProcessLookupError:
            pass


def _enable_subreaper() -> None:
    if sys.platform == "linux":
        # PR_SET_CHILD_SUBREAPER makes Bun's detached ffmpeg descendants our
        # children if Bun is killed before its finally handlers can reap them.
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
            raise MediaProcessError("media_subreaper_unavailable")


def _supervise(read_fd: int, argv: list[str], timeout: float, grace: float, start_fd: int, max_file_bytes: int) -> int:
    _enable_subreaper()
    if max_file_bytes:
        import resource
        _soft, hard = resource.getrlimit(resource.RLIMIT_FSIZE)
        if hard != resource.RLIM_INFINITY and hard < max_file_bytes:
            raise MediaProcessError("media_file_limit_unavailable")
        # Set the limit only in this isolated supervisor. All native children
        # inherit it, including yt-dlp's FFmpeg merger and fragment writers.
        resource.setrlimit(resource.RLIMIT_FSIZE, (max_file_bytes, max_file_bytes))
    body = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(body) > MAX_INPUT_BYTES:
        return 65
    stopping = False

    def stop(_signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=True)
    os.write(start_fd, str(child.pid).encode())
    os.close(start_fd)
    assert child.stdin and child.stdout and child.stderr
    selector = selectors.DefaultSelector()
    for stream, name in [(child.stdout, "stdout"), (child.stderr, "stderr")]:
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ, name)
    os.set_blocking(read_fd, False)
    selector.register(read_fd, selectors.EVENT_READ, "owner")
    os.set_blocking(child.stdin.fileno(), False)
    acknowledged = False
    offset = 0
    sizes = {"stdout": 0, "stderr": 0}
    caps = {"stdout": MAX_OUTPUT_BYTES, "stderr": MAX_ERROR_BYTES}
    deadline = time.monotonic() + timeout
    termination_at: float | None = None
    failure_code: int | None = None
    identities: dict[int, str] = {}
    try:
        while True:
            now = time.monotonic()
            child.poll()
            if max_file_bytes and child.returncode == -signal.SIGXFSZ:
                failure_code = FILE_SIZE_LIMIT_EXIT_CODE
            discovered = _descendants(os.getpid())
            for pid in discovered:
                identity = _process_identity(pid)
                if identity is not None:
                    identities.setdefault(pid, identity)
            descendants = {pid for pid, identity in identities.items() if _process_identity(pid) == identity}
            # Reap adopted descendants without stealing Popen's root status.
            for pid in _direct_children(os.getpid()) - {child.pid}:
                try:
                    os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    pass
            if now >= deadline and failure_code is None:
                failure_code, stopping = 124, True
            if stopping or child.returncode is not None:
                if termination_at is None:
                    termination_at = now
                    if stopping and failure_code is None:
                        failure_code = 143
                    _signal_tree(descendants, signal.SIGTERM, identities)
                elif now - termination_at >= grace:
                    _signal_tree(descendants, signal.SIGKILL, identities)
            streams_open = any(key.data in {"stdout", "stderr"} for key in selector.get_map().values())
            if child.returncode is not None and not streams_open and not descendants and (acknowledged or stopping):
                return failure_code if failure_code is not None else child.returncode
            # Even a descendant that ignores TERM cannot keep this supervisor
            # alive indefinitely. KILL is repeated while adopted children reap.
            if termination_at is not None and now - termination_at > grace + 2:
                _signal_tree(descendants, signal.SIGKILL, identities)
                return failure_code if failure_code is not None else (child.returncode or 137)
            for key, _events in selector.select(timeout=0.025):
                if key.data == "owner":
                    message = os.read(read_fd, 1)
                    if message == b"":
                        stopping = True
                        selector.unregister(read_fd)
                    elif message == b'1' and not acknowledged:
                        acknowledged = True
                        if body:
                            selector.register(child.stdin, selectors.EVENT_WRITE, "stdin")
                        else:
                            child.stdin.close()
                    else:
                        failure_code, stopping = 65, True
                elif key.data == "stdin":
                    try:
                        offset += os.write(key.fileobj.fileno(), body[offset:])
                    except BrokenPipeError:
                        offset = len(body)
                    if offset == len(body):
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                else:
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                        continue
                    name = key.data
                    available = max(0, caps[name] - sizes[name])
                    if available:
                        stream = sys.stdout.buffer if name == "stdout" else sys.stderr.buffer
                        stream.write(chunk[:available])
                        stream.flush()
                    sizes[name] += len(chunk)
                    if sizes[name] > caps[name]:
                        failure_code, stopping = 70, True
    finally:
        _signal_tree(set(identities), signal.SIGKILL, identities)
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        selector.close()
        for stream in (child.stdin, child.stdout, child.stderr):
            if stream is not None:
                stream.close()


if __name__ == "__main__":
    if len(sys.argv) != 8 or sys.argv[1] != "--supervise":
        raise SystemExit(64)
    try:
        raise SystemExit(_supervise(int(sys.argv[2]), json.loads(sys.argv[3]),
                                   float(sys.argv[4]), float(sys.argv[5]), int(sys.argv[6]), int(sys.argv[7])))
    except Exception:
        # Raw exceptions can contain argv, URLs or caller payloads.
        raise SystemExit(70)
