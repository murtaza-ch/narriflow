"""One sticky HTTP proxy session is shared by extraction and every transfer."""
from __future__ import annotations

from dataclasses import dataclass, field
import re
from urllib.parse import quote, unquote, urlsplit, urlunsplit


class ProxyConfigurationError(ValueError):
    def __init__(self):
        super().__init__("youtube_proxy_invalid")
        self.code = "youtube_proxy_invalid"


@dataclass(frozen=True)
class BoundProxySession:
    session_id: str
    _url: str = field(repr=False)

    @property
    def url(self) -> str:
        """Transport only. Never include this value in diagnostics or manifests."""
        return self._url

    def environment(self) -> dict[str, str]:
        # Deno fetch and the token helper's upstream client honor these keys.
        # The helper itself is reachable only on the job's loopback endpoint.
        return {
            "HTTP_PROXY": self._url, "HTTPS_PROXY": self._url, "ALL_PROXY": self._url,
            "http_proxy": self._url, "https_proxy": self._url, "all_proxy": self._url,
            "NO_PROXY": "127.0.0.1,localhost,::1", "no_proxy": "127.0.0.1,localhost,::1",
        }

    def yt_dlp_arguments(self) -> list[str]:
        return ["--proxy", self._url, "--external-downloader-args", f"ffmpeg_i:-http_proxy {self._url}"]


def bind_proxy_session(template: str, session_id: str) -> BoundProxySession:
    """Validate before substitution; URL parser exceptions never expose credentials."""
    try:
        if not isinstance(template, str) or not 1 <= len(template) <= 2048:
            raise ValueError()
        if not re.fullmatch(r"[A-Za-z0-9_-]{16,64}", session_id):
            raise ValueError()
        if any(ord(char) <= 32 or ord(char) >= 127 for char in template):
            raise ValueError()
        initial = urlsplit(template)
        if initial.scheme != "http" or not initial.hostname or initial.path not in {"", "/"} or initial.query or initial.fragment:
            raise ValueError()
        credentials = f"{initial.username or ''}:{initial.password or ''}"
        if not re.search(r"\{session\}|%7bsession%7d", credentials, re.IGNORECASE):
            raise ValueError()
        candidate = re.sub(r"\{session\}|%7bsession%7d", session_id, template, flags=re.IGNORECASE)
        parsed = urlsplit(candidate)
        port = parsed.port
        if port is not None and not 1 <= port <= 65535:
            raise ValueError()
        host = parsed.hostname
        if not host or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-:" for char in host):
            raise ValueError()
        host = f"[{host}]" if ":" in host else host
        if port is not None:
            host += f":{port}"
        username = quote(unquote(parsed.username or ""), safe="-._~")
        password = quote(unquote(parsed.password or ""), safe="-._~")
        credentials = username + (f":{password}" if parsed.password is not None else "")
        normalized = urlunsplit(("http", f"{credentials}@{host}", "", "", ""))
        return BoundProxySession(session_id, normalized)
    except (TypeError, ValueError, UnicodeError):
        raise ProxyConfigurationError() from None


class ProxySessionLimitError(RuntimeError):
    def __init__(self):
        super().__init__("source_provider_access_denied")
        self.code = "source_provider_access_denied"


class ProxySessionSequence:
    """A new exit requires new extraction. A fourth session is never issued."""

    def __init__(self, template: str):
        bind_proxy_session(template, "0" * 32)
        self._template = template
        self._issued = 0

    def next(self) -> BoundProxySession:
        from uuid import uuid4

        if self._issued == 3:
            raise ProxySessionLimitError()
        self._issued += 1
        return bind_proxy_session(self._template, uuid4().hex)
