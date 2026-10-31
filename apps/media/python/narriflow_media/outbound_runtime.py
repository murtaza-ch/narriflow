"""Finite native RSS probe. The caller owns lease checks and assigned uploads."""
from __future__ import annotations

import json
import os
from pathlib import Path
import stat
from threading import Event
from typing import Callable

from .process import run_owned_process_async

MAX_RESULT_BYTES = 4 * 1024 * 1024


class OutboundProbeFailure(RuntimeError):
    def __init__(self, code: str, retryable: bool = False):
        super().__init__(code)
        self.code, self.retryable = code, retryable


async def run_rss_probe(command: dict, work: Path, *, on_process_start: Callable[[int], None],
                        cancel_event: Event, bun_executable: str = "bun") -> Path:
    """Only a server-frozen RSS command is accepted, never an arbitrary HTTP tunnel."""
    if (type(command) is not dict or set(command) != {"kind", "url", "etag", "lastModified"}
            or command.get("kind") != "rss_feed" or not isinstance(command.get("url"), str)):
        raise OutboundProbeFailure("outbound_command_invalid")
    output = work.resolve() / "rss-result.json"
    environment = {name: os.environ[name] for name in (
        "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "SSL_CERT_FILE", "SSL_CERT_DIR",
    ) if name in os.environ}
    # Socket ownership is native/pinned; environment proxies must never resolve again.
    for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]:
        environment[name] = ""
    result = await run_owned_process_async(
        [bun_executable, str(Path(__file__).resolve().parents[2] / "src/outbound-rss-cli.ts")],
        input_bytes=json.dumps({"input": command, "outputPath": str(output)}, separators=(",", ":")).encode(),
        timeout_seconds=35, kill_grace_seconds=5, max_file_bytes=MAX_RESULT_BYTES,
        on_start=on_process_start, cancel_event=cancel_event, env=environment,
    )
    if result.returncode:
        try:
            failure = json.loads(result.stderr)
            code = failure["errorCode"]
            if code not in {"remote_url_unsafe", "remote_download_failed", "remote_fetch_timeout", "remote_redirect_invalid", "remote_redirect_limit", "remote_response_too_large", "rss_invalid_xml", "rss_no_media_episodes", "rss_unsupported_document"}:
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            code = "outbound_request_failed"
        raise OutboundProbeFailure(code, code in {"remote_download_failed", "remote_fetch_timeout"})
    try:
        receipt = json.loads(result.stdout)
        metadata = output.lstat()
        if (set(receipt) != {"byteLength"} or type(receipt["byteLength"]) is not int
                or not stat.S_ISREG(metadata.st_mode) or not 0 < metadata.st_size <= MAX_RESULT_BYTES
                or metadata.st_size != receipt["byteLength"]):
            raise ValueError()
        output.chmod(0o600)
    except (OSError, ValueError, KeyError, TypeError):
        raise OutboundProbeFailure("outbound_result_invalid") from None
    return output
