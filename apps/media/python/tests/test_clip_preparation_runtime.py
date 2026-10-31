import asyncio
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from uuid import uuid4

from narriflow_media.clip_preparation_runtime import run_prepare_clip
from narriflow_media.multipart import TransferResponse
from narriflow_media.transfer import load_work_package


class ClipPreparationRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_bun_child_starts_before_conditional_source_reads_and_commits_real_outputs_in_order(self):
        await self.actual_operation()

    async def actual_operation(self, *, video=False, fingerprint='a'*64, enforce_runtime=False):
        root=Path(__file__).resolve().parents[4]
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory);original=base/('original.mp4' if video else 'original.wav');work=base/'work';work.mkdir()
            subprocess.run(['ffmpeg','-nostdin','-hide_banner','-loglevel','error','-y',*(['-f','lavfi','-i','testsrc2=s=320x180:r=30:d=4','-f','lavfi','-i','sine=f=330:sample_rate=48000:d=4','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart','-shortest'] if video else ['-f','lavfi','-i','sine=f=330:sample_rate=16000:d=4','-c:a','pcm_s16le']),str(original)],check=True,timeout=10)
            payload=original.read_bytes()
            script="""import {readFileSync} from 'node:fs';import {productionWorkerProcessModule as worker} from './apps/media/src/worker-process.ts';import {clipPreparationBinding} from './packages/services/src/clip-preparation-input.ts';import {clipPreparationEngineHash} from './packages/services/src/clip-preparation-policy.ts';import {clipPreparationInputSchema} from './packages/validators/src/clip-preparation.ts';const raw=JSON.parse(readFileSync(0,'utf8'));raw.sourceProbe=(await worker.inspectMedia({sourcePath:raw.sourcePath,signal:new AbortController().signal,deadlineMs:10000})).sourceProbe;delete raw.sourcePath;raw.engineHash=await clipPreparationEngineHash(raw.toolchainFingerprint);raw.document=JSON.parse(readFileSync('./apps/media/src/__fixtures__/render-golden/documents.json','utf8')).cases['solo-auto-vertical'].document;const value=clipPreparationInputSchema.omit({bindingHash:true}).parse(raw);console.log(JSON.stringify({...value,bindingHash:await clipPreparationBinding(value)}));"""
            raw={'version':1,'kind':'prepare_clip','preparationId':str(uuid4()),'projectId':str(uuid4()),'clipId':str(uuid4()),'sourceRevision':1,'editorRevision':0,
                'toolchainFingerprint':fingerprint,'engineHash':'b'*64,'wholeSource':True,'llmModel':'fixture','sourcePath':str(original),
                'source':{'storageKey':'execution/frozen/original','etag':'"source"','byteLength':len(payload),'sha256':hashlib.sha256(payload).hexdigest()}}
            prepared=subprocess.run(['bun','-e',script],input=json.dumps(raw).encode(),capture_output=True,cwd=root,timeout=20,check=True)
            command=json.loads(prepared.stdout);uploads={};calls=[];starts=[]
            outputs=[{'artifactId':str(uuid4()),'role':role,'bindingHash':command['bindingHash'],'contentType':mime,'contentTypes':[mime],'maxBytes':limit}
                for role,mime,limit in [('clip_preview','video/mp4',512*1024**2),('preview_peaks','application/json',256*1024),('layout_evidence','application/json',1024**2)]]
            class Session:
                fence={'reference':{'inputHash':'d'*64},'attemptToken':str(uuid4()),'owner':str(uuid4())}
                remaining_seconds=600;cancel_event=threading.Event()
                def assert_live(self):
                    if self.cancel_event.is_set():raise RuntimeError('cancelled')
                def on_process_start(self,pid):
                    os.kill(pid,0);starts.append(pid)
                def transfer(self,action,**fields):
                    calls.append((action,fields));result={}
                    if action=='work-package':result={'disposition':'work_package','functionName':'prepare_clip','inputHash':'d'*64,'input':{'kind':'inline','command':command},
                        'sources':[{'name':'original',**command['source'],'url':'https://scoped.invalid/original','headers':{'if-match':'"source"'}}],'outputs':outputs}
                    elif action=='source-read':
                        assert starts
                        result={'disposition':'source_read','sourceId':'original','object':command['source'],'grant':{'url':'https://scoped.invalid/original','headers':{'if-match':'"source"'}}}
                    elif action=='upload-initialize':result={'disposition':'upload_ready','artifactId':fields['artifactId'],'uploadId':'fixture','byteLength':fields['byteLength'],'partSizeBytes':16777216,'partCount':1}
                    elif action=='upload-parts':result={'disposition':'upload_parts','artifactId':fields['artifactId'],'grants':[{'partNumber':1,'url':'https://scoped.invalid/'+fields['artifactId'],'headers':{}}]}
                    elif action=='upload-complete':
                        output=next(value for value in outputs if value['artifactId']==fields['artifactId'])
                        result={'disposition':'upload_completed','artifactId':output['artifactId'],'object':{'key':'execution/'+output['artifactId'],'etag':'"sealed"','byteLength':fields['byteLength'],'sha256':fields['sha256'],'contentType':output['contentType']}}
                    else:raise AssertionError(action)
                    return type('Result',(),{'disposition':result})()
                def command(self,action,**fields):
                    calls.append((action,fields));assert action=='commit-artifact' and starts
                    return type('Result',(),{'disposition':{'disposition':'committed','artifactId':fields['artifact']['artifactId']}})()
            class Storage:
                async def request(self,grant,method,body,headers,*_):
                    assert starts
                    if method=='GET':
                        assert headers['if-match']=='"source"'
                        start,end=map(int,headers['range'][6:].split('-'))
                        return TransferResponse(206,{'etag':'"source"','content-length':str(end-start+1),'content-range':f'bytes {start}-{end}/{len(payload)}'},payload[start:end+1])
                    uploads[grant.url.rsplit('/',1)[-1]]=bytes(body)
                    return TransferResponse(200,{'ETag':hashlib.md5(body,usedforsecurity=False).hexdigest()},b'')
            async def verified_runtime(*_,**__):return fingerprint
            session=Session();package=await load_work_package(session)
            measurements=await run_prepare_clip(session,package,work,transport=Storage(),source_transport=Storage(),**({} if enforce_runtime else {'verify_runtime':verified_runtime}))
            self.assertEqual(len(starts),1)
            commits=[fields['artifact'] for action,fields in calls if action=='commit-artifact']
            self.assertEqual([value['role'] for value in commits],['clip_preview','preview_peaks','layout_evidence'])
            self.assertTrue(all(hashlib.sha256(uploads[value['artifactId']]).hexdigest()==value['sha256'] for value in commits))
            result=json.loads(uploads[outputs[-1]['artifactId']])
            self.assertEqual(result['preview']['artifactId'],outputs[0]['artifactId'])
            self.assertEqual(result['layout']['automatic']['engine'],'shot-layout-v1')
            self.assertGreater(measurements['bytesTransferred'],0)
            return {'kind':'video' if video else 'audio','enforcedRuntime':enforce_runtime,'starts':len(starts),'roles':[value['role'] for value in commits],
                'outputs':[{'role':value['role'],'byteLength':value['byteLength'],'sha256':value['sha256']} for value in commits],
                'measurements':measurements,'automaticEngine':result['layout']['automatic']['engine'],'screenObserved':result['layout']['screen'] is not None,'splitObserved':result['layout']['split'] is not None}
