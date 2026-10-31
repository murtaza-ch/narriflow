from __future__ import annotations

from datetime import datetime, timezone
import json
import time
import unittest
from uuid import uuid4

from apps.media.python.gates.restore_fault import RestoreCommitFaultClient, RestoreFaultGate
from narriflow_media.control import ControlResponse, ExecutionControlError
from narriflow_media.signing import verify_execution_request


class RestoreFaultTests(unittest.TestCase):
    def fixture(self, *, release=None, final='superseded', hold=30):
        run_id, dispatch, token, owner, artifact = [str(uuid4()) for _ in range(5)]
        nonce = 'a' * 64
        fence = {'reference': {'kind': 'modal_execution', 'subject': {'kind': 'native_validation', 'id': str(uuid4())},
            'dispatchId': dispatch, 'deploymentEpoch': 2, 'generation': 1, 'inputHash': 'b' * 64}, 'attemptToken': token, 'owner': owner}
        command = {'action': 'commit-artifact', 'fence': fence, 'artifact': {'artifactId': artifact, 'role': 'probe',
            'bindingHash': 'c' * 64, 'contentType': 'application/json', 'byteLength': 150, 'etag': '"measured"', 'sha256': 'd' * 64}}
        state = {'clock': time.time(), 'mono': 0.0, 'closed': 0, 'ready': [], 'calls': [], 'reads': [], 'sleeps': []}
        body = {'version': 1, 'runId': run_id, 'nonce': nonce, 'sourceEpoch': 2, 'targetEpoch': 4, 'release': True}
        def read(_url, _timeout):
            state['reads'].append(state['mono'])
            if len(state['reads']) == 1:
                return json.dumps({**body, 'release': False}).encode()
            state['clock'] += 301  # Authentication is created after the hold, not cached before it.
            return json.dumps(release(body) if release else body).encode()
        def sleep(seconds):
            state['sleeps'].append(seconds)
            state['mono'] += seconds
        def transport(_origin, target, raw, headers, _timeout):
            signature = json.loads(headers['X-Execution-Signature'])
            verify_execution_request(signature=signature, key_ring={'test': b'k' * 32}, audience='executor-control', method='POST', target=target, body=raw, now_seconds=int(state['clock']))
            sent = json.loads(raw)
            state['calls'].append((sent, signature))
            response = {'disposition': 'started'} if sent['action'] == 'process-start' else {'disposition': final}
            if final == 'committed' and sent['action'] == 'commit-artifact':
                response['artifactId'] = artifact
            return ControlResponse(200, {'X-Execution-Server-Time': datetime.fromtimestamp(state['clock'], timezone.utc).isoformat().replace('+00:00', 'Z')}, json.dumps(response).encode())
        url = f'https://{"0" * 32}.r2.cloudflarestorage.com/gate/execution/restore-gates/{run_id}/release.json' + '?X-Amz-Expires=600&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=' + '1' * 64
        gate = RestoreFaultGate(run_id=run_id, nonce=nonce, source_epoch=2, target_epoch=4, release_url=url, maximum_hold_seconds=hold)
        client = RestoreCommitFaultClient(gate=gate, release_read=read, sleep=sleep, monotonic=lambda: state['mono'], notify=state['ready'].append,
            origin='https://api.example', key_id='test', key=b'k' * 32, transport=transport, clock=lambda: state['clock'], max_attempts=1)
        client.arm(fence, remaining_seconds=500, stop_renewals=lambda: state.__setitem__('closed', state['closed'] + 1))
        return client, command, state, gate

    def test_exact_old_command_is_signed_after_release_with_no_renewal_or_new_work(self):
        client, command, state, gate = self.fixture()
        client.command({'action': 'process-start', 'fence': command['fence']})
        result = client.command(command, deadline_monotonic=-1)
        self.assertEqual(result.disposition, {'disposition': 'superseded'})
        self.assertEqual(state['calls'][1][0], command)
        self.assertGreater(state['calls'][1][1]['timestamp'], state['calls'][0][1]['timestamp'] + 300)
        self.assertEqual(state['closed'], 1)
        self.assertEqual(state['reads'], [0, 1])
        self.assertEqual(state['sleeps'], [1])
        self.assertEqual(client.report['refusal'], 'superseded')
        self.assertEqual(state['ready'][0]['event'], 'restore_fault_ready')
        self.assertNotIn(gate.nonce, json.dumps(state['ready']))
        self.assertNotIn(gate.release_url, repr(gate))

    def test_missing_start_or_changed_fence_never_enters_the_hold(self):
        client, command, state, _ = self.fixture()
        with self.assertRaisesRegex(ExecutionControlError, 'restore_fault_start_missing'):
            client.command(command)
        self.assertEqual(state['reads'], [])
        client.command({'action': 'process-start', 'fence': command['fence']})
        command['fence']['owner'] = str(uuid4())
        with self.assertRaisesRegex(ExecutionControlError, 'restore_fault_identity_invalid'):
            client.command(command)
        self.assertEqual(state['reads'], [])

    def test_wrong_release_proof_cannot_send_the_commit(self):
        for field, value in [('nonce', 'e' * 64), ('targetEpoch', 3), ('sourceEpoch', 1), ('release', 1)]:
            client, command, state, _ = self.fixture(release=lambda body, field=field, value=value: {**body, field: value})
            client.command({'action': 'process-start', 'fence': command['fence']})
            with self.assertRaisesRegex(ExecutionControlError, 'restore_fault_release_invalid'):
                client.command(command)
            self.assertEqual(len(state['calls']), 1)
            self.assertEqual(state['closed'], 1)

    def test_pending_hold_is_finite_and_a_stale_commit_acceptance_fails_the_gate(self):
        client, command, state, _ = self.fixture(release=lambda body: {**body, 'release': False}, hold=2)
        client.command({'action': 'process-start', 'fence': command['fence']})
        with self.assertRaisesRegex(ExecutionControlError, 'restore_fault_hold_expired'):
            client.command(command)
        self.assertEqual(len(state['calls']), 1)
        client, command, state, _ = self.fixture(final='committed')
        client.command({'action': 'process-start', 'fence': command['fence']})
        with self.assertRaisesRegex(ExecutionControlError, 'restore_fault_stale_commit_accepted'):
            client.command(command)

    def test_time_spent_in_the_real_producer_cannot_extend_the_original_budget(self):
        client, command, state, _ = self.fixture()
        client.command({'action': 'process-start', 'fence': command['fence']})
        state['mono'] = 499
        with self.assertRaisesRegex(ExecutionControlError, 'restore_fault_hold_expired'):
            client.command(command)
        self.assertEqual(state['reads'], [])
        self.assertEqual(len(state['calls']), 1)
        self.assertEqual(state['closed'], 1)

    def test_release_url_is_private_fixed_origin_exact_key_and_short_lived(self):
        _, _, _, gate = self.fixture()
        for changed in [gate.release_url.replace('.r2.cloudflarestorage.com', '.example.com'), gate.release_url.replace('Expires=600', 'Expires=601'),
                        gate.release_url.replace('/release.json', '/other.json'), gate.release_url + '#secret']:
            with self.assertRaisesRegex(ExecutionControlError, 'restore_fault_gate_invalid'):
                RestoreFaultGate(run_id=gate.run_id, nonce=gate.nonce, source_epoch=2, target_epoch=4, release_url=changed)


class ActualRestoreFaultProducerTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_png_validation_uploads_measured_outputs_then_holds_only_the_final_probe(self):
        import hashlib
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        import os
        from pathlib import Path
        import ssl
        import struct
        import subprocess
        import tempfile
        import threading
        import zlib
        from apps.media.python.gates.restore_fault import run_restore_fault
        from narriflow_media.multipart import TransferResponse
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
        payload = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 2, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress((b'\0' + b'\xff\0\0' * 2) * 2)) + chunk(b'IEND', b'')
        digest, run_id, nonce = hashlib.sha256(payload).hexdigest(), str(uuid4()), 'a' * 64
        roles = [('validated_asset', 'image/png'), ('probe', 'application/json')]
        outputs = [{'artifactId': str(uuid4()), 'role': role, 'contentType': mime, 'contentTypes': [mime], 'maxBytes': 65536, 'bindingHash': 'a' * 64} for role, mime in roles]
        uploaded, calls, ready, state = {}, [], [], {'started': False}
        instant = lambda value: datetime.fromtimestamp(value, timezone.utc).isoformat().replace('+00:00', 'Z')
        class Source(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                state['source_after_start'] = state['started']; state['source_if_match'] = self.headers.get('If-Match')
                self.send_response(200); self.send_header('ETag', '"png"'); self.send_header('Content-Length', str(len(payload))); self.end_headers(); self.wfile.write(payload)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory); cert, key = path / 'cert.pem', path / 'key.pem'
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(cert), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            server = ThreadingHTTPServer(('127.0.0.1', 0), Source); context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(cert, key)
            server.socket = context.wrap_socket(server.socket, server_side=True); thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            def transport(_origin, target, body, headers, _timeout):
                verify_execution_request(signature=json.loads(headers['X-Execution-Signature']), key_ring={'test': b'k' * 32}, audience='executor-control', method='POST', target=target, body=body, now_seconds=int(time.time()))
                command, now = json.loads(body), time.time(); calls.append(command); action = command['action']
                if action == 'acquire': result = {'disposition': 'acquired', 'fence': {name: command[name] for name in ['reference', 'attemptToken', 'owner']}, 'serverTime': instant(now), 'leaseExpiresAt': instant(now + 120), 'operationDeadlineAt': instant(now + 600)}
                elif action == 'work-package': result = {'disposition': 'work_package', 'functionName': 'asset_validation', 'inputHash': 'a' * 64,
                    'input': {'kind': 'inline', 'command': {'kind': 'visual', 'expected': {'contentType': 'image/png', 'byteLength': len(payload), 'sha256': digest}}},
                    'sources': [{'name': 'asset_source', 'storageKey': 'frozen/png', 'etag': '"png"', 'byteLength': len(payload), 'sha256': digest, 'url': f'https://127.0.0.1:{server.server_port}/png', 'headers': {'If-Match': '"png"'}, 'expiresAt': instant(now + 90)}], 'outputs': outputs}
                elif action == 'process-start': state['started'] = True; result = {'disposition': 'started'}
                elif action == 'upload-initialize': result = {'disposition': 'upload_ready', 'artifactId': command['artifactId'], 'uploadId': 'private', 'byteLength': command['byteLength'], 'partSizeBytes': 16777216, 'partCount': 1}
                elif action == 'upload-parts': result = {'disposition': 'upload_parts', 'artifactId': command['artifactId'], 'grants': [{'partNumber': 1, 'url': f'https://r2.example/{command["artifactId"]}', 'headers': {}, 'expiresAt': instant(now + 60)}]}
                elif action == 'upload-complete':
                    assigned = next(item for item in outputs if item['artifactId'] == command['artifactId']); result = {'disposition': 'upload_completed', 'artifactId': assigned['artifactId'], 'object': {'key': f'execution/{assigned["artifactId"]}', 'etag': '"sealed"', 'byteLength': command['byteLength'], 'sha256': command['sha256'], 'contentType': assigned['contentType']}}
                elif action == 'commit-artifact': result = {'disposition': 'superseded'} if command['artifact']['role'] == 'probe' else {'disposition': 'committed', 'artifactId': command['artifact']['artifactId']}
                else: raise AssertionError(action)
                return ControlResponse(200, {'X-Execution-Server-Time': instant(now)}, json.dumps(result).encode())
            class Storage:
                async def request(self, grant, _method, body, _headers, *_args):
                    uploaded[grant.url.rsplit('/', 1)[-1]] = bytes(body)
                    return TransferResponse(200, {'ETag': hashlib.md5(body, usedforsecurity=False).hexdigest()}, b'')
            url = f'https://{"0" * 32}.r2.cloudflarestorage.com/gate/execution/restore-gates/{run_id}/release.json?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=600&X-Amz-Signature=' + '1' * 64
            def notify(value):
                self.assertEqual(len(uploaded), 2); self.assertEqual(len([call for call in calls if call['action'] == 'commit-artifact']), 1); ready.append(value)
            client = RestoreCommitFaultClient(gate=RestoreFaultGate(run_id, nonce, 2, 4, url), notify=notify,
                release_read=lambda *_: json.dumps({'version': 1, 'runId': run_id, 'nonce': nonce, 'sourceEpoch': 2, 'targetEpoch': 4, 'release': True}).encode(),
                origin='https://api.example', key_id='test', key=b'k' * 32, transport=transport, max_attempts=1)
            invocation = {'reference': {'dispatchId': str(uuid4()), 'deploymentEpoch': 2, 'kind': 'modal_execution', 'subject': {'kind': 'native_validation', 'id': str(uuid4())}, 'generation': 1, 'inputHash': 'a' * 64}, 'attemptToken': str(uuid4())}
            previous = os.environ.get('CURL_CA_BUNDLE'); os.environ['CURL_CA_BUNDLE'] = str(cert)
            try: report = await run_restore_fault(client, invocation, transfer_transport=Storage())
            finally:
                if previous is None: os.environ.pop('CURL_CA_BUNDLE', None)
                else: os.environ['CURL_CA_BUNDLE'] = previous
                server.shutdown(); server.server_close(); thread.join(2)
        self.assertEqual(report['refusal'], 'superseded'); self.assertEqual(len(ready), 1)
        self.assertTrue(state['source_after_start']); self.assertEqual(state['source_if_match'], '"png"')
        self.assertEqual([call['action'] for call in calls].count('process-start'), 1)
        self.assertEqual(uploaded[outputs[0]['artifactId']], payload)
        evidence = json.loads(uploaded[outputs[1]['artifactId']]); self.assertEqual(evidence, {'kind': 'visual', 'sha256': digest, 'byteLength': len(payload), 'contentType': 'image/png', 'mediaKind': 'image', 'width': 2, 'height': 2, 'durationSec': None})
        self.assertEqual(calls[-1]['action'], 'commit-artifact'); self.assertNotIn('renew', [call['action'] for call in calls])


if __name__ == '__main__':
    unittest.main()
