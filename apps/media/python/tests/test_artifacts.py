from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import time
import unittest
from uuid import uuid4
from datetime import datetime,timezone

from narriflow_media.artifacts import AssignedArtifacts, ArtifactCommitUnconfirmed
from narriflow_media.control import ControlResponse, ExecutionControlClient, ExecutionControlError, ExecutorSession
from narriflow_media.multipart import TransferResponse,CompletedObject
from narriflow_media.transfer import load_work_package


def instant(seconds):
    return datetime.fromtimestamp(seconds,timezone.utc).isoformat().replace('+00:00','Z')


class AssignedArtifactTests(unittest.IsolatedAsyncioTestCase):
    def session(self, output, *, lost_commit=False,lost_complete=False):
        calls, stored, failures = [], [], []
        def transport(origin,target,body,headers,timeout):
            command,now=json.loads(body),time.time(); calls.append((target,command,body,dict(headers)))
            action=command['action']
            if action=='acquire':
                result={'disposition':'acquired','fence':{key:command[key] for key in ['reference','attemptToken','owner']},
                    'serverTime':instant(now),'leaseExpiresAt':instant(now+120),'operationDeadlineAt':instant(now+2700)}
            elif action=='work-package':
                result={'disposition':'work_package','functionName':'thumbnail','inputHash':'0'*64,
                    'input':{'kind':'inline','command':{'immutable':'input'}},'sources':[],'outputs':[output]}
            elif action=='upload-initialize':
                result={'disposition':'upload_ready','artifactId':output['artifactId'],'uploadId':'private-upload',
                    'byteLength':command['byteLength'],'partSizeBytes':16777216,'partCount':1}
            elif action=='upload-parts':
                result={'disposition':'upload_parts','artifactId':output['artifactId'],'grants':[{'partNumber':1,
                    'url':'https://r2.example/private','headers':{},'expiresAt':instant(now+60)}]}
            elif action=='upload-complete':
                if lost_complete:raise TimeoutError('private completion acknowledgement lost')
                result={'disposition':'upload_completed','artifactId':output['artifactId'],'object':{
                    'key':'execution/server-assigned','etag':'"sealed"','byteLength':command['byteLength'],'sha256':command['sha256'],'contentType':output['contentType']}}
            elif action=='commit-artifact':
                failures.append(True)
                if lost_commit or len(failures)==1:
                    raise TimeoutError('commit succeeded, acknowledgement lost')
                result={'disposition':'committed','artifactId':output['artifactId']}
            else:
                self.fail('completed object was aborted or deleted')
            return ControlResponse(200,{'X-Execution-Server-Time':instant(now)},json.dumps(result).encode())
        class Storage:
            async def request(self,grant,method,body,headers,*args):
                stored.append(body)
                return TransferResponse(200,{'ETag':hashlib.md5(body,usedforsecurity=False).hexdigest()},b'')
        client=ExecutionControlClient(origin='https://api.example',key_id='dev',key=b'k'*32,transport=transport,retry_delay_seconds=0)
        return ExecutorSession.acquire(client,reference={'dispatchId':'fixture','inputHash':'0'*64},attempt_token='fixture'),calls,stored,Storage()

    async def test_only_an_assigned_output_is_uploaded_and_commit_retries_exactly_after_completion(self):
        output={'artifactId':str(uuid4()),'role':'thumbnail','bindingHash':'1'*64,'maxBytes':10,
            'contentType':'image/png','contentTypes':['image/png']}
        session,calls,stored,storage=self.session(output)
        with session,tempfile.TemporaryDirectory() as directory:
            package=await load_work_package(session)
            package.outputs[0]['artifactId']=str(uuid4())  # A caller cannot alter the verified assignment.
            artifacts=AssignedArtifacts(session,package)
            path=Path(directory)/'thumbnail.png'; path.write_bytes(b'hello')
            result=await artifacts.upload(output['artifactId'],path,content_type='image/png',byte_length=5,
                sha256=hashlib.sha256(b'hello').hexdigest(),transport=storage)
            self.assertEqual(result.artifact_id,output['artifactId'])
            self.assertEqual(result.object.key,'execution/server-assigned')
        self.assertEqual(stored,[b'hello'])
        commits=[call for call in calls if call[1]['action']=='commit-artifact']
        self.assertEqual(commits[0][2:],commits[1][2:])
        self.assertEqual(commits[0][1]['artifact'],{'artifactId':output['artifactId'],'role':'thumbnail','bindingHash':'1'*64,
            'contentType':'image/png','byteLength':5,'sha256':hashlib.sha256(b'hello').hexdigest(),'etag':'"sealed"'})

    async def test_a_completed_pin_is_committed_without_reuploading_or_deleting_it(self):
        output={'artifactId':str(uuid4()),'role':'thumbnail','bindingHash':'1'*64,'maxBytes':10,
            'contentType':'image/png','contentTypes':['image/png'],'sourceByteLength':5,'sourceEtag':'"frozen"'}
        session,calls,stored,_storage=self.session(output)
        with session:
            artifacts=AssignedArtifacts(session,await load_work_package(session))
            result=await artifacts.commit_completed(output['artifactId'],CompletedObject('execution/server-assigned','"sealed"',5,hashlib.sha256(b'hello').hexdigest()),content_type='image/png')
            self.assertEqual(result.object.key,'execution/server-assigned')
        self.assertEqual(stored,[])
        self.assertEqual([call[1]['action'] for call in calls],['acquire','work-package','commit-artifact','commit-artifact'])
        self.assertEqual(calls[-1][2:],calls[-2][2:])

    async def test_unassigned_id_and_mime_or_size_overrides_are_refused_before_upload_initialization(self):
        output={'artifactId':str(uuid4()),'role':'thumbnail','bindingHash':'1'*64,'maxBytes':4,
            'contentType':'image/png','contentTypes':['image/png']}
        session,calls,stored,storage=self.session(output)
        with session,tempfile.TemporaryDirectory() as directory:
            artifacts=AssignedArtifacts(session,await load_work_package(session))
            path=Path(directory)/'file'; path.write_bytes(b'hello')
            for identity,mime,length in [(str(uuid4()),'image/png',5),(output['artifactId'],'image/jpeg',5),(output['artifactId'],'image/png',5)]:
                with self.assertRaises(ExecutionControlError):
                    await artifacts.upload(identity,path,content_type=mime,byte_length=length,sha256=hashlib.sha256(b'hello').hexdigest(),transport=storage)
        self.assertEqual([call[1]['action'] for call in calls],['acquire','work-package'])
        self.assertEqual(stored,[])

    async def test_lost_commit_ack_retains_the_completed_object_and_exposes_only_reconciliation_identity(self):
        output={'artifactId':str(uuid4()),'role':'thumbnail','bindingHash':'1'*64,'maxBytes':10,
            'contentType':'image/png','contentTypes':['image/png']}
        session,calls,stored,storage=self.session(output,lost_commit=True)
        with session,tempfile.TemporaryDirectory() as directory:
            artifacts=AssignedArtifacts(session,await load_work_package(session))
            path=Path(directory)/'file'; path.write_bytes(b'hello')
            with self.assertRaises(ArtifactCommitUnconfirmed) as uncertain:
                await artifacts.upload(output['artifactId'],path,content_type='image/png',byte_length=5,
                    sha256=hashlib.sha256(b'hello').hexdigest(),transport=storage)
            self.assertEqual(uncertain.exception.artifact_id,output['artifactId'])
            self.assertEqual(str(uncertain.exception),'artifact_commit_unconfirmed')
        self.assertEqual([call[1]['action'] for call in calls],['acquire','work-package','upload-initialize','upload-parts','upload-complete']+['commit-artifact']*3)
        commits=calls[-3:]
        self.assertTrue(all(call[2:]==commits[0][2:] for call in commits))

    async def test_unknown_multipart_completion_is_control_uncertainty_without_abort_or_second_mutation(self):
        output={'artifactId':str(uuid4()),'role':'thumbnail','bindingHash':'1'*64,'maxBytes':10,'contentType':'image/png','contentTypes':['image/png']}
        session,calls,_stored,storage=self.session(output,lost_complete=True)
        with session,tempfile.TemporaryDirectory() as directory:
            artifacts=AssignedArtifacts(session,await load_work_package(session));path=Path(directory)/'file';path.write_bytes(b'hello')
            with self.assertRaises(ExecutionControlError) as uncertainty:
                await artifacts.upload(output['artifactId'],path,content_type='image/png',byte_length=5,sha256=hashlib.sha256(b'hello').hexdigest(),transport=storage)
            self.assertEqual(uncertainty.exception.code,'execution_completion_unconfirmed')
        self.assertEqual([call[1]['action'] for call in calls],['acquire','work-package','upload-initialize','upload-parts']+['upload-complete']*3)
        self.assertEqual(calls[-1][2:],calls[-2][2:])

    async def test_source_audio_facts_bind_the_full_source_to_the_completed_server_object(self):
        output={'artifactId':str(uuid4()),'role':'source_audio','bindingHash':'1'*64,'maxBytes':10,
            'contentType':'audio/wav','contentTypes':['audio/wav']}
        session,calls,stored,storage=self.session(output)
        source_audio_id,project_id=str(uuid4()),str(uuid4())
        def facts(completed):
            return {'sourceAudio':{'sourceAudioId':source_audio_id,'projectId':project_id,'sourceRevision':1,
                'mediaIdentity':{'provider':'youtube','mediaId':'_123456789-'},'audioTrack':{'id':'140','language':None,'codec':'pcm_s16le','sampleRate':16000,'channels':1},
                'object':{'key':completed.key,'etag':completed.etag,'byteLength':completed.byte_length,'sha256':completed.sha256},
                'durationSeconds':1.0,'wholeSource':True,'audioStartTimeSec':0.0,'probeVersion':'normalized-probe-v1','toolchainFingerprint':'2'*64}}
        with session,tempfile.TemporaryDirectory() as directory:
            artifacts=AssignedArtifacts(session,await load_work_package(session))
            path=Path(directory)/'source.wav';path.write_bytes(b'hello')
            result=await artifacts.upload(output['artifactId'],path,content_type='audio/wav',byte_length=5,
                sha256=hashlib.sha256(b'hello').hexdigest(),transport=storage,facts_builder=facts)
        artifact=calls[-1][1]['artifact']
        self.assertEqual(artifact['sourceAudio']['object'],{'key':result.object.key,'etag':'"sealed"','byteLength':5,'sha256':hashlib.sha256(b'hello').hexdigest()})
        self.assertEqual(artifact['sourceAudio']['sourceAudioId'],source_audio_id)
        self.assertEqual(artifact['bindingHash'],'1'*64)


if __name__=='__main__':
    unittest.main()
