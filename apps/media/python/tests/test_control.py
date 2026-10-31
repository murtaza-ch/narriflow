from __future__ import annotations

import json
import subprocess
import sys
import time
from datetime import datetime, timezone
import unittest

from narriflow_media.control import ControlResponse, ExecutionControlClient, ExecutionControlError, ExecutorSession
from narriflow_media.process import MediaProcessError, run_owned_process
from narriflow_media.signing import verify_execution_request


class SignedControlTests(unittest.TestCase):
    def test_a_transport_retry_reuses_the_exact_signed_delivery(self):
        deliveries = []
        def transport(origin, target, body, headers, timeout):
            verified = verify_execution_request(
                signature=json.loads(headers['X-Execution-Signature']), key_ring={'dev': b'k' * 32},
                audience='executor-control', method='POST', target=target, body=body, now_seconds=2000000000,
            )
            deliveries.append((origin, target, body, dict(headers), verified['metadata']['deliveryId']))
            if len(deliveries) == 1:
                raise TimeoutError('private network diagnostic')
            return ControlResponse(200, {'X-Execution-Server-Time': '2033-05-18T03:33:20.000Z'}, b'{"disposition":"started"}')
        client = ExecutionControlClient(origin='https://api.example', key_id='dev', key=b'k' * 32,
                                        transport=transport, clock=lambda: 2000000000, retry_delay_seconds=0)
        response = client.command({'action': 'process-start', 'fence': {}})
        self.assertEqual(response.disposition, {'disposition': 'started'})
        self.assertEqual(deliveries[0], deliveries[1])
        self.assertGreater(response.received_monotonic, 0)

    def test_replayed_acquire_cannot_recreate_an_expired_lease(self):
        def transport(origin, target, body, headers, timeout):
            command = json.loads(body)
            response = {'disposition': 'acquired',
                        'fence': {'reference': command['reference'], 'attemptToken': command['attemptToken'], 'owner': command['owner']},
                        'serverTime': '2033-05-18T03:33:20.000Z', 'leaseExpiresAt': '2033-05-18T03:35:20.000Z',
                        'operationDeadlineAt': '2033-05-18T04:18:20.000Z'}
            return ControlResponse(200, {'X-Execution-Server-Time': '2033-05-18T03:35:21.000Z'}, json.dumps(response).encode())
        client = ExecutionControlClient(origin='https://api.example', key_id='dev', key=b'k' * 32, transport=transport)
        with self.assertRaises(ExecutionControlError) as refused:
            ExecutorSession.acquire(client, reference={'dispatchId': 'fixture'}, attempt_token='fixture')
        self.assertEqual(refused.exception.code, 'execution_authority_lost')

    def test_actual_native_start_is_acknowledged_once_and_loss_cancels_the_session(self):
        actions = []
        def instant(seconds):
            return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace('+00:00', 'Z')
        def transport(origin, target, body, headers, timeout):
            command, now = json.loads(body), time.time()
            actions.append(command['action'])
            if command['action'] == 'acquire':
                response = {'disposition': 'acquired',
                            'fence': {'reference': command['reference'], 'attemptToken': command['attemptToken'], 'owner': command['owner']},
                            'serverTime': instant(now), 'leaseExpiresAt': instant(now + 120), 'operationDeadlineAt': instant(now + 2700)}
            elif command['action'] == 'process-start':
                response = {'disposition': 'started'}
            else:
                response = {'disposition': 'superseded'}
            return ControlResponse(200, {'X-Execution-Server-Time': instant(now)}, json.dumps(response).encode())
        client = ExecutionControlClient(origin='https://api.example', key_id='dev', key=b'k' * 32, transport=transport)
        with ExecutorSession.acquire(client, reference={'dispatchId': 'fixture'}, attempt_token='fixture') as session:
            self.assertEqual(actions, ['acquire'])
            for _ in range(2):
                result = run_owned_process([sys.executable, '-c', 'import time;time.sleep(0.1)'],
                                           timeout_seconds=3, kill_grace_seconds=0.1,
                                           on_start=session.on_process_start, cancel_event=session.cancel_event)
                self.assertEqual(result.returncode, 0)
            self.assertEqual(actions, ['acquire', 'process-start'])
            self.assertFalse(session.cancel_event.is_set())
            self.assertEqual(session.command('read-disposition').disposition, {'disposition': 'superseded'})
            self.assertTrue(session.cancel_event.is_set())
            with self.assertRaises(ExecutionControlError):
                session.assert_live()

    def test_a_running_renewal_loss_stops_the_actual_native_child(self):
        actions, children = [], []
        def instant(seconds):
            return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace('+00:00', 'Z')
        def transport(origin, target, body, headers, timeout):
            command, now = json.loads(body), time.time()
            actions.append(command['action'])
            if command['action'] == 'acquire':
                response = {'disposition': 'acquired',
                            'fence': {'reference': command['reference'], 'attemptToken': command['attemptToken'], 'owner': command['owner']},
                            'serverTime': instant(now), 'leaseExpiresAt': instant(now + 120), 'operationDeadlineAt': instant(now + 2700)}
            else:
                response = {'disposition': 'started' if command['action'] == 'process-start' else 'superseded'}
            return ControlResponse(200, {'X-Execution-Server-Time': instant(now)}, json.dumps(response).encode())
        client = ExecutionControlClient(origin='https://api.example', key_id='dev', key=b'k' * 32, transport=transport)
        with ExecutorSession.acquire(client, reference={'dispatchId': 'fixture'}, attempt_token='fixture') as session:
            def started(pid):
                children.append(pid)
                session.on_process_start(pid)
            began = time.monotonic()
            with self.assertRaises(MediaProcessError) as stopped:
                run_owned_process([sys.executable, '-c', 'import time;time.sleep(60)'],
                                  timeout_seconds=40, kill_grace_seconds=0.1,
                                  on_start=started, cancel_event=session.cancel_event)
            self.assertEqual(stopped.exception.code, 'media_execution_cancelled')
            self.assertLess(time.monotonic() - began, 35)
        self.assertEqual(actions, ['acquire', 'process-start', 'renew'])
        state = subprocess.run(['ps', '-p', str(children[0]), '-o', 'stat='], capture_output=True).stdout.strip()
        self.assertTrue(not state or state.startswith(b'Z'))

    def test_duplicate_invocations_get_distinct_owners_and_neither_busy_response_starts_work(self):
        owners = []
        def transport(origin, target, body, headers, timeout):
            owners.append(json.loads(body)['owner'])
            return ControlResponse(200, {'X-Execution-Server-Time': '2033-05-18T03:33:20.000Z'},
                                   b'{"disposition":"busy","leaseExpiresAt":"2033-05-18T03:35:20.000Z"}')
        client = ExecutionControlClient(origin='https://api.example', key_id='dev', key=b'k' * 32, transport=transport)
        for _ in range(2):
            with self.assertRaises(ExecutionControlError) as refused:
                ExecutorSession.acquire(client, reference={'dispatchId': 'fixture'}, attempt_token='fixture')
            self.assertEqual(refused.exception.code, 'execution_not_acquired')
        self.assertEqual(len(set(owners)), 2)

    def test_configuration_errors_and_missing_fresh_time_never_echo_secrets(self):
        for origin in ['http://api.example', 'https://private:secret@api.example', 'https://api.example/wrong']:
            with self.assertRaises(ExecutionControlError) as invalid:
                ExecutionControlClient(origin=origin, key_id='dev', key=b'k' * 32)
            self.assertEqual(str(invalid.exception), 'execution_client_invalid')
        client = ExecutionControlClient(origin='https://api.example', key_id='dev', key=b'k' * 32,
                                        transport=lambda *_args: ControlResponse(200, {}, b'{"disposition":"started"}'))
        with self.assertRaises(ExecutionControlError) as invalid:
            client.command({'action': 'process-start'})
        self.assertEqual(str(invalid.exception), 'execution_response_invalid')


if __name__ == '__main__':
    unittest.main()
