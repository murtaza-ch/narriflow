"""Pinned yt-dlp processes and the shared normalized probe for source fetches."""
from __future__ import annotations

import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys
import time
from typing import Callable
from threading import Event
from urllib.parse import urlsplit

from .fetch import DownloadedSource, ProviderAccessBlocked, ResolvedSource, SourceFetchFailure
from .manifest import MAX_SOURCE_BYTES, YouTubeSource, toolchain_versions
from .process import run_owned_process_async
from .proxy import BoundProxySession

FORMAT_PREFERENCE = "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best"


class YtDlpSourceRuntime:
    def __init__(self, *, token_provider_url: str, on_process_start: Callable[[int], None],
                 deadline_seconds: float = 45 * 60, bun_executable: str = "bun",
                 cancel_event: Event | None = None):
        try:
            parsed = urlsplit(token_provider_url)
            if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"} or
                    parsed.port is None or not 0 < parsed.port <= 65535 or parsed.path not in {"", "/"} or
                    parsed.username is not None or parsed.query or parsed.fragment):
                raise ValueError()
            versions = toolchain_versions()
            if ".".join(map(str, sys.version_info[:3])) != versions["python"]:
                raise ValueError()
            for name in ["yt-dlp", "bgutil-ytdlp-pot-provider", "yt-dlp-ejs"]:
                if importlib.metadata.version(name) != versions[name]:
                    raise ValueError()
            if not 0 < deadline_seconds <= 45 * 60:
                raise ValueError()
        except (ValueError, importlib.metadata.PackageNotFoundError):
            raise SourceFetchFailure("source_runtime_invalid") from None
        self._token_url = token_provider_url.rstrip("/")
        self._start = on_process_start
        self._cancel = cancel_event
        self._deadline = time.monotonic() + deadline_seconds
        self._bun = bun_executable
        self._probe = Path(__file__).resolve().parents[2] / "src/probe-cli.ts"
        self._plugins = str(importlib.metadata.distribution("bgutil-ytdlp-pot-provider").locate_file(""))
        # Fail configuration before work starts. Python isolation plus explicit
        # plugin paths excludes the laptop's unrelated configs and plugins.
        import yt_dlp
        yt_dlp.parse_options(self._arguments(None))

    def _remaining(self, ceiling: float = 45 * 60):
        remaining = min(ceiling, self._deadline - time.monotonic())
        if remaining <= 0:
            raise SourceFetchFailure("source_fetch_deadline_exceeded", True)
        return remaining

    def _environment(self, session: BoundProxySession | None):
        # The downloader and its third-party plugins need tool/cache locations,
        # never the caller's control key or unrelated provider credentials.
        environment = {name: os.environ[name] for name in (
            "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP",
            "DENO_DIR", "SSL_CERT_FILE", "SSL_CERT_DIR",
        ) if name in os.environ}
        for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]:
            environment[name] = ""
        environment.update(NO_PROXY="127.0.0.1,localhost,::1", no_proxy="127.0.0.1,localhost,::1",
                           PYTHONNOUSERSITE="1", DENO_NO_PROMPT="1", DENO_NO_UPDATE_CHECK="1")
        if session is not None:
            environment.update(session.environment())
        return environment

    def _arguments(self, session: BoundProxySession | None):
        args = ["--ignore-config", "--no-playlist", "--no-plugin-dirs", "--plugin-dirs", self._plugins,
                "--no-cache-dir", "--no-mtime", "--quiet", "--no-warnings", "--no-progress",
                "--max-filesize", str(MAX_SOURCE_BYTES), "--socket-timeout", "30", "--retries", "3",
                "--fragment-retries", "3", "--file-access-retries", "1", "--extractor-retries", "3",
                "--concurrent-fragments", "4", "--abort-on-unavailable-fragments",
                "--no-js-runtimes", "--js-runtimes", "deno", "--no-remote-components",
                "--extractor-args", "youtube:player_client=mweb",
                "--extractor-args", f"youtubepot-bgutilhttp:base_url={self._token_url}"]
        return args + (session.yt_dlp_arguments() if session is not None else ["--proxy", ""])

    async def _yt_dlp(self, args: list[str], session: BoundProxySession | None):
        result = await run_owned_process_async(
            [sys.executable, "-I", "-m", "yt_dlp", *self._arguments(session), *args],
            timeout_seconds=self._remaining(), env=self._environment(session), on_start=self._start,
            cancel_event=self._cancel,
        )
        if result.returncode:
            diagnostic = result.stderr.lower()
            if (b"sign in to confirm" in diagnostic or re.search(rb"http(?: error)?[ :]+(?:403|429)\b", diagnostic)
                    or b"403 forbidden" in diagnostic):
                raise ProviderAccessBlocked()
            raise SourceFetchFailure("source_fetch_failed", True)
        return result.stdout

    async def resolve(self, source: YouTubeSource, session: BoundProxySession | None, work: Path):
        output = await self._yt_dlp([
            "--format", FORMAT_PREFERENCE, "--skip-download", "--no-simulate", "--write-info-json",
            "--output", str(work / "metadata.%(ext)s"), "--print", "%(id)j", source.url,
        ], session)
        try:
            metadata = work / "metadata.info.json"
            if json.loads(output) != source.media_id or not metadata.is_file() or not 0 < metadata.stat().st_size <= 64 * 1024 * 1024:
                raise ValueError()
            metadata.chmod(0o600)
            facts = json.loads(metadata.read_bytes())
            if facts["id"] != source.media_id:
                raise ValueError()
            formats = facts.get("requested_formats")
            if not isinstance(formats, list):
                formats = [facts]
            audio = next(value for value in formats if value.get("acodec") not in {None, "none", "NA"})
            video = next(value for value in formats if value.get("vcodec") not in {None, "none", "NA"})
            for value in [audio, video]:
                if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,159}", value["format_id"]):
                    raise ValueError()
            language = audio.get("language")
            if language in {None, "NA", ""}:
                language = None
            elif not re.fullmatch(r"[A-Za-z0-9-]{1,32}", language):
                raise ValueError()
            return ResolvedSource(source.media_id, audio["format_id"], video["format_id"], language, metadata)
        except (ValueError, TypeError, KeyError, StopIteration, OSError):
            raise SourceFetchFailure("source_metadata_invalid") from None

    async def _download(self, selected: ResolvedSource, session: BoundProxySession | None, work: Path, audio: bool):
        work.mkdir(parents=True, exist_ok=True)
        format_id = selected.audio_format_id if audio or selected.video_format_id == selected.audio_format_id else f"{selected.video_format_id}+{selected.audio_format_id}"
        args = ["--load-info-json", str(selected.metadata_path), "--format", format_id,
                "--output", str(work / ("audio.%(ext)s" if audio else "video.%(ext)s")), "--print", "after_move:filepath"]
        if audio:
            args += ["--extract-audio", "--audio-format", "best"]
        else:
            args += ["--merge-output-format", "mp4"]
        output = await self._yt_dlp(args, session)
        try:
            path = Path(output.decode().strip()).resolve()
            if not path.is_relative_to(work.resolve()) or not path.is_file() or not 0 < path.stat().st_size <= MAX_SOURCE_BYTES:
                raise ValueError()
            path.chmod(0o400)
            return DownloadedSource(path, selected.media_id, selected.audio_format_id)
        except (ValueError, UnicodeError, OSError):
            raise SourceFetchFailure("source_download_invalid") from None

    async def download_audio(self, selected: ResolvedSource, session: BoundProxySession | None, work: Path):
        return await self._download(selected, session, work, True)

    async def download_video(self, selected: ResolvedSource, session: BoundProxySession | None, work: Path):
        return await self._download(selected, session, work, False)

    async def probe(self, path: Path):
        result = await run_owned_process_async(
            [self._bun, str(self._probe)], input_bytes=json.dumps({"sourcePath": str(path.resolve())}).encode(),
            timeout_seconds=self._remaining(60), env=self._environment(None), on_start=self._start,
            cancel_event=self._cancel,
        )
        try:
            if result.returncode:
                raise ValueError()
            return json.loads(result.stdout)
        except (ValueError, UnicodeError):
            raise SourceFetchFailure("source_probe_failed", True) from None
