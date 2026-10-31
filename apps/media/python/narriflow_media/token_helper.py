"""One invocation owns the pinned loopback token daemon and its process tree."""
from __future__ import annotations

import asyncio
import json
import math
import os
from pathlib import Path
import shutil
import socket
import tempfile
from threading import Event
import time
from typing import Callable
from uuid import uuid4

from .fetch import SourceFetchFailure
from .process import run_owned_process_async
from .proxy import BoundProxySession


class _HelperCancellation(Event):
    def __init__(self, owner: Event):
        super().__init__()
        self._owner = owner

    def is_set(self):
        return super().is_set() or self._owner.is_set()


class OwnedTokenHelper:
    def __init__(self, *, server_home: Path, work_directory: Path, session: BoundProxySession | None,
                 assert_owned: Callable[[], None], cancel_event: Event, deadline_seconds: float = 2700,
                 bun_executable: str = 'bun'):
        if not math.isfinite(deadline_seconds) or not 0 < deadline_seconds <= 2700:
            raise SourceFetchFailure('source_token_helper_invalid')
        self._home, self._work, self._session = server_home.resolve(), work_directory, session
        self._assert_owned, self._cancel = assert_owned, _HelperCancellation(cancel_event)
        self._seconds, self._bun = deadline_seconds, bun_executable
        self._task: asyncio.Task | None = None
        self._directory: Path | None = None
        self._url: str | None = None

    @property
    def url(self):
        self.assert_live()
        assert self._url is not None
        return self._url

    def assert_live(self):
        self._assert_owned()
        if self._url is None or self._cancel.is_set() or self._task is None or self._task.done():
            raise SourceFetchFailure('source_token_helper_unavailable', True)

    async def __aenter__(self):
        self._assert_owned()
        try:
            self._work.mkdir(parents=True, exist_ok=True)
            self._directory = Path(tempfile.mkdtemp(prefix='token-helper-', dir=self._work)).resolve()
            ready = self._directory / 'ready.json'
            # A competing bind can make startup fail, but cannot produce our
            # child's readiness marker and private owner-bearing ready file.
            with socket.socket() as reserved:
                reserved.bind(('127.0.0.1', 0))
                port = reserved.getsockname()[1]
            owner = uuid4().hex
            endpoint = f'http://127.0.0.1:{port}'
            environment = {name: os.environ[name] for name in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'DENO_DIR') if name in os.environ}
            command = {'serverHome': str(self._home), 'readyFile': str(ready), 'owner': owner, 'port': port,
                       'proxy': self._session.url if self._session is not None else '', 'deadlineSeconds': self._seconds}
            cli = Path(__file__).resolve().parents[2] / 'src/token-helper-cli.ts'
            # Helper readiness is preflight. The first actual yt-dlp spawn
            # records the domain start, after this daemon is ready.
            self._task = asyncio.create_task(run_owned_process_async(
                [self._bun, str(cli)], input_bytes=json.dumps(command).encode(), env=environment,
                timeout_seconds=self._seconds + 5, kill_grace_seconds=2, cancel_event=self._cancel,
            ))
            deadline = time.monotonic() + min(self._seconds, 45)
            while time.monotonic() < deadline:
                self._assert_owned()
                if self._cancel.is_set() or self._task.done():
                    raise SourceFetchFailure('source_token_helper_unavailable', True)
                if ready.exists():
                    if ready.stat().st_size > 4096:
                        raise ValueError()
                    facts = json.loads(ready.read_bytes())
                    if facts != {'owner': owner, 'version': '2.0.0', 'url': endpoint}:
                        raise ValueError()
                    self._url = endpoint
                    self.assert_live()
                    return self
                await asyncio.sleep(0.05)
            raise SourceFetchFailure('source_token_helper_unavailable', True)
        except (OSError, ValueError):
            await self.close()
            raise SourceFetchFailure('source_token_helper_unavailable', True) from None
        except BaseException:
            await self.close()
            raise

    async def close(self):
        self._cancel.set()
        self._url = None
        if self._task is not None:
            while not self._task.done():
                try:
                    await asyncio.shield(self._task)
                except asyncio.CancelledError:
                    continue
                except Exception:
                    break
            await asyncio.gather(self._task, return_exceptions=True)
        if self._directory is not None:
            await asyncio.to_thread(shutil.rmtree, self._directory, True)
            self._directory = None

    async def __aexit__(self, *_args):
        await self.close()
