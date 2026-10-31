"""Finite signed notification POST; body download and assigned upload are caller-owned."""
from __future__ import annotations

import json
import os
from pathlib import Path
import stat
from threading import Event
from typing import Callable

from .process import run_owned_process_async


class CallbackDeliveryFailure(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


async def run_callback_delivery(command: dict, body_path: Path, work: Path, *,
                                on_process_start: Callable[[int], None], cancel_event: Event,
                                bun_executable: str = "bun") -> Path:
    if type(command) is not dict or command.get("kind") != "signed_notification":
        raise CallbackDeliveryFailure("outbound_command_invalid")
    output = work.resolve() / "notification-receipt.json"
    environment = {name: os.environ[name] for name in (
        "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "SSL_CERT_FILE", "SSL_CERT_DIR",
    ) if name in os.environ}
    for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]:
        environment[name] = ""
    result = await run_owned_process_async(
        [bun_executable, str(Path(__file__).resolve().parents[2] / "src/callback-delivery-cli.ts")],
        input_bytes=json.dumps({"command": command, "bodyPath": str(body_path), "outputPath": str(output)}, separators=(",", ":")).encode(),
        timeout_seconds=35, kill_grace_seconds=5, max_file_bytes=65536, env=environment,
        on_start=on_process_start, cancel_event=cancel_event,
    )
    if result.returncode:
        raise CallbackDeliveryFailure("outbound_delivery_failed")
    try:
        receipt = json.loads(result.stdout)
        info = output.lstat()
        if receipt != {"completed": True} or not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= 65536:
            raise ValueError()
        output.chmod(0o600)
    except (OSError, ValueError, TypeError):
        raise CallbackDeliveryFailure("outbound_receipt_invalid") from None
    return output
