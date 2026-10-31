"""Reference-only transport bridge. Durable receipts confer no execution authority."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import hashlib
import json
import math
import re
from typing import Any, Mapping, Protocol

from .signing import COMMAND_MAX_BYTES, ExecutionSignatureError, verify_execution_request

TARGET = "/bridge/command"
_UUID = re.compile(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}")
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,159}")
_CALL = re.compile(r"fc-[A-Za-z0-9_-]{1,160}")
_SUBJECTS = {"ingest_job", "workflow_run", "render_group", "clip_preparation", "dubbing", "export_bundle", "generated_media", "thumbnail_frame", "native_validation", "outbound_probe", "completion_callback", "webhook_subscription"}


class BridgeError(RuntimeError):
    def __init__(self, code: str, status: int = 503):
        super().__init__(code)
        self.code, self.status = code, status


class BridgeStore(Protocol):
    async def get(self, key: str) -> dict | None: ...
    async def put_if_absent(self, key: str, value: dict) -> bool: ...


class BridgeBackend(Protocol):
    async def spawn(self, function: str, invocation: dict) -> str: ...
    async def status(self, call_id: str) -> str: ...
    async def cancel(self, call_id: str) -> None: ...


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()


def _parse(body: bytes) -> dict:
    try:
        command = json.loads(body.decode("utf-8"))
        if type(command) is not dict or command.get("action") not in {"spawn", "status", "cancel"}:
            raise ValueError()
        fields = {"action", "reference", "attemptToken", "function" if command["action"] == "spawn" else "spawnDeliveryId"}
        if set(command) != fields or not isinstance(command["attemptToken"], str) or not _UUID.fullmatch(command["attemptToken"]):
            raise ValueError()
        reference = command["reference"]
        if type(reference) is not dict or set(reference) != {"dispatchId", "deploymentEpoch", "kind", "subject", "generation", "inputHash"}:
            raise ValueError()
        if not isinstance(reference["dispatchId"], str) or not _UUID.fullmatch(reference["dispatchId"]) or reference["kind"] != "modal_execution":
            raise ValueError()
        if any(type(reference[key]) is not int or not 0 < reference[key] <= 2147483647 for key in ("deploymentEpoch", "generation")):
            raise ValueError()
        if not isinstance(reference["inputHash"], str) or not re.fullmatch(r"[a-f0-9]{64}", reference["inputHash"]):
            raise ValueError()
        subject = reference["subject"]
        if type(subject) is not dict or set(subject) != {"kind", "id"} or subject["kind"] not in _SUBJECTS or not isinstance(subject["id"], str) or not _ID.fullmatch(subject["id"]):
            raise ValueError()
        if command["action"] == "spawn":
            if not isinstance(command["function"], str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,39}", command["function"]):
                raise ValueError()
        elif not isinstance(command["spawnDeliveryId"], str) or not _UUID.fullmatch(command["spawnDeliveryId"]):
            raise ValueError()
        return command
    except (ValueError, TypeError, KeyError, UnicodeError):
        raise BridgeError("bridge_command_invalid", 400) from None


@dataclass(frozen=True)
class ModalBridge:
    store: BridgeStore
    backend: BridgeBackend
    key_ring: Mapping[str, bytes]
    timeout_seconds: float = 10
    retry_slot_seconds: int = 30

    async def execute(self, *, body: bytes, signature: object, now_seconds: int) -> dict:
        # Authentication precedes every durable lookup, including exact replay.
        try:
            verified = verify_execution_request(signature=signature, key_ring=self.key_ring, audience="modal-bridge",
                                                method="POST", target=TARGET, body=body, now_seconds=now_seconds)
        except ExecutionSignatureError:
            raise BridgeError("bridge_signature_invalid", 401) from None
        command = _parse(body)
        if not 0 < self.timeout_seconds <= 15 or not self.retry_slot_seconds >= 2 * self.timeout_seconds:
            raise BridgeError("bridge_configuration_invalid")
        delivery = verified["metadata"]["deliveryId"]
        request_hash = verified["requestHash"]
        intent_key, receipt_key = f"intent:{delivery}", f"receipt:{delivery}"
        await self.store.put_if_absent(intent_key, {"requestHash": request_hash})
        intent = await self.store.get(intent_key)
        if not intent or intent.get("requestHash") != request_hash:
            raise BridgeError("bridge_replay_conflict", 409)
        prior = await self.store.get(receipt_key)
        if prior is not None:
            return prior["disposition"]
        invocation = {"reference": command["reference"], "attemptToken": command["attemptToken"]}
        invocation_hash = _digest(invocation)
        action = command["action"]
        try:
            if action == "spawn":
                # Immutable intent rejects changed content before spawning. A bounded
                # slot limits simultaneous retries; a later slot repairs a crashed
                # bridge or unknown spawn acknowledgement. The heavy invocation must
                # still acquire one random owner through the control API.
                slot = math.floor(now_seconds / self.retry_slot_seconds)
                claimed = await self.store.put_if_absent(f"spawn:{delivery}:{slot}", {"requestHash": request_hash})
                if not claimed:
                    prior = await self.store.get(receipt_key)
                    if prior is not None:
                        return prior["disposition"]
                    raise BridgeError("bridge_spawn_unconfirmed")
                call_id = await asyncio.wait_for(self.backend.spawn(command["function"], invocation), self.timeout_seconds)
                if not isinstance(call_id, str) or not _CALL.fullmatch(call_id):
                    raise BridgeError("bridge_spawn_unconfirmed")
                disposition = {"disposition": "spawned", "callId": call_id}
            else:
                source = await self.store.get(f"receipt:{command['spawnDeliveryId']}")
                if source is None:
                    raise BridgeError("bridge_spawn_unconfirmed")
                if source.get("invocationHash") != invocation_hash or source.get("disposition", {}).get("disposition") != "spawned":
                    raise BridgeError("bridge_invocation_mismatch", 409)
                call_id = source["disposition"]["callId"]
                if action == "status":
                    state = await asyncio.wait_for(self.backend.status(call_id), self.timeout_seconds)
                    if state not in {"pending", "succeeded", "failed", "cancelled", "unknown"}:
                        raise BridgeError("bridge_status_unavailable")
                    disposition = {"disposition": "observed", "callId": call_id, "state": state}
                else:
                    await asyncio.wait_for(self.backend.cancel(call_id), self.timeout_seconds)
                    disposition = {"disposition": "cancel_requested", "callId": call_id}
        except BridgeError:
            raise
        except Exception:
            raise BridgeError("bridge_provider_unavailable") from None
        receipt = {"invocationHash": invocation_hash, "disposition": disposition}
        await self.store.put_if_absent(receipt_key, receipt)
        winner = await self.store.get(receipt_key)
        if winner is None:
            raise BridgeError("bridge_receipt_unconfirmed")
        return winner["disposition"]


class BridgeAsgiApp:
    """No FastAPI dependency or JSON parsing before raw-body signature checks."""
    def __init__(self, bridge: ModalBridge, clock):
        self.bridge, self.clock = bridge, clock

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        if scope["type"] != "http":
            return
        try:
            if scope.get("method") != "POST" or scope.get("raw_path", scope.get("path", "").encode()) != TARGET.encode() or scope.get("query_string", b""):
                raise BridgeError("bridge_route_not_found", 404)
            headers = {key.lower(): value for key, value in scope.get("headers", [])}
            if not headers.get(b"content-type", b"").split(b";", 1)[0].strip().lower() == b"application/json":
                raise BridgeError("bridge_media_type_invalid", 415)
            metadata = headers.get(b"x-execution-signature", b"")
            if len(metadata) > 4096 or not metadata:
                raise BridgeError("bridge_signature_invalid", 401)
            chunks, size = [], 0
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                chunk = message.get("body", b"")
                size += len(chunk)
                if size > COMMAND_MAX_BYTES:
                    raise BridgeError("bridge_command_too_large", 413)
                chunks.append(chunk)
                if not message.get("more_body"):
                    break
            try:
                signature = json.loads(metadata)
            except (ValueError, UnicodeError):
                raise BridgeError("bridge_signature_invalid", 401) from None
            result = await self.bridge.execute(body=b"".join(chunks), signature=signature, now_seconds=int(self.clock()))
            status = 200
        except BridgeError as error:
            result, status = {"error": {"code": error.code}}, error.status
        except Exception:
            result, status = {"error": {"code": "bridge_unavailable"}}, 503
        body = json.dumps(result, separators=(",", ":")).encode()
        await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json"), (b"cache-control", b"no-store")]})
        await send({"type": "http.response.body", "body": body})
