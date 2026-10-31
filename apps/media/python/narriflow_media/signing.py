"""Version-one execution request signatures. No environment, clock or platform state."""

from collections.abc import Mapping
import hashlib
import hmac
import re
from urllib.parse import quote, unquote_to_bytes

COMMAND_MAX_BYTES = 64 * 1024
SIGNATURE_MAX_AGE_SECONDS = 300
_MAX_SAFE_INTEGER = 9007199254740991
_AUDIENCES = ("modal-bridge", "executor-control", "dev-device")
_METHODS = ("GET", "POST")
_FIELDS = (
    "version", "keyId", "audience", "method", "canonicalTarget",
    "bodySha256", "timestamp", "deliveryId",
)
_UUID = re.compile(
    r"(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
    r"|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)"
)


class ExecutionSignatureError(ValueError):
    """Identifier-only errors never include a request body, signature or key."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _encode(value: str) -> str:
    return quote(value, safe="-._~", encoding="utf-8", errors="strict")


def _decode(value: str) -> str:
    if re.search(r"%(?![0-9a-fA-F]{2})", value):
        raise ExecutionSignatureError("invalid_target")
    return unquote_to_bytes(value).decode("utf-8", errors="strict")


def canonical_execution_target(target: str) -> str:
    """Validate paths before a URL parser can normalize them; retain query pairs."""
    try:
        if (not isinstance(target, str) or len(target) > 2048
                or not target.startswith("/") or re.search(r"[^\x21-\x7e]|[#\\]", target)):
            raise ExecutionSignatureError("invalid_target")
        path, separator, query = target.partition("?")
        if "//" in path:
            raise ExecutionSignatureError("invalid_target")
        for segment in path[1:].split("/"):
            decoded = _decode(segment)
            if (decoded in (".", "..") or re.search(r"[/%\\?#\x00-\x20\x7f]", decoded)
                    or _encode(decoded) != segment):
                raise ExecutionSignatureError("invalid_target")
        pairs = []
        if separator:
            for entry in query.split("&"):
                if not entry:
                    continue
                name, _, value = entry.partition("=")
                pairs.append((_decode(name.replace("+", " ")), _decode(value.replace("+", " "))))
        pairs.sort(key=lambda pair: (pair[0].encode("utf-8"), pair[1].encode("utf-8")))
        canonical_query = "&".join(f"{_encode(name)}={_encode(value)}" for name, value in pairs)
        canonical = path + (f"?{canonical_query}" if canonical_query else "")
        if len(canonical) > 2048:
            raise ExecutionSignatureError("invalid_target")
        return canonical
    except ExecutionSignatureError:
        raise
    except (ValueError, UnicodeError, TypeError):
        raise ExecutionSignatureError("invalid_target") from None


def _key_bytes(value: bytes) -> bytes:
    if not isinstance(value, (bytes, bytearray)) or not 32 <= len(value) <= 64:
        raise ExecutionSignatureError("invalid_key")
    return bytes(value)


def _body_bytes(value: bytes) -> bytes:
    if not isinstance(value, (bytes, bytearray)):
        raise ExecutionSignatureError("invalid_metadata")
    if len(value) > COMMAND_MAX_BYTES:
        raise ExecutionSignatureError("body_too_large")
    return bytes(value)


def _positive_safe_integer(value: object) -> bool:
    return type(value) is int and 0 < value <= _MAX_SAFE_INTEGER


def _metadata(value: object) -> dict:
    if type(value) is not dict or set(value) != set(_FIELDS) | {"signature"}:
        raise ExecutionSignatureError("invalid_metadata")
    checks = (
        type(value["version"]) is int and value["version"] == 1,
        isinstance(value["keyId"], str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value["keyId"]),
        value["audience"] in _AUDIENCES,
        value["method"] in _METHODS,
        isinstance(value["canonicalTarget"], str) and len(value["canonicalTarget"]) <= 2048
        and re.fullmatch(r"/(?!/)[\x21-\x22\x24-\x7e]*", value["canonicalTarget"]),
        isinstance(value["bodySha256"], str) and re.fullmatch(r"[a-f0-9]{64}", value["bodySha256"]),
        _positive_safe_integer(value["timestamp"]),
        isinstance(value["deliveryId"], str) and _UUID.fullmatch(value["deliveryId"]),
        isinstance(value["signature"], str) and re.fullmatch(r"[a-f0-9]{64}", value["signature"]),
    )
    if not all(checks):
        raise ExecutionSignatureError("invalid_metadata")
    return dict(value)


def _message(metadata: dict) -> bytes:
    return "\n".join(str(metadata[field]) for field in _FIELDS).encode("utf-8")


def sign_execution_request(
    *, key_id: str, key: bytes, audience: str, method: str, target: str,
    body: bytes, timestamp: int, delivery_id: str,
) -> dict:
    """Sign exact bytes and injected metadata; caller supplies a unique delivery ID."""
    key_bytes = _key_bytes(key)
    body_bytes = _body_bytes(body)
    canonical_target = canonical_execution_target(target)
    metadata = _metadata({
        "version": 1, "keyId": key_id, "audience": audience, "method": method,
        "canonicalTarget": canonical_target, "bodySha256": hashlib.sha256(body_bytes).hexdigest(),
        "timestamp": timestamp, "deliveryId": delivery_id, "signature": "0" * 64,
    })
    metadata["signature"] = hmac.new(key_bytes, _message(metadata), hashlib.sha256).hexdigest()
    return metadata


def verify_execution_request(
    *, signature: object, key_ring: Mapping[str, bytes], audience: str,
    method: str, target: str, body: bytes, now_seconds: int,
) -> dict:
    """Verify transport identity only. Domain fences and durable replay are mandatory."""
    body_bytes = _body_bytes(body)
    metadata = _metadata(signature)
    if not _positive_safe_integer(now_seconds):
        raise ExecutionSignatureError("invalid_clock")
    if abs(now_seconds - metadata["timestamp"]) > SIGNATURE_MAX_AGE_SECONDS:
        raise ExecutionSignatureError("expired")
    if metadata["audience"] != audience:
        raise ExecutionSignatureError("wrong_audience")
    if metadata["method"] != method:
        raise ExecutionSignatureError("method_mismatch")
    canonical_target = canonical_execution_target(target)
    if (canonical_execution_target(metadata["canonicalTarget"]) != metadata["canonicalTarget"]
            or metadata["canonicalTarget"] != canonical_target):
        raise ExecutionSignatureError("target_mismatch")
    key = _key_bytes(key_ring.get(metadata["keyId"]))
    if metadata["bodySha256"] != hashlib.sha256(body_bytes).hexdigest():
        raise ExecutionSignatureError("body_mismatch")
    message = _message(metadata)
    expected = hmac.new(key, message, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, metadata["signature"]):
        raise ExecutionSignatureError("signature_mismatch")
    return {"metadata": metadata, "requestHash": hashlib.sha256(message).hexdigest()}
