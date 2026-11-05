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

from narriflow_media.clip_preparation_runtime import preparation_phases, run_prepare_clip
from narriflow_media.multipart import TransferResponse
from narriflow_media.transfer import load_work_package


class ClipPreparationRuntimeTests(unittest.IsolatedAsyncioTestCase):
    def test_only_known_finite_phases_leave_the_child_diagnostics(self):
        line=json.dumps({'message':'clip_preparation_metrics','phaseMs':{'faces':12,'preview':float('nan'),'private':'https://signed.invalid/?token'}})
        self.assertEqual(preparation_phases(b'not json\n'+line.encode()),{'faces':12})
        self.assertEqual(preparation_phases(b'{"message":"other"}'),{})

    async def test_actual_bun_child_starts_before_conditional_source_reads_and_commits_real_outputs_in_order(self):
        await self.actual_operation()

    async def actual_operation(self, *, video=False, fingerprint='a'*64, enforce_runtime=False, source_path=None, source_sha256=None, window=None, project_id=None, capture=False):
        root=Path(__file__).resolve().parents[4]
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory);original=Path(source_path) if source_path is not None else base/('original.mp4' if video else 'original.wav');work=base/'work';work.mkdir()
            if source_path is None:
                subprocess.run(['ffmpeg','-nostdin','-hide_banner','-loglevel','error','-y',*(['-f','lavfi','-i','testsrc2=s=320x180:r=30:d=4','-f','lavfi','-i','sine=f=330:sample_rate=48000:d=4','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart','-shortest'] if video else ['-f','lavfi','-i','sine=f=330:sample_rate=16000:d=4','-c:a','pcm_s16le']),str(original)],check=True,timeout=10)
            source_size=original.stat().st_size
            if source_sha256 is None:
                with original.open('rb') as stream:source_sha=hashlib.file_digest(stream,'sha256').hexdigest()
            else:
                self.assertRegex(source_sha256,r'^[a-f0-9]{64}$');source_sha=source_sha256
            payload=original.read_bytes() if source_path is None else None
            script="""import {readFileSync} from 'node:fs';import {productionWorkerProcessModule as worker} from './apps/media/src/worker-process.ts';import {clipPreparationBinding} from './packages/services/src/clip-preparation-input.ts';import {clipPreparationEngineHash} from './packages/services/src/clip-preparation-policy.ts';import {clipPreparationInputSchema} from './packages/validators/src/clip-preparation.ts';const raw=JSON.parse(readFileSync(0,'utf8'));raw.sourceProbe=(await worker.inspectMedia({sourcePath:raw.sourcePath,signal:new AbortController().signal,deadlineMs:10000})).sourceProbe;delete raw.sourcePath;raw.engineHash=await clipPreparationEngineHash(raw.toolchainFingerprint);raw.document=JSON.parse(readFileSync('./apps/media/src/__fixtures__/render-golden/documents.json','utf8')).cases['solo-auto-vertical'].document;const value=clipPreparationInputSchema.omit({bindingHash:true}).parse(raw);console.log(JSON.stringify({...value,bindingHash:await clipPreparationBinding(value)}));"""
            if window is not None:
                start_sec,end_sec=window
                script=script.replace('const value=clipPreparationInputSchema',f'raw.document.clipStartSec={start_sec};raw.document.clipEndSec={end_sec};for(const utterance of raw.document.transcriptSlice){{utterance.startSec+={start_sec};utterance.endSec+={start_sec};for(const word of utterance.words??[]){{word.startSec+={start_sec};word.endSec+={start_sec};}}}}const value=clipPreparationInputSchema')
            raw={'version':1,'kind':'prepare_clip','preparationId':str(uuid4()),'projectId':project_id or str(uuid4()),'clipId':str(uuid4()),'sourceRevision':1,'editorRevision':0,
                'toolchainFingerprint':fingerprint,'engineHash':'b'*64,'wholeSource':window is None,'llmModel':'caption-only' if window is not None else 'fixture','sourcePath':str(original),
                'source':{'storageKey':'execution/frozen/original','etag':'"source"','byteLength':source_size,'sha256':source_sha}}
            prepared=subprocess.run(['bun','-e',script],input=json.dumps(raw).encode(),capture_output=True,cwd=root,timeout=20,check=True)
            command=json.loads(prepared.stdout);uploads={};upload_parts={};calls=[];starts=[]
            capsule=json.dumps(command,separators=(',',':'),ensure_ascii=False).encode()
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
                    if action=='work-package':result={'disposition':'work_package','functionName':'prepare_clip','inputHash':'d'*64,'input':({'kind':'object','url':'https://scoped.invalid/capsule','headers':{},'storageKey':'projects/frozen/preparation.json','etag':'"capsule"','byteLength':len(capsule),'sha256':hashlib.sha256(capsule).hexdigest()} if capture else {'kind':'inline','command':command}),
                        'sources':[{'name':'original',**command['source'],'url':'https://scoped.invalid/original','headers':{'if-match':'"source"'}}],'outputs':outputs}
                    elif action=='source-read':
                        assert starts
                        result={'disposition':'source_read','sourceId':'original','object':command['source'],'grant':{'url':'https://scoped.invalid/original','headers':{'if-match':'"source"'}}}
                    elif action=='upload-initialize':result={'disposition':'upload_ready','artifactId':fields['artifactId'],'uploadId':'fixture','byteLength':fields['byteLength'],'partSizeBytes':16777216,'partCount':(fields['byteLength']+16777215)//16777216}
                    elif action=='upload-parts':result={'disposition':'upload_parts','artifactId':fields['artifactId'],'grants':[{'partNumber':part['partNumber'],'url':'https://scoped.invalid/'+fields['artifactId']+'/'+str(part['partNumber']),'headers':{}} for part in fields['parts']]}
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
                    if grant.url=='https://scoped.invalid/capsule':return TransferResponse(200,{'etag':'"capsule"','content-length':str(len(capsule))},capsule)
                    assert starts
                    if method=='GET':
                        assert headers['if-match']=='"source"'
                        start,end=map(int,headers['range'][6:].split('-'))
                        if payload is None:
                            with original.open('rb') as stream:stream.seek(start);data=stream.read(end-start+1)
                        else:data=payload[start:end+1]
                        return TransferResponse(206,{'etag':'"source"','content-length':str(end-start+1),'content-range':f'bytes {start}-{end}/{source_size}'},data)
                    artifact_id,part_number=grant.url.rsplit('/',2)[-2:]
                    upload_parts.setdefault(artifact_id,{})[int(part_number)]=bytes(body)
                    uploads[artifact_id]=b''.join(value for _,value in sorted(upload_parts[artifact_id].items()))
                    return TransferResponse(200,{'ETag':hashlib.md5(body,usedforsecurity=False).hexdigest()},b'')
            async def verified_runtime(*_,**__):return fingerprint
            session=Session();package=await load_work_package(session,transport=Storage())
            measurements=await run_prepare_clip(session,package,work,transport=Storage(),source_transport=Storage(),**({} if enforce_runtime else {'verify_runtime':verified_runtime}))
            self.assertEqual(len(starts),1)
            commits=[fields['artifact'] for action,fields in calls if action=='commit-artifact']
            self.assertEqual([value['role'] for value in commits],['clip_preview','preview_peaks','layout_evidence'])
            self.assertTrue(all(hashlib.sha256(uploads[value['artifactId']]).hexdigest()==value['sha256'] for value in commits))
            result=json.loads(uploads[outputs[-1]['artifactId']])
            self.assertEqual(result['preview']['artifactId'],outputs[0]['artifactId'])
            if not capture:self.assertEqual(result['layout']['automatic']['engine'],'shot-layout-v1')
            self.assertGreater(measurements['bytesTransferred'],0)
            summary={'kind':'video' if video else 'audio','enforcedRuntime':enforce_runtime,'starts':len(starts),'roles':[value['role'] for value in commits],
                'outputs':[{'role':value['role'],'byteLength':value['byteLength'],'sha256':value['sha256']} for value in commits],
                'measurements':measurements,'automaticEngine':result['layout']['automatic'].get('engine'),'screenObserved':result['layout']['screen'] is not None,'splitObserved':result['layout']['split'] is not None}
            if capture:
                preview=commits[0]
                summary['preparation']=command
                summary['ready']={'preview':{'storageKey':'execution/'+preview['artifactId'],'etag':preview['etag'],'byteLength':preview['byteLength'],'sha256':preview['sha256']},'result':result}
            return summary
