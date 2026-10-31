import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from uuid import uuid4
import zipfile

from narriflow_media.export_bundle_runtime import run_export_bundle,MAX_OUTPUT
from narriflow_media.artifacts import ArtifactCommitUnconfirmed
from narriflow_media.control import ExecutionControlError
from narriflow_media.multipart import TransferResponse
from narriflow_media.transfer import load_work_package


class ExportBundleRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_zip_child_streams_frozen_inputs_after_real_start_and_commits_measured_archive(self):
        await self.operation()

    async def test_lost_commit_ack_retains_completed_zip_without_delete_or_second_publication(self):
        await self.operation(lost_ack=True)

    async def operation(self,*,lost_ack=False):
        run_id,bundle_id,artifact_id=str(uuid4()),str(uuid4()),str(uuid4())
        payload=bytes(range(251))*8356
        entries=[{'variantId':str(uuid4()),'aspectRatio':'9:16','name':f'project/{index+1:03d}-fixture/9x16.mp4','sizeBytes':len(payload)} for index in range(2)]
        sources=[{'variantId':entry['variantId'],'name':'variant_'+entry['variantId'].replace('-',''),'object':{'storageKey':'projects/frozen/'+entry['variantId'],
            'etag':'"'+str(index)+'"','byteLength':len(payload),'sha256':hashlib.sha256(payload).hexdigest()}} for index,entry in enumerate(entries)]
        raw={'version':1,'kind':'export_bundle','bundleId':bundle_id,'workflowRunId':run_id,'toolchainFingerprint':'a'*64,
            'manifest':{'schemaVersion':1,'projectId':str(uuid4()),'operationId':str(uuid4()),'createdAt':'2026-10-31T00:00:00Z','excluded':[],
                'included':[{'clipId':str(uuid4()),'exportId':str(uuid4()),'editorRevision':1,'files':[entry]} for entry in entries]},'sources':sources}
        root=Path(__file__).resolve().parents[4]
        encoded=subprocess.run(['bun','-e',"import {readFileSync} from 'node:fs';import {exportBundleInputBinding} from './packages/services/src/export-bundle-input.ts';const value=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({...value,bindingHash:await exportBundleInputBinding(value)}));"],
            input=json.dumps(raw).encode(),capture_output=True,check=True,cwd=root,timeout=10)
        command=json.loads(encoded.stdout);calls=[];starts=[];uploads=[]
        output={'artifactId':artifact_id,'role':'export_bundle','bindingHash':command['bindingHash'],'contentType':'application/zip','contentTypes':['application/zip'],'maxBytes':MAX_OUTPUT}
        class Session:
            fence={'reference':{'subject':{'kind':'workflow_run','id':run_id},'inputHash':'b'*64},'attemptToken':str(uuid4()),'owner':str(uuid4())}
            remaining_seconds=120;cancel_event=threading.Event()
            def assert_live(self):
                if self.cancel_event.is_set():raise RuntimeError('cancelled')
            def on_process_start(self,pid):os.kill(pid,0);starts.append(pid)
            def transfer(self,action,**fields):
                calls.append((action,fields));result={}
                if action=='work-package':result={'functionName':'export_bundle','inputHash':'b'*64,'input':{'kind':'inline','command':command},'sources':[],'outputs':[output]}
                elif action=='source-read':
                    assert starts
                    source=next(source for source in sources if source['name']==fields['sourceId'])
                    result={'disposition':'source_read','sourceId':source['name'],'object':source['object'],'grant':{'url':'https://scoped.invalid/'+source['name'],'headers':{}}}
                elif action=='upload-initialize':result={'disposition':'upload_ready','artifactId':artifact_id,'uploadId':'fixture','byteLength':fields['byteLength'],'partSizeBytes':16777216,'partCount':1}
                elif action=='upload-parts':result={'disposition':'upload_parts','artifactId':artifact_id,'grants':[{'partNumber':1,'url':'https://scoped.invalid/output','headers':{}}]}
                elif action=='upload-complete':result={'disposition':'upload_completed','artifactId':artifact_id,'object':{'key':'execution/frozen/bundle.zip','etag':'"complete"','byteLength':fields['byteLength'],'sha256':fields['sha256'],'contentType':'application/zip'}}
                else:raise AssertionError(action)
                return type('Result',(),{'disposition':result})()
            def command(self,action,**fields):
                calls.append((action,fields));assert action=='commit-artifact';assert starts
                if lost_ack:raise ExecutionControlError('execution_http_unavailable')
                return type('Result',(),{'disposition':{'disposition':'committed','artifactId':artifact_id}})()
        class Storage:
            async def request(self,grant,method,body,headers,*_):
                assert starts
                if method=='GET':
                    name=grant.url.rsplit('/',1)[-1];source=next(source for source in sources if source['name']==name)
                    assert headers['if-match']==source['object']['etag'];start,end=map(int,headers['range'][6:].split('-'))
                    return TransferResponse(206,{'etag':source['object']['etag'],'content-length':str(end-start+1),'content-range':f'bytes {start}-{end}/{len(payload)}'},payload[start:end+1])
                uploads.append(bytes(body));return TransferResponse(200,{'ETag':hashlib.md5(body,usedforsecurity=False).hexdigest()},b'')
        async def verified(*_,**__):return 'a'*64
        session=Session();package=await load_work_package(session)
        with tempfile.TemporaryDirectory() as directory:
            if lost_ack:
                with self.assertRaises(ArtifactCommitUnconfirmed):await run_export_bundle(session,package,Path(directory),transport=Storage(),source_transport=Storage(),verify_runtime=verified)
                self.assertEqual([action for action,_ in calls if action in {'commit-artifact','fail','upload-abort'}],['commit-artifact'])
            else:
                result=await run_export_bundle(session,package,Path(directory),transport=Storage(),source_transport=Storage(),verify_runtime=verified)
                self.assertEqual(result['sourceBytesTransferred'],len(payload)*2)
                self.assertEqual(result['sha256'],hashlib.sha256(uploads[0]).hexdigest())
        self.assertEqual(len(starts),1);self.assertEqual(len(uploads),1)
        with zipfile.ZipFile(BytesIO(uploads[0])) as archive:
            self.assertEqual(archive.read(entries[1]['name']),payload)
            self.assertEqual(json.loads(archive.read('manifest.json')),command['manifest'])
        self.assertEqual({fields['sourceId'] for action,fields in calls if action=='source-read'},{source['name'] for source in sources})
