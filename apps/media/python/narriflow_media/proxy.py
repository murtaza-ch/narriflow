"""One proxy exit is shared by extraction and every transfer of an attempt.

An import tries fixed ISP addresses first, then rotating sticky sessions.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import ipaddress
import random
import re
from urllib.parse import quote, unquote, urlsplit, urlunsplit

MAX_STATIC_PROXIES = 5
ROTATING_SESSIONS = 3
_SESSION_PLACEHOLDER = re.compile(r"\{session\}|%7bsession%7d", re.IGNORECASE)


class ProxyConfigurationError(ValueError):
    def __init__(self):
        super().__init__("youtube_proxy_invalid")
        self.code = "youtube_proxy_invalid"


@dataclass(frozen=True)
class BoundProxySession:
    session_id: str
    _url: str = field(repr=False)
    # A safe label for logs: static-N in configuration order, or rotating-N.
    route: str = "rotating"

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


def _validated_template(template: str, *, rotating: bool) -> str:
    """Shape checks shared by both kinds. A rotating template must carry the
    session placeholder in its credentials; a fixed address must not."""
    if not isinstance(template, str) or not 1 <= len(template) <= 2048:
        raise ValueError()
    if any(ord(char) <= 32 or ord(char) >= 127 for char in template):
        raise ValueError()
    initial = urlsplit(template)
    if initial.scheme != "http" or not initial.hostname or initial.path not in {"", "/"} or initial.query or initial.fragment:
        raise ValueError()
    credentials = f"{initial.username or ''}:{initial.password or ''}"
    if rotating and not _SESSION_PLACEHOLDER.search(credentials):
        raise ValueError()
    if not rotating and _SESSION_PLACEHOLDER.search(template):
        raise ValueError()
    return template


def _normalized(candidate: str) -> str:
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
    return urlunsplit(("http", f"{credentials}@{host}" if credentials else host, "", "", ""))


def bind_proxy_session(template: str, session_id: str, route: str = "rotating") -> BoundProxySession:
    """Validate before substitution; URL parser exceptions never expose credentials."""
    try:
        if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,64}", session_id):
            raise ValueError()
        _validated_template(template, rotating=True)
        return BoundProxySession(session_id, _normalized(_SESSION_PLACEHOLDER.sub(session_id, template)), route)
    except (TypeError, ValueError, UnicodeError):
        raise ProxyConfigurationError() from None


def bind_static_proxy(url: str, label: str) -> BoundProxySession:
    """A fixed ISP address: the same exit for every request, no placeholder.
    It has no provider session, so its label doubles as its identity."""
    try:
        if not isinstance(label, str) or not re.fullmatch(r"static-[1-9]", label):
            raise ValueError()
        return BoundProxySession(label, _normalized(_validated_template(url, rotating=False)), label)
    except (TypeError, ValueError, UnicodeError):
        raise ProxyConfigurationError() from None


def _exit_identity(url: str) -> tuple:
    """Two spellings of one address are the same exit: default port, host
    case and IP literal forms do not make a second route."""
    parsed = urlsplit(url)
    host = (parsed.hostname or "").lower()
    try:
        host = ipaddress.ip_address(host).compressed
    except ValueError:
        pass
    return parsed.username, parsed.password, host, parsed.port or 80


def proxy_routes(*, static_urls: str | None, rotating_template: str | None,
                 start: int | None = None) -> list[BoundProxySession]:
    """The ordered exits one import may try, validated before any work starts.

    Fixed addresses come first, each once, from a random starting point so
    imports spread across the pool. Up to three rotating sessions follow when
    a rotating proxy is configured. A new exit always means new extraction.
    """
    if static_urls is not None and not isinstance(static_urls, str):
        raise ProxyConfigurationError()
    values = [value.strip() for value in static_urls.split(",")] if static_urls and static_urls.strip() else []
    # An empty entry is a typo in the secret, not a request for fewer exits.
    if "" in values or len(values) > MAX_STATIC_PROXIES:
        raise ProxyConfigurationError()
    statics = [bind_static_proxy(value, f"static-{index + 1}") for index, value in enumerate(values)]
    if len({_exit_identity(route.url) for route in statics}) != len(statics):
        raise ProxyConfigurationError()
    if statics:
        offset = (random.randrange(len(statics)) if start is None else start) % len(statics)
        statics = statics[offset:] + statics[:offset]
    if not rotating_template:
        return statics
    from uuid import uuid4

    return statics + [bind_proxy_session(rotating_template, uuid4().hex, f"rotating-{index + 1}")
                      for index in range(ROTATING_SESSIONS)]
