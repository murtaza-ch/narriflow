"""Modal SDK adapters for the reference-only bridge. No domain or SQL access."""
from __future__ import annotations

import base64
import json
from typing import Any, Mapping

from .bridge import BridgeError


class ModalDictStore:
    def __init__(self, dictionary):
        self.dictionary = dictionary

    async def get(self, key: str) -> dict | None:
        result = await self.dictionary.get.aio(key, None)
        if result is not None and type(result) is not dict:
            raise BridgeError("bridge_receipt_invalid")
        return result

    async def put_if_absent(self, key: str, value: dict) -> bool:
        return await self.dictionary.put.aio(key, value, skip_if_exists=True)


class ModalBackend:
    def __init__(self, modal_module, functions: Mapping[str, Any]):
        self.modal, self.functions = modal_module, functions

    async def spawn(self, function: str, invocation: dict) -> str:
        handler = self.functions.get(function)
        if handler is None:
            raise BridgeError("bridge_function_unavailable")
        call = await handler.spawn.aio(invocation)
        return call.object_id

    async def status(self, call_id: str) -> str:
        call = await self.modal.FunctionCall.from_id.aio(call_id)
        # Observe platform status without loading native results, artifact bytes,
        # captions or provider errors into the control function.
        graph = await call.get_call_graph.aio()
        roots = [node for node in graph if node.function_call_id == call_id]
        if not roots:
            return "unknown"
        state = roots[0].status.name
        return {"PENDING": "pending", "SUCCESS": "succeeded", "FAILURE": "failed", "INIT_FAILURE": "failed",
                "TIMEOUT": "failed", "TERMINATED": "cancelled"}.get(state, "unknown")

    async def cancel(self, call_id: str) -> None:
        call = await self.modal.FunctionCall.from_id.aio(call_id)
        await call.cancel.aio(terminate_containers=True)


def parse_bridge_keys(encoded: str) -> dict[str, bytes]:
    try:
        values = json.loads(encoded)
        if type(values) is not dict or not 1 <= len(values) <= 8:
            raise ValueError()
        result = {}
        for key_id, value in values.items():
            import re
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", key_id) or not isinstance(value, str):
                raise ValueError()
            decoded = base64.b64decode(value, validate=True)
            if not 32 <= len(decoded) <= 64:
                raise ValueError()
            result[key_id] = decoded
        return result
    except (ValueError, TypeError, UnicodeError):
        raise BridgeError("bridge_configuration_invalid") from None
