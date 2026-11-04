from __future__ import annotations

import json
import logging
import os
import shutil
import ssl
import subprocess
import sys
import time
from pathlib import Path
from unittest.mock import patch
from datetime import datetime, timezone
import unittest
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from narriflow_media.control import ControlResponse, ExecutionControlClient, ExecutionControlError, ExecutorSession
from narriflow_media.process import MediaProcessError, run_owned_process
from narriflow_media.signing import verify_execution_request


class SignedControlTests(unittest.TestCase):
    def test_committed_group_acknowledgements_preserve_only_bounded_consistent_outcomes(self):
        artifact_id = '477b7dc3-0584-44db-8ae7-e9269e8d37af'
        def reply(facts):
            value = {'disposition': 'committed', 'artifactId': artifact_id, 'renderGroup': facts}
            client = ExecutionControlClient(origin='https://api.example', key_id='dev', key=b'k' * 32,
                transport=lambda *_args: ControlResponse(200, {'X-Execution-Server-Time': '2033-05-18T03:33:20.000Z'}, json.dumps(value).encode()))
            return client.command({'action': 'commit-artifact'}).disposition
        queued = {'status': 'queued', 'requested': 3, 'succeeded': 1, 'failed': 1, 'superseded': 0}
        partial = {**queued, 'status': 'partial', 'succeeded': 2}
        self.assertEqual(reply(queued)['renderGroup'], queued)
        self.assertEqual(reply(partial)['renderGroup'], partial)
        for invalid in [{**partial, 'requested': 5}, {**partial, 'succeeded': True},
                        {**partial, 'failed': 0}, {**queued, 'status': 'completed'},
                        {**partial, 'accessToken': 'private'}, {**partial, 'status': 'unknown'}]:
            with self.assertRaises(ExecutionControlError):
                reply(invalid)

    @unittest.skipUnless(shutil.which('openssl'),'TLS fixture certificate requires openssl')
    def test_https_deadline_interrupts_a_stalled_body_when_the_server_closes_connections(self):
        release=threading.Event()
        class Server(BaseHTTPRequestHandler):
            def log_message(self,*args):
                pass
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                self.send_response(200)
                self.send_header('Connection','close')
                self.send_header('Content-Length','100')
                self.send_header('X-Execution-Server-Time',datetime.now(timezone.utc).isoformat().replace('+00:00','Z'))
                self.end_headers()
                try:
                    self.wfile.write(b'{');self.wfile.flush()
                    # Each chunk arrives within the socket's idle timeout.
                    # Only the whole-response watchdog can bound this body.
                    for _ in range(80):
                        if release.wait(.05):
                            break
                        self.wfile.write(b' ');self.wfile.flush()
                except OSError:
                    pass
        with tempfile.TemporaryDirectory() as directory:
            cert,key=Path(directory)/'server.crt',Path(directory)/'server.key'
            subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),
                '-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],
                check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
            server=ThreadingHTTPServer(('127.0.0.1',0),Server)
            context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(cert,key)
            server.socket=context.wrap_socket(server.socket,server_side=True)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            previous=os.environ.get('SSL_CERT_FILE');os.environ['SSL_CERT_FILE']=str(cert)
            began=time.monotonic()
            try:
                client=ExecutionControlClient(origin=f'https://127.0.0.1:{server.server_port}',key_id='dev',key=b'k'*32,
                    timeout_seconds=.25,max_attempts=1)
                with self.assertRaises(ExecutionControlError):
                    client.command({'action':'process-start','fence':{}})
                self.assertLess(time.monotonic()-began,2)
            finally:
                if previous is None:
                    os.environ.pop('SSL_CERT_FILE',None)
                else:
                    os.environ['SSL_CERT_FILE']=previous
                release.set();server.shutdown();server.server_close();thread.join(2)

    def test_a_stalled_control_plane_is_waited_out_within_the_lease(self):
        timeouts, deliveries = [], []
        def transport(origin, target, body, headers, timeout):
            timeouts.append(timeout);deliveries.append(headers['X-Execution-Signature'])
            if len(timeouts) < 4:
                raise TimeoutError('queued behind other commits')
            return ControlResponse(200, {'X-Execution-Server-Time': '2033-05-18T03:33:20.000Z'}, b'{"disposition":"started"}')
        client = ExecutionControlClient(origin='https://api.example', key_id='dev', key=b'k' * 32,
                                        transport=transport, clock=lambda: 2000000000, retry_delay_seconds=0)
        result = client.command({'action': 'process-start', 'fence': {}})
        self.assertEqual(result.disposition, {'disposition': 'started'})
        self.assertEqual(timeouts, [20, 20, 20, 20])
        self.assertEqual(len(set(deliveries)), 1)

    def test_a_retry_never_outlives_the_callers_lease(self):
        calls = []
        def transport(origin, target, body, headers, timeout):
            calls.append(timeout)
            raise TimeoutError('queued behind other commits')
        client = ExecutionControlClient(origin='https://api.example', key_id='dev', key=b'k' * 32,
                                        transport=transport, clock=lambda: 2000000000, retry_delay_seconds=0)
        with self.assertRaises(ExecutionControlError):
            client.command({'action': 'process-start', 'fence': {}}, deadline_monotonic=time.monotonic() + .05)
        self.assertLessEqual(max(calls), .05)

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

    def test_acquire_round_trip_margin_shortens_local_cutoff_without_changing_server_deadline(self):
        wall, mono = [2_000_000_000.0], [1000.0]
        deadline = wall[0] + 2700
        def instant(seconds):
            return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace('+00:00', 'Z')
        def transport(_origin, _target, body, _headers, _timeout):
            command = json.loads(body)
            wall[0] += 3.074
            mono[0] += 3.074
            response = {'disposition':'acquired', 'fence':{'reference':command['reference'],'attemptToken':command['attemptToken'],'owner':command['owner']},
                        'serverTime':instant(wall[0]), 'leaseExpiresAt':instant(wall[0]+120), 'operationDeadlineAt':instant(deadline)}
            return ControlResponse(200, {'X-Execution-Server-Time':instant(wall[0])}, json.dumps(response).encode())
        client = ExecutionControlClient(origin='https://api.example',key_id='dev',key=b'k'*32,transport=transport,clock=lambda:wall[0])
        with patch('narriflow_media.control.time.monotonic',side_effect=lambda:mono[0]):
            session = ExecutorSession.acquire(client,reference={'dispatchId':'fixture'},attempt_token='fixture')
            try:
                self.assertAlmostEqual(deadline-(wall[0]+session.remaining_seconds),4.074,places=5)
            finally:
                session.close()

    def test_blocked_diagnostic_sink_cannot_delay_child_reaping_or_grow_work_without_bound(self):
        entered, release, ready, done = (threading.Event() for _ in range(4))
        records, children, failures = [], [], []
        class BlockedHandler(logging.Handler):
            def emit(self,record):
                records.append(record.getMessage());entered.set();release.wait(5)
        logger=logging.getLogger('narriflow_media.control');handler=BlockedHandler();logger.addHandler(handler)
        # Normal elapsed time advances; only the offset simulates a clock jump.
        wall_offset_seconds=[0.0]
        def clock():return time.time()+wall_offset_seconds[0]
        def instant(seconds):return datetime.fromtimestamp(seconds,timezone.utc).isoformat().replace('+00:00','Z')
        def transport(origin,target,body,headers,timeout):
            command=json.loads(body);now=clock()
            if command['action']=='acquire':
                result={'disposition':'acquired','fence':{key:command[key] for key in ('reference','attemptToken','owner')},
                    'serverTime':instant(now),'leaseExpiresAt':instant(now+120),'operationDeadlineAt':instant(now+2700)}
                return ControlResponse(200,{'X-Execution-Server-Time':instant(now)},json.dumps(result).encode())
            if command['action']=='process-start':
                return ControlResponse(200,{'X-Execution-Server-Time':instant(now)},b'{"disposition":"started"}')
            return ControlResponse(409,{},b'private response')
        client=ExecutionControlClient(origin='https://api.example',key_id='dev',key=b'k'*32,transport=transport,clock=clock)
        session=ExecutorSession.acquire(client,reference={'dispatchId':'fixture'},attempt_token='fixture')
        def started(pid):session.on_process_start(pid);children.append(pid);ready.set()
        def own_child():
            try:
                run_owned_process([sys.executable,'-c','import time;time.sleep(60)'],timeout_seconds=4,
                    kill_grace_seconds=.1,on_start=started,cancel_event=session.cancel_event)
            except MediaProcessError as error:failures.append(error.code)
            finally:done.set()
        owner=threading.Thread(target=own_child);owner.start()
        try:
            self.assertTrue(ready.wait(2));wall_offset_seconds[0]+=2
            self.assertTrue(entered.wait(2));self.assertTrue(session.cancel_event.is_set())
            self.assertTrue(done.wait(1),'owner must reap the child while the diagnostic sink remains blocked')
            self.assertFalse(release.is_set());self.assertEqual(failures,['media_execution_cancelled'])
            with self.assertRaises(ProcessLookupError):os.kill(children[0],0)
            for _ in range(100):self.assertTrue(session.cancel_event.is_set())
            began=time.monotonic();session.close();self.assertLess(time.monotonic()-began,.5)
            for _ in range(8):
                with ExecutorSession.acquire(client,reference={'dispatchId':'fixture'},attempt_token='fixture') as other:
                    with self.assertRaises(ExecutionControlError):other.transfer('source-read',sourceId='original')
                    self.assertTrue(other.cancel_event.is_set())
            self.assertEqual(len([thread for thread in threading.enumerate() if thread.name=='execution-diagnostics']),1)
            self.assertEqual(len(records),1)
            release.set()
            for _ in range(100):
                if len(records)==2:break
                time.sleep(.01)
            self.assertEqual(len(records),2,'only one pending diagnostic may survive sink saturation')
        finally:
            release.set();owner.join(3);session.close();logger.removeHandler(handler)

    def test_clock_lease_and_operation_cutoffs_log_distinct_causes_before_another_spawn(self):
        for reason, elapsed, wall_extra in [('clock',0,2),('lease',120,0),('deadline',2700,0)]:
            with self.subTest(reason=reason):
                wall, mono, actions = [2_000_000_000.0], [1000.0], []
                def instant(seconds):
                    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace('+00:00','Z')
                def transport(origin,target,body,headers,timeout):
                    command=json.loads(body);actions.append(command['action'])
                    result={'disposition':'acquired','fence':{key:command[key] for key in ('reference','attemptToken','owner')},
                        'serverTime':instant(wall[0]),'leaseExpiresAt':instant(wall[0]+120),'operationDeadlineAt':instant(wall[0]+2700)}
                    return ControlResponse(200,{'X-Execution-Server-Time':instant(wall[0])},json.dumps(result).encode())
                client=ExecutionControlClient(origin='https://api.example',key_id='dev',key=b'k'*32,transport=transport,clock=lambda:wall[0])
                with patch('narriflow_media.control.time.monotonic',side_effect=lambda:mono[0]):
                    with self.assertLogs('narriflow_media.control',level='WARNING') as logs, ExecutorSession.acquire(client,reference={'dispatchId':'fixture'},attempt_token='fixture') as session:
                        wall[0]+=elapsed+wall_extra;mono[0]+=elapsed
                        with self.assertRaisesRegex(MediaProcessError,'media_execution_cancelled'):
                            run_owned_process([sys.executable,'-c','raise SystemExit(99)'],timeout_seconds=2,
                                on_start=session.on_process_start,cancel_event=session.cancel_event)
                        with self.assertRaises(ExecutionControlError):session.assert_live()
                        for _ in range(100):
                            if logs.records:break
                            time.sleep(.01)
                self.assertEqual(actions,['acquire'])
                self.assertEqual(len(logs.records),1)
                record=json.loads(logs.records[0].getMessage())
                self.assertEqual((record['action'],record['stage']),('permission','permission_'+reason))
                self.assertEqual(record['clockDriftMs'],2000 if reason=='clock' else 0)
                self.assertIsNone(record['rpcElapsedMs'])

    def test_failed_source_grant_stops_the_child_and_logs_only_the_first_safe_cause(self):
        actions, workers = [], []
        secret = 'private-token-url-header-body'
        def instant(seconds):
            return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace('+00:00', 'Z')
        def transport(origin, target, body, headers, timeout):
            command, now = json.loads(body), time.time();actions.append(command['action'])
            if command['action'] == 'source-read': raise TimeoutError(secret)
            result = {'disposition':'started'}
            if command['action'] == 'acquire':
                result = {'disposition':'acquired', 'fence':{key:command[key] for key in ('reference','attemptToken','owner')},
                    'serverTime':instant(now),'leaseExpiresAt':instant(now+120),'operationDeadlineAt':instant(now+2700)}
            return ControlResponse(200, {'X-Execution-Server-Time':instant(now)}, json.dumps(result).encode())
        client = ExecutionControlClient(origin='https://api.example',key_id='dev',key=b'k'*32,transport=transport,retry_delay_seconds=0)
        with self.assertLogs('narriflow_media.control',level='WARNING') as logs:
            with ExecutorSession.acquire(client,reference={'dispatchId':secret},attempt_token=secret) as session:
                failures = []
                def grant():
                    try: session.transfer('source-read',sourceId='original')
                    except ExecutionControlError as error: failures.append(error.code)
                def started(pid):
                    session.on_process_start(pid)
                    thread=threading.Thread(target=grant);workers.append(thread);thread.start()
                with self.assertRaises(MediaProcessError) as stopped:
                    run_owned_process([sys.executable,'-c','import time;time.sleep(60)'],timeout_seconds=3,
                        kill_grace_seconds=.1,on_start=started,cancel_event=session.cancel_event)
                for thread in workers: thread.join(1)
                self.assertEqual(stopped.exception.code,'media_execution_cancelled')
                self.assertEqual(failures,['execution_transport_unavailable'])
                with self.assertRaises(ExecutionControlError): session.assert_live()
                for _ in range(100):
                    if logs.records:break
                    time.sleep(.01)
        self.assertEqual(actions,['acquire','process-start','source-read','source-read','source-read','source-read'])
        self.assertEqual(len(logs.records),1)
        record=json.loads(logs.records[0].getMessage())
        self.assertEqual((record['message'],record['action'],record['stage'],record['errorCode']),
            ('native_execution_cancelled','source-read','transfer_rpc','execution_transport_unavailable'))
        self.assertIsNone(record['status'])
        self.assertGreater(record['leaseRemainingMs'],0)
        self.assertGreater(record['operationRemainingMs'],record['leaseRemainingMs'])
        self.assertGreaterEqual(record['rpcElapsedMs'],0)
        self.assertNotIn(secret,logs.output[0])
        self.assertNotIn(session.fence['owner'],logs.output[0])

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
        for mode in ('disposition','transport'):
            with self.subTest(mode=mode):
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
                    elif command['action'] == 'renew' and mode == 'transport':
                        raise TimeoutError('private renewal URL and credential')
                    else:
                        response = {'disposition': 'started' if command['action'] == 'process-start' else 'superseded'}
                    return ControlResponse(200, {'X-Execution-Server-Time': instant(now)}, json.dumps(response).encode())
                client = ExecutionControlClient(origin='https://api.example', key_id='dev', key=b'k' * 32, transport=transport)
                with self.assertLogs('narriflow_media.control',level='WARNING') as logs, ExecutorSession.acquire(client, reference={'dispatchId': 'fixture'}, attempt_token='fixture') as session:
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
                    for _ in range(100):
                        if logs.records:break
                        time.sleep(.01)
                self.assertEqual(actions, ['acquire', 'process-start'] + ['renew'] * (4 if mode == 'transport' else 1))
                self.assertEqual(len(logs.records),1)
                record=json.loads(logs.records[0].getMessage())
                self.assertEqual((record['action'],record['stage'],record['failureKind']),
                    ('renew','renew_rpc','transport') if mode == 'transport' else ('renew','renew_disposition','authority'))
                self.assertEqual(record['errorCode'],'execution_transport_unavailable' if mode == 'transport' else 'execution_authority_lost')
                self.assertNotIn('private',logs.output[0])
                self.assertGreater(record['leaseRemainingMs'],0)
                self.assertGreaterEqual(record['rpcElapsedMs'],0)
                if sys.platform == 'linux':
                    try:
                        state = Path(f'/proc/{children[0]}/stat').read_bytes().rsplit(b')', 1)[1].split()[0]
                    except FileNotFoundError:
                        state = b''
                else:
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

    def test_second_quantized_server_time_cannot_hide_an_expiring_lease(self):
        def transport(origin, target, body, headers, timeout):
            command = json.loads(body)
            response = {'disposition': 'acquired',
                        'fence': {'reference': command['reference'], 'attemptToken': command['attemptToken'], 'owner': command['owner']},
                        'serverTime': '2033-05-18T03:33:20.000Z', 'leaseExpiresAt': '2033-05-18T03:33:25.500Z',
                        'operationDeadlineAt': '2033-05-18T04:18:20.000Z'}
            return ControlResponse(200, {'X-Execution-Server-Time': '2033-05-18T03:33:20.000Z'}, json.dumps(response).encode())
        client = ExecutionControlClient(origin='https://api.example', key_id='dev', key=b'k' * 32, transport=transport)
        with self.assertRaises(ExecutionControlError) as refused:
            ExecutorSession.acquire(client, reference={'dispatchId': 'fixture'}, attempt_token='fixture')
        self.assertEqual(refused.exception.code, 'execution_authority_lost')

    def test_sleep_invalidates_permission_before_another_native_spawn_and_still_allows_reconciliation(self):
        wall, actions = [time.time()], []
        def instant(seconds):
            return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace('+00:00', 'Z')
        def transport(origin, target, body, headers, timeout):
            command, now = json.loads(body), wall[0]
            actions.append(command['action'])
            if command['action'] == 'acquire':
                response = {'disposition': 'acquired',
                            'fence': {'reference': command['reference'], 'attemptToken': command['attemptToken'], 'owner': command['owner']},
                            'serverTime': instant(now), 'leaseExpiresAt': instant(now + 120), 'operationDeadlineAt': instant(now + 2700)}
            else:
                response = {'disposition': 'expired'}
            return ControlResponse(200, {'X-Execution-Server-Time': instant(now)}, json.dumps(response).encode())
        client = ExecutionControlClient(origin='https://api.example', key_id='dev', key=b'k' * 32,
                                        transport=transport, clock=lambda: wall[0])
        with ExecutorSession.acquire(client, reference={'dispatchId': 'fixture'}, attempt_token='fixture') as session:
            wall[0] += 3600  # CLOCK_MONOTONIC can pause across laptop suspend.
            with self.assertRaises(MediaProcessError):
                run_owned_process([sys.executable, '-c', 'raise SystemExit(99)'], timeout_seconds=2,
                                  on_start=session.on_process_start, cancel_event=session.cancel_event)
            self.assertEqual(session.command('read-disposition').disposition, {'disposition': 'expired'})
            self.assertTrue(session.cancel_event.is_set())
        self.assertEqual(actions, ['acquire', 'read-disposition'])

    def test_sleep_during_acquire_cannot_turn_an_old_tls_response_into_permission(self):
        wall = [time.time()]
        def instant(seconds):
            return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace('+00:00', 'Z')
        def transport(origin, target, body, headers, timeout):
            command, now = json.loads(body), wall[0]
            response = {'disposition': 'acquired',
                        'fence': {'reference': command['reference'], 'attemptToken': command['attemptToken'], 'owner': command['owner']},
                        'serverTime': instant(now), 'leaseExpiresAt': instant(now + 120), 'operationDeadlineAt': instant(now + 2700)}
            wall[0] += 3600
            return ControlResponse(200, {'X-Execution-Server-Time': instant(now)}, json.dumps(response).encode())
        client = ExecutionControlClient(origin='https://api.example', key_id='dev', key=b'k' * 32,
                                        transport=transport, clock=lambda: wall[0])
        with self.assertRaises(ExecutionControlError):
            ExecutorSession.acquire(client, reference={'dispatchId': 'fixture'}, attempt_token='fixture')


if __name__ == '__main__':
    unittest.main()
