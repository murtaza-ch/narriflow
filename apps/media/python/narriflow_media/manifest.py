"""Compact source facts derived from the single normalized TypeScript probe."""
from __future__ import annotations

from dataclasses import dataclass
import json
import math
from pathlib import Path
import re
from typing import Any, Mapping
from urllib.parse import parse_qs, urlsplit

MAX_SOURCE_BYTES = 10 * 1024 ** 3


class SourceManifestError(ValueError):
    def __init__(self, code: str = "source_manifest_invalid"):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class MediaSource:
    provider: str
    media_id: str

    def __post_init__(self):
        if (not isinstance(self.provider,str) or self.provider not in {'youtube','upload','rss','direct','drive','zoom'}
                or not isinstance(self.media_id,str) or not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9._:-]{0,159}',self.media_id)
                or self.provider=='youtube' and not re.fullmatch(r'[A-Za-z0-9_-]{11}',self.media_id)):
            raise SourceManifestError('source_url_unsupported')


@dataclass(frozen=True)
class YouTubeSource:
    media_id: str

    def __post_init__(self):
        if not isinstance(self.media_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{11}", self.media_id):
            raise SourceManifestError("source_url_unsupported")

    @property
    def provider(self) -> str:
        return "youtube"

    @property
    def url(self) -> str:
        return f"https://www.youtube.com/watch?v={self.media_id}"


def normalize_youtube_source(value: str) -> YouTubeSource:
    try:
        if not isinstance(value, str) or len(value) > 2048 or any(ord(char) <= 32 for char in value):
            raise ValueError()
        if re.fullmatch(r"[A-Za-z0-9_-]{11}", value):
            return YouTubeSource(value)
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or parsed.username is not None or parsed.password is not None:
            raise ValueError()
        if parsed.port not in {None, 443 if parsed.scheme == "https" else 80}:
            raise ValueError()
        host = parsed.hostname
        path = parsed.path.strip("/").split("/")
        if host == "youtu.be" and len(path) == 1:
            media_id = path[0]
        elif host in {"youtube.com", "www.youtube.com", "m.youtube.com"}:
            if parsed.path == "/watch":
                ids = parse_qs(parsed.query).get("v", [])
                if len(ids) != 1:
                    raise ValueError()
                media_id = ids[0]
            elif len(path) == 2 and path[0] in {"shorts", "embed", "live"}:
                media_id = path[1]
            else:
                raise ValueError()
        else:
            raise ValueError()
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", media_id):
            raise ValueError()
        return YouTubeSource(media_id)
    except (ValueError, TypeError, UnicodeError):
        raise SourceManifestError("source_url_unsupported") from None


def toolchain_versions() -> dict[str, str]:
    """Declared release versions, never a claim that an unchecked host matches."""
    lock = json.loads((Path(__file__).resolve().parents[2] / "runtime-lock.json").read_text())
    linux = lock["platforms"]["linux-x64"]
    versions = {wheel["name"]: wheel["version"] for wheel in linux["python"]["wheels"]}
    versions.update(python=linux["python"]["version"], bun=lock["images"]["bun"]["ref"].rsplit(":", 1)[1],
                    ffmpeg=linux["ffmpeg"]["versionString"])
    return versions


def build_audio_manifest(
    *, source: YouTubeSource | MediaSource, source_revision: int, audio_format_id: str,
    language: str | None, probe: Mapping[str, Any], byte_length: int,
    sha256: str, toolchain_fingerprint: str,
) -> dict[str, Any]:
    """Object identity is added by the scoped sink after upload and HEAD verification."""
    try:
        if type(source_revision) is not int or not 0 < source_revision <= 2 ** 53 - 1:
            raise ValueError()
        if type(byte_length) is not int or not 0 < byte_length <= MAX_SOURCE_BYTES:
            raise ValueError()
        if not re.fullmatch(r"[a-f0-9]{64}", sha256) or not re.fullmatch(r"[a-f0-9]{64}", toolchain_fingerprint):
            raise ValueError()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,159}", audio_format_id):
            raise ValueError()
        if language is not None and not re.fullmatch(r"[A-Za-z0-9-]{1,32}", language):
            raise ValueError()
        probe_version = probe["probeVersion"]
        if not isinstance(probe_version, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,159}", probe_version):
            raise ValueError()
        duration = probe["durationSec"]
        if type(duration) not in {int, float} or not math.isfinite(duration) or duration <= 0 or probe["hasAudio"] is not True:
            raise ValueError()
        audio = probe["facts"]["audios"][0]
        codec, rate, channels = audio["codec"], audio["sampleRate"], audio["channels"]
        if not isinstance(codec, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", codec):
            raise ValueError()
        if type(rate) is not int or not 0 < rate <= 768000 or type(channels) is not int or not 0 < channels <= 64:
            raise ValueError()
        start = audio["startTimeSec"]
        if start is None:
            start = 0
        if type(start) not in {int, float} or not math.isfinite(start):
            raise ValueError()
        return {
            "sourceRevision": source_revision,
            "mediaIdentity": {"provider": source.provider, "mediaId": source.media_id},
            "audioTrack": {"id": audio_format_id, "language": language, "codec": codec, "sampleRate": rate, "channels": channels},
            "byteLength": byte_length, "sha256": sha256,
            "durationSeconds": duration, "wholeSource": True, "audioStartTimeSec": start,
            "probeVersion": probe_version, "toolchainFingerprint": toolchain_fingerprint,
        }
    except (KeyError, IndexError, TypeError, ValueError):
        raise SourceManifestError() from None
