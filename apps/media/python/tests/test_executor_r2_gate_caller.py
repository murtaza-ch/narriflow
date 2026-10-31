"""Operator caller behavior through a controlled Modal SDK port. No cloud calls."""
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


_path = Path(__file__).resolve().parents[1] / 'gates' / 'run_executor_r2_transfer.py'
_spec = importlib.util.spec_from_file_location('executor_r2_gate_caller', _path)
caller = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(caller)


class GateCallerTests(unittest.TestCase):
    def invoke(self, function_id, *, expected='fu-12345678901234567890', status='passed'):
        calls = []

        class Function:
            object_id = function_id

            @classmethod
            def from_name(cls, app, name, **options):
                calls.append(('lookup', app, name, options))
                return cls()

            def hydrate(self):
                calls.append(('hydrate',))
                return self

            def remote(self, invocation, **options):
                calls.append(('remote', invocation, options))
                return {'version': 1, 'phase': 'upload', 'status': status,
                        'failureCode': 'gate_fixture_failure' if status == 'failed' else None}

        with tempfile.TemporaryDirectory() as directory:
            arguments = Path(directory) / 'arguments.json'
            output = Path(directory) / 'report.json'
            invocation = {'reference': {'dispatchId': 'bounded-reference'}, 'attemptToken': 'actual-token'}
            arguments.write_text(json.dumps(invocation))
            arguments.chmod(0o600)
            argv = ['caller', '--app', 'narriflow-media-gates', '--phase', 'upload',
                    '--arguments', str(arguments), '--output', str(output),
                    '--expected-function-id', expected]
            error = None
            with patch.object(sys, 'argv', argv), patch.dict(sys.modules, {'modal': SimpleNamespace(Function=Function)}), \
                    patch.dict(os.environ, {'MODAL_PROFILE': 'murtazach275'}), \
                    patch.object(caller, 'version', return_value='1.6.3'), redirect_stdout(io.StringIO()):
                try:
                    caller.main()
                except (RuntimeError, SystemExit) as caught:
                    error = caught
            report = json.loads(output.read_text()) if output.exists() else None
            mode = output.stat().st_mode & 0o777 if output.exists() else None
            return error, calls, report, mode

    def test_exact_hydrated_function_runs_once_in_main_environment(self):
        error, calls, report, mode = self.invoke('fu-12345678901234567890')
        self.assertIsNone(error)
        self.assertEqual(calls[0], ('lookup', 'narriflow-media-gates', 'verify_executor_r2_transfer',
                                    {'environment_name': 'main'}))
        self.assertEqual([call[0] for call in calls], ['lookup', 'hydrate', 'remote'])
        self.assertEqual(report['status'], 'passed')
        self.assertEqual(mode, 0o600)

    def test_changed_function_is_refused_before_remote_submission(self):
        error, calls, report, _ = self.invoke('fu-different1234567890')
        self.assertEqual(str(error), 'gate_function_id_changed')
        self.assertEqual([call[0] for call in calls], ['lookup', 'hydrate'])
        self.assertIsNone(report)

    def test_failed_result_is_recorded_without_automatic_resubmission(self):
        error, calls, report, mode = self.invoke('fu-12345678901234567890', status='failed')
        self.assertIsInstance(error, SystemExit)
        self.assertEqual(error.code, 1)
        self.assertEqual(sum(call[0] == 'remote' for call in calls), 1)
        self.assertEqual(report['failureCode'], 'gate_fixture_failure')
        self.assertEqual(mode, 0o600)


if __name__ == '__main__':
    unittest.main()
