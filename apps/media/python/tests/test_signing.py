"""Known-answer tests shared with the TypeScript execution protocol."""

import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from narriflow_media.signing import (  # noqa: E402
    ExecutionSignatureError,
    canonical_execution_target,
    sign_execution_request,
    verify_execution_request,
)

VECTORS = json.loads(
    (Path(__file__).resolve().parents[4] / "packages/services/src/execution-signature.vectors.json").read_text()
)["vectors"]


class ExecutionSigningTest(unittest.TestCase):
    def test_frozen_known_answer_vectors(self):
        for vector in VECTORS:
            with self.subTest(vector["name"]):
                request = vector["request"]
                key = bytes.fromhex(vector["keyHex"])
                body = bytes.fromhex(request["bodyHex"])
                signature = sign_execution_request(
                    key_id=request["keyId"], key=key, audience=request["audience"],
                    method=request["method"], target=request["target"], body=body,
                    timestamp=request["timestamp"], delivery_id=request["deliveryId"],
                )
                self.assertEqual(signature, vector["expected"]["metadata"])
                self.assertEqual(
                    verify_execution_request(
                        signature=signature, key_ring={request["keyId"]: key},
                        audience=request["audience"], method=request["method"],
                        target=request["target"], body=body, now_seconds=request["timestamp"],
                    ),
                    vector["expected"],
                )
                self.assertEqual(canonical_execution_target(request["target"]), signature["canonicalTarget"])

    def assert_code(self, code, action, **arguments):
        with self.assertRaises(ExecutionSignatureError) as caught:
            action(**arguments)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(str(caught.exception), code)

    def test_clock_edges_and_tampering(self):
        vector = VECTORS[0]
        request = vector["request"]
        metadata = vector["expected"]["metadata"]
        key = bytes.fromhex(vector["keyHex"])
        body = bytes.fromhex(request["bodyHex"])
        base = dict(signature=metadata, key_ring={request["keyId"]: key}, audience=request["audience"],
                    method=request["method"], target=request["target"], body=body, now_seconds=request["timestamp"])
        for offset in (-300, 300):
            self.assertEqual(verify_execution_request(**{**base, "now_seconds": request["timestamp"] + offset}), vector["expected"])
        for offset in (-301, 301):
            self.assert_code("expired", verify_execution_request, **{**base, "now_seconds": request["timestamp"] + offset})
        cases = [
            ({"body": b'{ "action": "acquire" }'}, "body_mismatch"),
            ({"audience": "modal-bridge"}, "wrong_audience"),
            ({"method": "GET"}, "method_mismatch"),
            ({"target": "/api/execution/other"}, "target_mismatch"),
            ({"target": "/api/execution/command?a=1&a=1&name=%D8%A7%D8%B1%D8%AF%D9%88&space=a+b"}, "target_mismatch"),
            ({"key_ring": {}}, "invalid_key"),
            ({"key_ring": {request["keyId"]: bytes([99]) * 32}}, "signature_mismatch"),
            ({"signature": {**metadata, "keyId": "retired-key"}}, "invalid_key"),
            ({"signature": {**metadata, "deliveryId": "08ff343c-732d-4495-bc11-d2aa5526545f"}}, "signature_mismatch"),
            ({"signature": {**metadata, "timestamp": metadata["timestamp"] + 1}}, "signature_mismatch"),
            ({"signature": {**metadata, "signature": "0" * 64}}, "signature_mismatch"),
            ({"signature": {**metadata, "version": 2}}, "invalid_metadata"),
            ({"signature": {**metadata, "version": True}}, "invalid_metadata"),
            ({"signature": {**metadata, "extra": "unused"}}, "invalid_metadata"),
            ({"signature": {**metadata, "canonicalTarget": request["target"]}}, "target_mismatch"),
            ({"now_seconds": float("nan")}, "invalid_clock"),
            ({"now_seconds": True}, "invalid_clock"),
            ({"body": bytes(65537)}, "body_too_large"),
        ]
        for changes, code in cases:
            with self.subTest(changes=list(changes), code=code):
                self.assert_code(code, verify_execution_request, **{**base, **changes})

    def test_semantic_delivery_hash_survives_fresh_authentication(self):
        vector = VECTORS[0]
        request = vector["request"]
        next_key = bytes([23]) * 64
        body = bytes.fromhex(request["bodyHex"])
        refreshed = sign_execution_request(
            key_id="worker-next", key=next_key, audience=request["audience"],
            method=request["method"], target=request["target"], body=body,
            timestamp=request["timestamp"] + 600, delivery_id=request["deliveryId"],
        )
        result = verify_execution_request(
            signature=refreshed, key_ring={"worker-next": next_key}, audience=request["audience"],
            method=request["method"], target=request["target"], body=body,
            now_seconds=request["timestamp"] + 600,
        )
        self.assertEqual(result["requestHash"], vector["expected"]["requestHash"])
        self.assertNotEqual(refreshed["signature"], vector["expected"]["metadata"]["signature"])

    def test_target_aliases_and_malformed_utf8(self):
        for target in [
            "https://api.example/api/execution/command", "//api/execution", "/api//execution",
            "/api/./command", "/api/../command", "/api/%2e/command", "/api/%2E%2E/command",
            "/api/%2F/command", "/api/%5C/command", "/api/%252f/command", "/api/%61cquire",
            "/api\\execution", "/api/command#fragment", "/api/command\n", "/api/%00/command",
            "/api/command?x=%", "/api/command?x=%C0%AF", "/api/command?x=%ED%A0%80",
            "/api/command?x=%E2%9C", "/api/command?x=raw space",
        ]:
            with self.subTest(target=target):
                self.assert_code("invalid_target", canonical_execution_target, target=target)

    def test_bounded_inputs_and_key_rotation(self):
        vector = VECTORS[0]
        request = vector["request"]
        key = bytes.fromhex(vector["keyHex"])
        body = bytes.fromhex(request["bodyHex"])
        base = dict(key_id=request["keyId"], key=key, audience=request["audience"], method=request["method"],
                    target=request["target"], body=body, timestamp=request["timestamp"], delivery_id=request["deliveryId"])
        for length in (0, 31, 65):
            self.assert_code("invalid_key", sign_execution_request, **{**base, "key": bytes(length)})
        self.assert_code("body_too_large", sign_execution_request, **{**base, "body": bytes(65537)})
        self.assert_code("invalid_metadata", sign_execution_request, **{**base, "method": "post"})
        next_key = bytes([23]) * 64
        next_signature = sign_execution_request(**{**base, "key_id": "worker-next", "key": next_key})
        verification = dict(signature=next_signature, key_ring={request["keyId"]: key, "worker-next": next_key},
                            audience=request["audience"], method=request["method"], target=request["target"],
                            body=body, now_seconds=request["timestamp"])
        self.assertEqual(verify_execution_request(**verification)["metadata"], next_signature)
        old = vector["expected"]["metadata"]
        self.assertEqual(verify_execution_request(**{**verification, "signature": old}), vector["expected"])
        self.assert_code("invalid_key", verify_execution_request,
                         **{**verification, "signature": old, "key_ring": {"worker-next": next_key}})


if __name__ == "__main__":
    unittest.main()
