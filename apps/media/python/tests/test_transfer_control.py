from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import time
from pathlib import Path
import tempfile
from threading import Event
from datetime import datetime, timezone
import unittest
from uuid import uuid4

from narriflow_media.control import ControlResponse, ExecutionControlClient, ExecutionControlError, ExecutorSession
from narriflow_media.multipart import MultipartTransferError, TransferResponse, upload_file
from narriflow_media.signing import verify_execution_request
from narriflow_media.transfer import ScopedMultipartControl, load_work_package


def instant(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace('+00:00', 'Z')


class ScopedTransferTests(unittest.IsolatedAsyncioTestCase):
    def make_session(self, reply):
        calls = []
        def transport(origin, target, body, headers, timeout):
            command, now = json.loads(body), time.time()
            calls.append((target, command, body, dict(headers)))
            if command['action'] == 'acquire':
                result = {'disposition': 'acquired', 'fence': {key: command[key] for key in ['reference', 'attemptToken', 'owner']},
                    'serverTime': instant(now), 'leaseExpiresAt': instant(now+120), 'operationDeadlineAt': instant(now+2700)}
            else:
                result = reply(command, calls)
            if isinstance(result,ControlResponse):
                return result
            return ControlResponse(200, {'X-Execution-Server-Time': instant(now)}, json.dumps(result).encode())
        client = ExecutionControlClient(origin='https://api.example', key_id='dev', key=b'k'*32, transport=transport, retry_delay_seconds=0)
        return ExecutorSession.acquire(client, reference={'dispatchId':'fixture','inputHash':'0'*64}, attempt_token='fixture'), calls

    async def test_batched_part_transport_retry_preserves_exact_inbox_bytes_and_delivery_signature(self):
        artifact = str(uuid4())
        def reply(command, calls):
            if len([call for call in calls if call[1]['action']=='upload-parts']) == 1:
                raise TimeoutError('controlled lost acknowledgement')
            return {'disposition':'upload_parts','artifactId':artifact,'grants':[
                {'partNumber':part['partNumber'],'url':f"https://r2.example/part-{part['partNumber']}",
                 'headers':{'Content-MD5':part['checksumMd5']},'expiresAt':instant(time.time()+60)} for part in command['parts']]}
        session, calls = self.make_session(reply)
        with session:
            from narriflow_media.multipart import MultipartDestination
            control = ScopedMultipartControl(session,MultipartDestination(artifact,'private-upload',4*16777216),content_type='video/mp4')
            sha=base64.b64encode(hashlib.sha256(b'fixture').digest()).decode()
            md5=base64.b64encode(hashlib.md5(b'fixture',usedforsecurity=False).digest()).decode()
            grants=await asyncio.wait_for(asyncio.gather(*(control.authorize_part(number,16777216,sha,md5) for number in range(1,5))),0.5)
            self.assertEqual(len(grants),4)
        retries=[call for call in calls if call[1]['action']=='upload-parts']
        self.assertEqual(len(retries),2)
        self.assertEqual(len(retries[0][1]['parts']),4)
        self.assertEqual(retries[0][2],retries[1][2])
        self.assertEqual(retries[0][3]['X-Execution-Signature'],retries[1][3]['X-Execution-Signature'])

    async def test_native_upload_uses_signed_assigned_ids_and_completes_without_part_inventory(self):
        artifact = str(uuid4())
        commands = []
        def transport(origin, target, body, headers, timeout):
            verify_execution_request(signature=json.loads(headers['X-Execution-Signature']), key_ring={'dev': b'k'*32},
                audience='executor-control', method='POST', target=target, body=body, now_seconds=int(time.time()))
            command, now = json.loads(body), time.time()
            commands.append((target, command))
            if command['action'] == 'acquire':
                result = {'disposition': 'acquired', 'fence': {key: command[key] for key in ['reference', 'attemptToken', 'owner']},
                    'serverTime': instant(now), 'leaseExpiresAt': instant(now+120), 'operationDeadlineAt': instant(now+2700)}
            elif command['action'] == 'upload-initialize':
                result = {'disposition': 'upload_ready', 'artifactId': artifact, 'uploadId': 'provider-private',
                    'byteLength': 5, 'partSizeBytes': 16777216, 'partCount': 1}
            elif command['action'] == 'upload-parts':
                result = {'disposition': 'upload_parts', 'artifactId': artifact, 'grants': [{'partNumber': 1,
                    'url': 'https://r2.example/scoped', 'headers': {'Content-MD5': command['parts'][0]['checksumMd5']}, 'expiresAt': instant(now+60)}]}
            elif command['action'] == 'upload-complete':
                result = {'disposition': 'upload_completed', 'artifactId': artifact,
                    'object': {'key': 'server-assigned-key', 'etag': '"sealed"', 'byteLength': 5, 'contentType': 'audio/wav', 'sha256': command['sha256']}}
            else:
                result = {'disposition': 'started'}
            return ControlResponse(200, {'X-Execution-Server-Time': instant(now)}, json.dumps(result).encode())
        client = ExecutionControlClient(origin='https://api.example', key_id='dev', key=b'k'*32, transport=transport)
        with ExecutorSession.acquire(client, reference={'dispatchId': 'fixture'}, attempt_token='fixture') as session:
            control = await ScopedMultipartControl.initialize(session, artifact_id=artifact, byte_length=5, content_type='audio/wav')
            sha = base64.b64encode(hashlib.sha256(b'hello').digest()).decode()
            md5 = base64.b64encode(hashlib.md5(b'hello', usedforsecurity=False).digest()).decode()
            grant = await control.authorize_part(1, 5, sha, md5)
            self.assertEqual(grant.url, 'https://r2.example/scoped')
            sealed = await control.complete((), hashlib.sha256(b'hello').hexdigest())
            self.assertEqual(sealed.key, 'server-assigned-key')
        self.assertEqual([target for target, _ in commands], ['/api/execution/command']+['/api/execution/transfer']*3)
        self.assertEqual(set(commands[-1][1]), {'action','fence','artifactId','byteLength','sha256'})
        self.assertNotIn('provider-private', json.dumps(commands))

    async def test_conditional_source_grants_retry_the_same_signed_delivery_and_are_exactly_bounded(self):
        artifact = str(uuid4())
        def reply(command, calls):
            if command['action'] == 'upload-initialize':
                return {'disposition':'upload_ready','artifactId':artifact,'uploadId':'private','byteLength':5,'partSizeBytes':16777216,'partCount':1}
            if len([call for call in calls if call[1]['action'] == 'source-range']) == 1:
                raise TimeoutError('private network details')
            return {'disposition':'source_range','artifactId':artifact,'partNumber':1,'grant':{
                'url':'https://r2.example/private-signed-query','headers':{'If-Match':'"frozen"','Range':'bytes=0-4'},'expiresAt':instant(time.time()+60)}}
        session, calls = self.make_session(reply)
        with session:
            control = await ScopedMultipartControl.initialize(session, artifact_id=artifact, byte_length=5, content_type='video/mp4', source_etag='"frozen"')
            grant = await control.authorize_source_range(0,5,'"frozen"')
            self.assertEqual(grant.headers, {'If-Match':'"frozen"','Range':'bytes=0-4'})
            before = len(calls)
            with self.assertRaises(MultipartTransferError):
                await control.authorize_source_range(0,4,'"frozen"')
            self.assertEqual(len(calls),before)
        self.assertEqual(calls[-1][2:], calls[-2][2:])
        self.assertEqual(set(calls[-1][1]), {'action','fence','artifactId','partNumber'})

    async def test_caller_keys_urls_and_overlarge_part_batches_never_leave_the_native_boundary(self):
        session, calls = self.make_session(lambda *_: self.fail('invalid command reached transport'))
        with session:
            for action, fields in [('source-read',{'sourceId':'source','url':'https://secret.invalid'}),
                    ('upload-complete',{'artifactId':str(uuid4()),'byteLength':1,'sha256':'0'*64,'storageKey':'chosen-key'}),
                    ('upload-parts',{'artifactId':str(uuid4()),'parts':[{}]*17})]:
                with self.assertRaises(ExecutionControlError):
                    session.transfer(action, **fields)
        self.assertEqual(len(calls),1)

    async def test_expired_replayed_grants_are_refused_using_fresh_response_time(self):
        session, _ = self.make_session(lambda *_: {'disposition':'source_read','sourceId':'source','grant':{
            'url':'https://r2.example/secret','headers':{},'expiresAt':instant(time.time()-1)},
            'object':{'storageKey':'source','etag':'"frozen"','byteLength':5}})
        with session:
            with self.assertRaises(ExecutionControlError) as expired:
                session.transfer('source-read', sourceId='source')
            self.assertEqual(str(expired.exception),'execution_grant_expired')

    async def test_refused_transfer_authority_cancels_native_work_immediately(self):
        session,_=self.make_session(lambda *_: ControlResponse(409,{},b'{"error":"authority_lost"}'))
        with session:
            with self.assertRaises(ExecutionControlError):
                session.transfer('source-read',sourceId='source')
            self.assertTrue(session.cancel_event.is_set())

    async def test_unknown_control_errors_and_statuses_cannot_enter_cancellation_diagnostics(self):
        secret='private-token-url-header-body'
        failure=ExecutionControlError(secret,secret)
        def reply(*_):raise failure
        session,_=self.make_session(reply)
        with self.assertLogs('narriflow_media.control',level='WARNING') as logs, session:
            with self.assertRaises(ExecutionControlError) as stopped:
                session.transfer('source-read',sourceId='source')
            self.assertIs(stopped.exception,failure)
            self.assertTrue(session.cancel_event.is_set())
            for _ in range(100):
                if logs.records:break
                await asyncio.sleep(.01)
        self.assertEqual(len(logs.records),1)
        record=json.loads(logs.records[0].getMessage())
        self.assertEqual((record['errorCode'],record['failureKind'],record['status']),('execution_control_unexpected','unexpected',None))
        self.assertNotIn(secret,logs.output[0])

    async def test_a_failed_diagnostic_sink_cannot_replace_the_control_failure_or_keep_permission(self):
        attempted=Event()
        class BrokenHandler(logging.Handler):
            def emit(self,record):
                attempted.set()
                raise RuntimeError('private logging sink failure')
        logger=logging.getLogger('narriflow_media.control');handler=BrokenHandler();logger.addHandler(handler)
        session,calls=self.make_session(lambda *_:ControlResponse(409,{},b'private response'))
        try:
            with session, self.assertRaises(ExecutionControlError) as stopped:
                session.transfer('source-read',sourceId='source')
            self.assertEqual((stopped.exception.code,stopped.exception.status),('execution_command_refused',409))
            self.assertTrue(session.cancel_event.is_set())
            self.assertEqual(len(calls),2)
            self.assertTrue(attempted.wait(1))
        finally:logger.removeHandler(handler)

    async def test_lost_completion_acknowledgement_does_not_abort_or_delete_the_uploaded_object(self):
        artifact = str(uuid4())
        def reply(command, calls):
            if command['action'] == 'upload-initialize':
                return {'disposition':'upload_ready','artifactId':artifact,'uploadId':'private','byteLength':5,'partSizeBytes':16777216,'partCount':1}
            if command['action'] == 'upload-parts':
                return {'disposition':'upload_parts','artifactId':artifact,'grants':[{'partNumber':1,'url':'https://r2.example/part','headers':{},'expiresAt':instant(time.time()+60)}]}
            if command['action'] == 'upload-complete':
                raise TimeoutError('completed, acknowledgement lost')
            self.fail('uncertain completion was aborted')
        class Storage:
            async def request(self, grant, method, body, headers, *args):
                return TransferResponse(200, {'ETag':hashlib.md5(body, usedforsecurity=False).hexdigest()}, b'')
        session, calls = self.make_session(reply)
        with session, tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'file'; path.write_bytes(b'hello')
            control=await ScopedMultipartControl.initialize(session, artifact_id=artifact, byte_length=5, content_type='audio/wav')
            with self.assertRaises(MultipartTransferError):
                await upload_file(path, control.destination, control=control, transport=Storage(),
                    assert_owned=session.assert_live, cancel_event=session.cancel_event)
        self.assertEqual([call[1]['action'] for call in calls], ['acquire','upload-initialize','upload-parts']+['upload-complete']*3)
        self.assertEqual(calls[-1][2:],calls[-2][2:])

    async def test_work_package_object_is_conditionally_read_and_raw_hash_verified_before_json_parse(self):
        raw = b'{"native":true}'
        requests = []
        def reply(command, calls):
            return {'disposition':'work_package','functionName':'fetch_source','inputHash':'0'*64,
                'input':{'kind':'object','storageKey':'assigned-input','etag':'"immutable"','byteLength':len(raw),
                    'sha256':hashlib.sha256(raw).hexdigest(),'url':'https://r2.example/secret','headers':{'If-Match':'"immutable"'},'expiresAt':instant(time.time()+60)},
                'sources':[],'outputs':[]}
        class Storage:
            async def request(self, grant, method, body, headers, limit, cancelled):
                requests.append((method,headers,limit))
                return TransferResponse(200,{'ETag':'"immutable"','Content-Length':str(len(raw))},raw)
        session,_=self.make_session(reply)
        with session:
            package=await load_work_package(session,transport=Storage())
        self.assertEqual(package.command,{'native':True})
        self.assertEqual(package.input_hash,'0'*64)  # Semantic identity differs from raw object bytes.
        self.assertEqual(requests,[('GET',{'If-Match':'"immutable"'},16777216)])
        self.assertNotIn('secret',repr(package))

    async def test_changed_work_package_bytes_are_never_parsed_or_exposed(self):
        raw = b'not valid json'
        def reply(command,calls):
            return {'disposition':'work_package','functionName':'fetch_source','inputHash':'0'*64,
                'input':{'kind':'object','storageKey':'assigned-input','etag':'"immutable"','byteLength':len(raw),'sha256':'0'*64,
                    'url':'https://r2.example/private','headers':{},'expiresAt':instant(time.time()+60)},'sources':[],'outputs':[]}
        class Storage:
            async def request(self,*args):
                return TransferResponse(200,{'ETag':'"immutable"','Content-Length':str(len(raw))},raw)
        session,_=self.make_session(reply)
        with session:
            with self.assertRaises(ExecutionControlError) as changed:
                await load_work_package(session,transport=Storage())
        self.assertEqual(str(changed.exception),'execution_input_changed')


if __name__ == '__main__':
    unittest.main()
