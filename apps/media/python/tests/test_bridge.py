import asyncio
import json
from pathlib import Path
import sys
import unittest
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from narriflow_media.bridge import BridgeAsgiApp, BridgeError, ModalBridge, TARGET
from narriflow_media.signing import sign_execution_request

KEY = bytes(range(32))
NOW = 1793440000


class Store:
    def __init__(self):
        self.values = {}
        self.calls = 0

    async def get(self, key):
        self.calls += 1
        return self.values.get(key)

    async def put_if_absent(self, key, value):
        self.calls += 1
        if key in self.values:
            return False
        self.values[key] = value
        return True


class Backend:
    def __init__(self):
        self.spawns, self.cancels, self.statuses = [], [], []
        self.gate = None
        self.unknown = False

    async def spawn(self, function, invocation):
        self.spawns.append((function, invocation))
        if self.gate:
            await self.gate.wait()
        if self.unknown:
            raise TimeoutError()
        return f"fc-public-test-{len(self.spawns)}"

    async def status(self, call_id):
        self.statuses.append(call_id)
        return "pending"

    async def cancel(self, call_id):
        self.cancels.append(call_id)


class BridgeTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.store, self.backend = Store(), Backend()
        self.bridge = ModalBridge(self.store, self.backend, {"public": KEY, "next": bytes([23]) * 64})
        self.reference = {"dispatchId": str(uuid4()), "deploymentEpoch": 1, "generation": 1, "kind": "modal_execution",
                          "subject": {"kind": "ingest_job", "id": str(uuid4())}, "inputHash": "a" * 64}
        self.command = {"action": "spawn", "function": "fetch_source", "reference": self.reference, "attemptToken": str(uuid4())}
        self.delivery = str(uuid4())

    def request(self, command=None, delivery=None, now=NOW, next_key=False):
        body = json.dumps(command or self.command, separators=(",", ":")).encode()
        signature = sign_execution_request(key_id="next" if next_key else "public", key=bytes([23]) * 64 if next_key else KEY,
                                           audience="modal-bridge", method="POST", target=TARGET, body=body,
                                           timestamp=now, delivery_id=delivery or self.delivery)
        return {"body": body, "signature": signature, "now_seconds": now}

    async def test_publication_subject_spawns_once_with_reference_only_authority(self):
        command = {**self.command, "function": "publication", "reference": {
            **self.reference, "subject": {"kind": "social_publication", "id": str(uuid4())}}}
        first = await self.bridge.execute(**self.request(command))
        self.assertEqual(await self.bridge.execute(**self.request(command)), first)
        self.assertEqual(len(self.backend.spawns), 1)
        function, invocation = self.backend.spawns[0]
        self.assertEqual(function, "publication")
        self.assertEqual(invocation["reference"], command["reference"])

    async def test_authentication_precedes_every_lookup_and_refresh_replays_the_receipt(self):
        request = self.request()
        with self.assertRaises(BridgeError) as caught:
            await self.bridge.execute(**{**request, "body": request["body"] + b" "})
        self.assertEqual(caught.exception.status, 401)
        self.assertEqual(self.store.calls, 0)
        result = await self.bridge.execute(**request)
        refreshed = await self.bridge.execute(**self.request(now=NOW + 600, next_key=True))
        self.assertEqual(refreshed, result)
        self.assertEqual(len(self.backend.spawns), 1)
        with self.assertRaises(BridgeError) as caught:
            await self.bridge.execute(**self.request({**self.command, "function": "render_group"}, now=NOW + 600))
        self.assertEqual(caught.exception.code, "bridge_replay_conflict")
        self.assertEqual(len(self.backend.spawns), 1)

    async def test_concurrent_duplicate_waits_for_one_recorded_spawn(self):
        self.backend.gate = asyncio.Event()
        first = asyncio.create_task(self.bridge.execute(**self.request()))
        for _ in range(10):
            await asyncio.sleep(0)
            if self.backend.spawns:
                break
        with self.assertRaises(BridgeError) as caught:
            await self.bridge.execute(**self.request())
        self.assertEqual(caught.exception.code, "bridge_spawn_unconfirmed")
        self.backend.gate.set()
        result = await first
        self.assertEqual(await self.bridge.execute(**self.request()), result)
        self.assertEqual(len(self.backend.spawns), 1)

    async def test_unknown_spawn_can_recover_after_one_slot_without_changing_delivery(self):
        self.backend.unknown = True
        with self.assertRaises(BridgeError):
            await self.bridge.execute(**self.request())
        with self.assertRaises(BridgeError):
            await self.bridge.execute(**self.request())
        self.assertEqual(len(self.backend.spawns), 1)
        self.backend.unknown = False
        result = await self.bridge.execute(**self.request(now=NOW + 60))
        self.assertEqual(result["disposition"], "spawned")
        self.assertEqual(len(self.backend.spawns), 2)
        self.assertEqual(self.backend.spawns[0], self.backend.spawns[1])

    async def test_status_and_cancel_are_bound_to_the_recorded_spawn(self):
        result = await self.bridge.execute(**self.request())
        status = {"action": "status", "reference": self.reference, "attemptToken": self.command["attemptToken"], "spawnDeliveryId": self.delivery}
        observed = await self.bridge.execute(**self.request(status, str(uuid4())))
        self.assertEqual(observed, {"disposition": "observed", "callId": result["callId"], "state": "pending"})
        wrong = {**status, "attemptToken": str(uuid4()), "action": "cancel"}
        with self.assertRaises(BridgeError) as caught:
            await self.bridge.execute(**self.request(wrong, str(uuid4())))
        self.assertEqual(caught.exception.code, "bridge_invocation_mismatch")
        self.assertEqual(self.backend.cancels, [])
        requested = await self.bridge.execute(**self.request({**status, "action": "cancel"}, str(uuid4())))
        self.assertEqual(requested["disposition"], "cancel_requested")
        self.assertEqual(self.backend.cancels, [result["callId"]])

    async def test_asgi_limits_raw_body_and_uses_exact_methods_and_path(self):
        app = BridgeAsgiApp(self.bridge, lambda: NOW)
        async def invoke(body, method="POST", path=TARGET):
            request = self.request()
            scope = {"type": "http", "method": method, "raw_path": path.encode(), "query_string": b"", "headers": [
                (b"content-type", b"application/json"), (b"x-execution-signature", json.dumps(request["signature"]).encode())]}
            async def receive():
                return {"type": "http.request", "body": body}
            messages = []
            await app(scope, receive, lambda message: _append(messages, message))
            return messages[0]["status"]
        self.assertEqual(await invoke(b"x" * (65536 + 1)), 413)
        self.assertEqual(await invoke(b"", method="GET"), 404)
        self.assertEqual(await invoke(b"", path="/other"), 404)
        self.assertEqual(self.store.calls, 0)


async def _append(messages, message):
    messages.append(message)


if __name__ == "__main__":
    unittest.main()
