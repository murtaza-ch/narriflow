"""A managed YouTube download service turns a video ID into a one-shot file URL.

The service (an Apify Actor backed by fastsaver.io) absorbs YouTube's bot checks,
so the cloud executor never talks to YouTube. Its link expires within minutes
and allows few opens, so it is fetched once, straight after resolution, through
the same guarded direct-download path as any other remote original.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import json
import logging
import re
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from .fetch import SourceFetchFailure

ACTOR = "coder2077~youtube-video-downloader"
ENDPOINT = f"https://api.apify.com/v2/acts/{ACTOR}/run-sync-get-dataset-items"
# 1080p matches the yt-dlp route's ceiling; the source is never upscaled.
QUALITY = "1080p"
RESOLVE_SECONDS = 180

_logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ServiceDownload:
    url: str = field(repr=False)
    duration_seconds: float | None


def _token(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,256}", value):
        raise SourceFetchFailure("youtube_download_service_invalid")
    return value


def _request(token: str, media_id: str, timeout: float) -> tuple[int, bytes]:
    body = json.dumps({"urls": [f"https://www.youtube.com/watch?v={media_id}"], "format": QUALITY}).encode()
    request = urllib.request.Request(f"{ENDPOINT}?timeout={int(timeout)}", data=body, method="POST", headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout + 15) as response:
            return response.status, response.read(1024 * 1024 + 1)
    except urllib.error.HTTPError as error:
        return error.code, b""


def _log(outcome: str, **facts):
    _logger.warning(json.dumps({"level": "info" if outcome == "resolved" else "warn",
                                "message": "youtube_download_service", "outcome": outcome, **facts}))


async def resolve_service_download(token: str, media_id: str, *, timeout: float = RESOLVE_SECONDS,
                                   request=_request) -> ServiceDownload:
    """Never logs the token, the response body or the file URL."""
    token = _token(token)
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", media_id) or not 0 < timeout <= RESOLVE_SECONDS:
        raise SourceFetchFailure("source_runtime_invalid")
    try:
        status, payload = await asyncio.to_thread(request, token, media_id, timeout)
    except (OSError, TimeoutError):
        _log("unreachable")
        raise SourceFetchFailure("source_download_failed", True) from None
    if status != 201 and status != 200:
        # 401/403: bad token. 402: no credit. Both need an operator, not a retry.
        _log("refused", status=status)
        raise SourceFetchFailure("source_download_failed", status == 408 or status == 429 or status >= 500)
    try:
        if len(payload) > 1024 * 1024:
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
