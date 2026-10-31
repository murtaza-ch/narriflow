from __future__ import annotations

import json
from datetime import datetime, timezone
import os
from pathlib import Path
import sys
import time
import unittest
from uuid import uuid4

from narriflow_media.control import ControlResponse, ExecutionControlClient, ExecutionControlError
from narriflow_media.entrypoint import invoke_native
from narriflow_media.artifacts import ArtifactCommitUnconfirmed
from narriflow_media.multipart import CompletedObject
from narriflow_media.fetch import SourceFetchFailure
from narriflow_media.process import run_owned_process_async


def instant(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")


class NativeEntrypointTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self, *, duplicate=False, package_function="asset_validation"):
        state, calls = {"completed": False}, []
        invocation = {"reference": {"dispatchId": str(uuid4()), "deploymentEpoch": 1, "kind": "modal_execution",
            "subject": {"kind": "native_validation", "id": str(uuid4())}, "generation": 1, "inputHash": "a"*64}, "attemptToken": str(uuid4())}
        def transport(origin, target, body, headers, timeout):
            command, now = json.loads(body), time.time()
            calls.append(command)
            action = command["action"]
            if action == "acquire":
                result = {"disposition": "busy", "leaseExpiresAt": instant(now+120)} if duplicate else {
                    "disposition": "acquired", "fence": {key: command[key] for key in ["reference", "attemptToken", "owner"]},
                    "serverTime": instant(now), "leaseExpiresAt": instant(now+120), "operationDeadlineAt": instant(now+600)}
            elif action == "work-package":
                result = {"disposition": "work_package", "functionName": package_function, "inputHash": "a"*64,
                    "input": {"kind": "inline", "command": {"kind": "font"}}, "sources": [], "outputs": []}
            elif action == "process-start":
                result = {"disposition": "started"}
            elif action == "fail":
                state["failed"] = True
                result = {"disposition": "retry_due", "dueAt": instant(now+1)}
            elif action == "read-disposition":
                result = {"disposition": "completed" if state["completed"] else "failed" if state.get("failed") else "started"}
                if state.get("failed"): result["failureCode"] = "media_execution_failed"
            else:
                raise AssertionError("Unexpected native action")
            return ControlResponse(200, {"X-Execution-Server-Time": instant(now)}, json.dumps(result).encode())
        client = ExecutionControlClient(origin="https://api.example", key_id="fixture", key=b"k"*32,
                                        transport=transport, retry_delay_seconds=0)
        return invocation, client, state, calls

    async def test_duplicate_starts_no_process_and_reads_no_package(self):
        invocation, client, state, calls = self.fixture(duplicate=True)
        async def operation(*args): self.fail("Duplicate ran native work")
        self.assertEqual(await invoke_native(invocation, "asset_validation", client=client, operation=operation,
            max_operation_seconds=600), {"disposition": "not_acquired"})
        self.assertEqual([call["action"] for call in calls], ["acquire"])

    async def test_actual_process_is_acknowledged_before_input_and_completion_requires_ledger(self):
        invocation, client, state, calls = self.fixture()
        async def operation(session, package, work):
            self.assertEqual([call["action"] for call in calls], ["acquire", "work-package"])
            result = await run_owned_process_async([sys.executable, "-c", "import sys;assert sys.stdin.buffer.read()==b'assigned'"],
                input_bytes=b"assigned", timeout_seconds=5, env={key: os.environ[key] for key in ["PATH"] if key in os.environ},
                on_start=session.on_process_start, cancel_event=session.cancel_event)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(calls[-1]["action"], "process-start")
            state["completed"] = True
        self.assertEqual(await invoke_native(invocation, "asset_validation", client=client, operation=operation,
            max_operation_seconds=600), {"disposition": "completed"})
        self.assertEqual(calls[-1]["action"], "read-disposition")

    async def test_a_lost_control_ack_cannot_become_a_second_mutation(self):
        invocation, client, state, calls = self.fixture()
        async def operation(*args): raise ExecutionControlError("execution_transport_unavailable")
        self.assertEqual(await invoke_native(invocation, "asset_validation", client=client, operation=operation,
            max_operation_seconds=600), {"disposition": "unconfirmed"})
        self.assertEqual([call["action"] for call in calls], ["acquire", "work-package", "read-disposition"])

    async def test_unexpected_failures_export_only_a_fixed_code(self):
        invocation, client, state, calls = self.fixture()
        async def operation(*args): raise RuntimeError("private signed grant and credential")
        result = await invoke_native(invocation, "asset_validation", client=client, operation=operation, max_operation_seconds=600)
        self.assertEqual(result, {"disposition": "failed"})
        self.assertNotIn("private", json.dumps(calls))
        self.assertEqual(next(call for call in calls if call["action"] == "fail")["failureCode"], "media_execution_failed")

    async def test_lost_publication_ack_uses_committed_outcome_without_fail_or_release(self):
        invocation, client, state, calls = self.fixture()
        async def operation(*args):
            state["completed"] = True
            raise ArtifactCommitUnconfirmed(str(uuid4()), CompletedObject("assigned/retained", '"sealed"', 5, "a"*64))
        result = await invoke_native(invocation, "asset_validation", client=client, operation=operation, max_operation_seconds=600)
        self.assertEqual(result, {"disposition": "completed"})
        self.assertEqual([call["action"] for call in calls], ["acquire", "work-package", "read-disposition"])

    async def test_malformed_invocations_are_rejected_before_any_control_request(self):
        invocation, client, state, calls = self.fixture()
        invocation["reference"]["kind"] = "operation_driver"
        with self.assertRaisesRegex(ExecutionControlError, "execution_invocation_invalid"):
            await invoke_native(invocation, "asset_validation", client=client, operation=lambda *args: None, max_operation_seconds=600)
        self.assertEqual(calls, [])

    async def test_provider_access_denial_keeps_its_typed_permanent_failure(self):
        invocation, client, state, calls = self.fixture()
        async def operation(*args): raise SourceFetchFailure("source_provider_access_denied", False)
        await invoke_native(invocation, "asset_validation", client=client, operation=operation, max_operation_seconds=600)
        failure = next(call for call in calls if call["action"] == "fail")
        self.assertEqual((failure["failureCode"],failure["retryable"]),("source_provider_access_denied",False))
