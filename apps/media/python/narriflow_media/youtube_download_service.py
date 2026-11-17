"""A managed YouTube download service turns a video ID into a one-shot file URL.

The service (an Apify Actor backed by fastsaver.io) absorbs YouTube's bot checks,
so the cloud executor never talks to YouTube. Its link expires within minutes
and allows three opens, so it is fetched once, straight after resolution,
through the same guarded direct-download path as any other remote original.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import json
import logging
import os
from pathlib import Path
import re
from threading import Event
from typing import Awaitable, Callable
from urllib.parse import urlsplit

from .control import ExecutionControlError
from .fetch import SourceFetchFailure
from .process import ChildCancellation, MediaProcessError, run_owned_process_async

ACTOR = "coder2077~youtube-video-downloader"
ENDPOINT = f"https://api.apify.com/v2/acts/{ACTOR}/run-sync-get-dataset-items"
# 1080p matches the yt-dlp route's ceiling; the source is never upscaled.
QUALITY = "1080p"
RESOLVE_SECONDS = 180
MAX_RESPONSE_BYTES = 1024 * 1024

_logger = logging.getLogger(__name__)
Request = Callable[[str, str, float], Awaitable[tuple[int, bytes]]]


@dataclass(frozen=True)
class ServiceDownload:
    url: str = field(repr=False)
    duration_seconds: float | None


def curl_request(*, work: Path, on_start: Callable[[int], None], cancel_event: Event) -> Request:
    """The call runs as an owned process: its spawn confirms the execution start
    (so the lease renews), cancellation stops it, and the token reaches curl
    only on stdin, never in argv or the environment."""
    async def request(token: str, media_id: str, timeout: float) -> tuple[int, bytes]:
        body, output = work / "download-service-request.json", work / "download-service-response.json"
        body.write_text(json.dumps({"urls": [f"https://www.youtube.com/watch?v={media_id}"], "format": QUALITY}))
        environment = {name: os.environ[name] for name in ("PATH", "HOME", "LANG", "SSL_CERT_FILE", "SSL_CERT_DIR") if name in os.environ}
        try:
            result = await run_owned_process_async(
                ["curl", "-q", "--silent", "--proto", "=https", "--max-time", str(int(timeout)),
                 "--max-filesize", str(MAX_RESPONSE_BYTES), "-H", "@-", "-H", "Content-Type: application/json",
                 "-H", "Accept: application/json", "--data-binary", f"@{body}", "-o", str(output),
                 "-w", "%{http_code}", f"{ENDPOINT}?timeout={int(timeout)}"],
                input_bytes=f"Authorization: Bearer {token}\n".encode(), timeout_seconds=timeout + 15,
                kill_grace_seconds=2, env=environment, on_start=on_start, cancel_event=ChildCancellation(cancel_event))
        except MediaProcessError as error:
            if error.code in {"media_process_start_unconfirmed", "media_execution_cancelled"}:
                raise ExecutionControlError("execution_start_unconfirmed" if error.code == "media_process_start_unconfirmed"
                                            else "execution_authority_lost") from None
            raise OSError() from None
        try:
            if result.returncode:
                raise OSError()
            status = int(result.stdout.decode().strip() or 0)
            return status, output.read_bytes()[:MAX_RESPONSE_BYTES + 1] if output.exists() else b""
        except (ValueError, UnicodeError):
            raise OSError() from None
        finally:
            body.unlink(missing_ok=True)
            output.unlink(missing_ok=True)
    return request


def _log(outcome: str, **facts):
    _logger.warning(json.dumps({"level": "info" if outcome == "resolved" else "warn",
                                "message": "youtube_download_service", "outcome": outcome, **facts}))


async def resolve_service_download(token: str, media_id: str, *, timeout: float, request: Request) -> ServiceDownload:
    """Never logs the token, the response body or the file URL."""
    if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,256}", token):
        raise SourceFetchFailure("youtube_download_service_invalid")
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", media_id) or not 0 < timeout <= RESOLVE_SECONDS:
        raise SourceFetchFailure("source_runtime_invalid")
    try:
        status, payload = await request(token, media_id, timeout)
    except (OSError, TimeoutError):
        _log("unreachable")
        raise SourceFetchFailure("source_download_failed", True) from None
    if status not in {200, 201}:
        # 401/403: bad token. 402: no credit. Both need an operator, not a retry.
        _log("refused", status=status)
        raise SourceFetchFailure("source_download_failed", status in {0, 408, 429} or status >= 500)
    try:
        if len(payload) > MAX_RESPONSE_BYTES:
            raise ValueError()
        items = json.loads(payload)
        if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict):
            raise ValueError()
        item = items[0]
    except (ValueError, UnicodeError):
        _log("invalid_response")
        raise SourceFetchFailure("source_download_failed", True) from None
    if item.get("ok") is not True:
        # Private, removed, age-restricted or blocked: the user uploads instead.
        _log("refused_video")
        raise SourceFetchFailure("source_provider_access_denied")
    url, duration = item.get("download_url"), item.get("duration")
    parsed = urlsplit(url) if isinstance(url, str) and len(url) <= 8192 else None
    if (item.get("video_id") != media_id or parsed is None or parsed.scheme != "https" or not parsed.hostname
            or parsed.username or parsed.password or parsed.fragment):
        _log("invalid_response")
        raise SourceFetchFailure("source_download_failed", True)
    if type(duration) not in {int, float} or not 0 < duration < 24 * 60 * 60:
        duration = None
    _log("resolved", host=parsed.hostname)
    return ServiceDownload(url, duration)
