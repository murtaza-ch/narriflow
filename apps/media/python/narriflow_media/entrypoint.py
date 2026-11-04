"""Acquire a fenced invocation and run its one assigned native operation."""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
import tempfile
from typing import Awaitable, Callable, Mapping

from .artifacts import ArtifactCommitUnconfirmed
from .bridge import BridgeError, _parse
from .bridge_runtime import parse_bridge_keys
from .control import ExecutionControlClient, ExecutionControlError, ExecutorSession
from .fetch import SourceFetchFailure
from .native_runtime import NativeOperationFailure
from .transfer import WorkPackage, load_work_package

NativeOperation = Callable[[ExecutorSession, WorkPackage, Path], Awaitable[None]]
_TERMINAL = {"completed", "failed", "cancelled", "expired", "superseded", "released", "retry_due"}
_logger = logging.getLogger(__name__)


def _control_failure(function_name: str, stage: str, error: ExecutionControlError):
    # Control errors contain protocol codes only. Never log request bodies,
    # exception text, source grants, provider settings or owner credentials.
    _logger.warning(json.dumps({"level": "warn", "message": "native_control_unconfirmed",
        "functionName": function_name, "stage": stage, "errorCode": error.code,
        "status": error.status}, separators=(",", ":")))


def invocation_reference(value: object, function_name: str, reference_kind: str = 'modal_execution') -> dict:
    try:
        if type(value) is not dict or set(value) != {"reference", "attemptToken"}:
            raise ValueError()
        if reference_kind not in {'modal_execution', 'local_fetch'}:
            raise ValueError()
        reference = value['reference']
        if type(reference) is not dict or reference.get('kind') != reference_kind:
            raise ValueError()
        if reference_kind == 'local_fetch' and (function_name != 'fetch_source' or type(reference.get('subject')) is not dict or reference['subject'].get('kind') != 'ingest_job'):
            raise ValueError()
        body = json.dumps({"action": "spawn", "function": function_name, **value, 'reference': {**reference, 'kind': 'modal_execution'}},
                          separators=(",", ":"), allow_nan=False).encode()
        if len(body) > 65536:
            raise ValueError()
        command = _parse(body)
        command['reference']['kind'] = reference_kind
        return {"reference": command["reference"], "attemptToken": command["attemptToken"]}
    except (BridgeError, ValueError, TypeError, UnicodeError):
        raise ExecutionControlError("execution_invocation_invalid") from None


def native_client(environment: Mapping[str, str]) -> ExecutionControlClient:
    """Only the explicit control origin and key ring; no database configuration."""
    try:
        key_id = environment["EXECUTOR_CONTROL_KEY_ID"]
        key = parse_bridge_keys(environment["EXECUTOR_CONTROL_KEYS_JSON"])[key_id]
        return ExecutionControlClient(origin=environment["API_ORIGIN"], key_id=key_id, key=key)
    except (KeyError, BridgeError, ExecutionControlError):
        raise ExecutionControlError("execution_configuration_invalid") from None


async def _observe(session: ExecutorSession) -> dict:
    try:
        result = (await asyncio.to_thread(session.command, "read-disposition")).disposition
        if result["disposition"] in _TERMINAL:
            # This response is metadata only. Provider errors and artifact URLs
            # never become Modal function results.
            return {"disposition": result["disposition"]}
    except ExecutionControlError:
        pass
    return {"disposition": "unconfirmed"}


async def invoke_native(value: object, function_name: str, *, client: ExecutionControlClient,
                        operation: NativeOperation, max_operation_seconds: float, reference_kind: str = 'modal_execution') -> dict:
    invocation = invocation_reference(value, function_name, reference_kind)
    try:
        session = await asyncio.to_thread(ExecutorSession.acquire, client,
            reference=invocation["reference"], attempt_token=invocation["attemptToken"],
            max_operation_seconds=max_operation_seconds)
    except ExecutionControlError as error:
        if error.code == "execution_not_acquired":
            return {"disposition": "not_acquired"}
        _control_failure(function_name, "acquire", error)
        return {"disposition": "unconfirmed"}
    stage = "work_package"
    try:
        with tempfile.TemporaryDirectory(prefix="narriflow-execution-") as directory:
            package = await load_work_package(session)
            if package.function_name != function_name:
                raise ExecutionControlError("execution_work_package_mismatch")
            stage = "operation"
            await operation(session, package, Path(directory))
    except (ArtifactCommitUnconfirmed, ExecutionControlError) as error:
        # A transport failure may follow a successful publication. Never turn
        # its missing acknowledgement into a failed domain result or delete it.
        if isinstance(error, ExecutionControlError):
            _control_failure(function_name, stage, error)
        return await _observe(session)
    except (SourceFetchFailure, NativeOperationFailure) as error:
        try:
            # Native adapters construct these from fixed failure codes.
            # Exception text and provider diagnostics stay local.
            await asyncio.to_thread(session.command, "fail", failureCode=error.code, retryable=error.retryable)
        except ExecutionControlError:
            pass
        return await _observe(session)
    except (asyncio.CancelledError, KeyboardInterrupt, SystemExit):
        # Modal is stopping this container. The work did not fail, so its
        # owner hands the attempt back instead of waiting out the lease.
        try:
            await asyncio.to_thread(session.command, "release", reason="shutdown")
        except ExecutionControlError:
            pass
        return await _observe(session)
    except BaseException:
        # The domain sees a bounded error code, never an exception message that
        # could contain a signed grant, URL credential or source content.
        try:
            await asyncio.to_thread(session.command, "fail", failureCode="media_execution_failed", retryable=True)
        except ExecutionControlError:
            pass
        return await _observe(session)
    else:
        return await _observe(session)
    finally:
        await asyncio.to_thread(session.close)
