import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from contextlib import redirect_stderr
from io import StringIO
from unittest.mock import patch, AsyncMock
from uuid import uuid4

from narriflow_media.render_runtime import run_render_group,artifact_binding
from narriflow_media.multipart import TransferResponse
from narriflow_media.transfer import load_work_package
from narriflow_media.artifacts import ArtifactCommitUnconfirmed
from narriflow_media.native_runtime import NativeOperationFailure
from narriflow_media.process import ProcessResult


class RenderRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_renderer_uploads_measured_bytes_then_waits_for_real_final_ack(self):
        await self.actual_operation()

    async def test_lost_publication_ack_retains_completed_upload_without_failure_or_cleanup_mutation(self):
        await self.actual_operation(lost_ack=True)

    async def test_changed_source_probe_publishes_only_a_typed_permanent_failure_proof(self):
        await self.actual_operation(source_mismatch=True)

    async def test_interruption_logs_only_bounded_numeric_phase_and_control_facts(self):
        identity,group_id=str(uuid4()),str(uuid4());input_hash='d'*64
        source={'storageKey':'execution/frozen/original','etag':'"source"','byteLength':5,'sha256':'a'*64}
        command={'version':1,'kind':'render_group','groupId':group_id,'preparation':{'source':source,'toolchainFingerprint':'a'*64},
            'variants':[{'renderId':identity}],'assets':{'visuals':[],'fonts':[],'audio':[],'logo':None},'autoBroll':{'resolved':[]}}
        outputs=[{'artifactId':str(uuid4()),'role':role,'bindingHash':artifact_binding(input_hash,identity,role),'contentType':mime,'contentTypes':[mime],'maxBytes':maximum}
            for role,mime,maximum in [('render_variant','video/mp4',1024),('render_outcome','application/json',65536)]]
        class Session:
            fence={'reference':{'inputHash':input_hash,'subject':{'kind':'render_group','id':group_id}},'attemptToken':str(uuid4()),'owner':str(uuid4())}
            remaining_seconds=60;cancel_event=threading.Event()
            def assert_live(self):pass
            def transfer(self,action,**fields):
                assert action=='work-package'
                return type('Result',(),{'disposition':{'functionName':'render_group','inputHash':input_hash,'input':{'kind':'inline','command':command},'sources':[{'name':'original',**source}],'outputs':outputs}})()
        async def verified(*_,**__):return 'a'*64
        result=ProcessResult(70,b'',json.dumps({'message':'clip_render_attempt_metrics','counts':{'detectorExecutions':0},'phaseMs':{'probe':2,'encode':float('nan'),'private':'https://signed.invalid/?key=private'},'caption':'private caption'}).encode())
        session=Session();package=await load_work_package(session);logs=StringIO()
        with tempfile.TemporaryDirectory() as directory,patch('narriflow_media.render_runtime.run_owned_process_async',AsyncMock(return_value=result)),redirect_stderr(logs):
            with self.assertRaises(NativeOperationFailure):await run_render_group(session,package,Path(directory),verify_runtime=verified)
        measured=json.loads(logs.getvalue())
        self.assertEqual(measured['phaseMs'],{'probe':2})
        self.assertEqual(measured['controlOperations'],{})
        self.assertEqual(measured['sourceBytesTransferred'],0)
        self.assertNotIn('private',logs.getvalue())

    async def actual_operation(self,*,fingerprint='a'*64,enforce_runtime=False,lost_ack=False,source_mismatch=False):
        root=Path(__file__).resolve().parents[4]
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory);source=base/'original.mp4';work=base/'work';work.mkdir()
            subprocess.run(['ffmpeg','-nostdin','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=s=320x180:r=30:d=4','-f','lavfi','-i','sine=f=330:sample_rate=48000:d=4','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart','-shortest',str(source)],check=True,timeout=10)
            payload=source.read_bytes()
            script="""import {readFileSync} from 'node:fs';import {productionWorkerProcessModule as worker} from './apps/media/src/worker-process.ts';import {clipPreparationBinding} from './packages/services/src/clip-preparation-input.ts';import {clipPreparationEngineHash} from './packages/services/src/clip-preparation-policy.ts';import {clipPreparationInputSchema} from './packages/validators/src/clip-preparation.ts';const raw=JSON.parse(readFileSync(0,'utf8'));raw.sourceProbe=(await worker.inspectMedia({sourcePath:raw.sourcePath,signal:new AbortController().signal,deadlineMs:10000})).sourceProbe;delete raw.sourcePath;raw.engineHash=await clipPreparationEngineHash(raw.toolchainFingerprint);raw.document=JSON.parse(readFileSync('./apps/media/src/__fixtures__/render-golden/documents.json','utf8')).cases['solo-auto-vertical'].document;const value=clipPreparationInputSchema.omit({bindingHash:true}).parse(raw);console.log(JSON.stringify({...value,bindingHash:await clipPreparationBinding(value)}));"""
            if source_mismatch:
                script=script.replace('delete raw.sourcePath;', 'delete raw.sourcePath;raw.sourceProbe.video.width++;raw.sourceProbe.facts.videos[0].width++;')
            raw={'version':1,'kind':'prepare_clip','preparationId':str(uuid4()),'projectId':str(uuid4()),'clipId':str(uuid4()),'sourceRevision':1,'editorRevision':0,
                'toolchainFingerprint':fingerprint,'engineHash':'b'*64,'wholeSource':True,'llmModel':'fixture','sourcePath':str(source),
                'source':{'storageKey':'execution/frozen/original','etag':'"source"','byteLength':len(payload),'sha256':hashlib.sha256(payload).hexdigest()}}
            prepared=subprocess.run(['bun','-e',script],input=json.dumps(raw).encode(),capture_output=True,cwd=root,timeout=20,check=True)
            preparation=json.loads(prepared.stdout);render_id=str(uuid4());group_id=str(uuid4());hash='d'*64
            command={'version':1,'kind':'render_group','watermark':True,'groupId':group_id,'workflowRunId':str(uuid4()),'workSetGeneration':str(uuid4()),'preparation':preparation,
                'prepared':{'preview':dict(preparation['source'],storageKey='execution/prepared/preview.mp4'),'result':{'version':1,'preparationId':preparation['preparationId'],'bindingHash':preparation['bindingHash'],
                    'preview':{'artifactId':str(uuid4()),'startSec':0,'durationSec':4},'peaks':{'state':'unavailable','reason':'peaks_unavailable'},
                    'layout':{'automatic':{'state':'failed','reason':'analysis_unavailable'},'screen':None,'split':None}}},
                'workspace':{'id':str(uuid4()),'ownerUserId':str(uuid4()),'pricingTier':'free'},'captionLanguage':None,'brandSnapshot':None,
                'clip':{'index':0,'title':None,'hookText':'fixture','category':'hook','brollCues':None},
                'variants':[{'renderId':render_id,'aspectRatio':'ratio_1_1','resolution':'720p','exportVariantId':None,'export':None}],
                'assets':{'visuals':[],'fonts':[],'audio':[],'logo':None},'autoBroll':{'configured':False,'request':None,'resolved':[]}}
            outputs=[{'artifactId':str(uuid4()),'role':role,'bindingHash':artifact_binding(hash,render_id,role),'contentType':mime,'contentTypes':[mime],'maxBytes':maximum}
                for role,mime,maximum in [('render_variant','video/mp4',512*1024**2),('render_outcome','application/json',65536)]]
            uploads={};calls=[];starts=[]
            class Session:
                fence={'reference':{'inputHash':hash,'subject':{'kind':'render_group','id':group_id}},'attemptToken':str(uuid4()),'owner':str(uuid4())}
                remaining_seconds=180;cancel_event=threading.Event()
                def assert_live(self):
                    if self.cancel_event.is_set():raise RuntimeError('cancelled')
                def on_process_start(self,pid):os.kill(pid,0);starts.append(pid)
                def transfer(self,action,**fields):
                    calls.append((action,fields));result={}
                    if action=='work-package':result={'disposition':'work_package','functionName':'render_group','inputHash':hash,'input':{'kind':'inline','command':command},
                        'sources':[{'name':'original',**preparation['source'],'url':'https://scoped.invalid/original','headers':{'if-match':'"source"'}}],'outputs':outputs}
                    elif action=='source-read':
                        assert starts
                        result={'disposition':'source_read','sourceId':'original','object':preparation['source'],'grant':{'url':'https://scoped.invalid/original','headers':{'if-match':'"source"'}}}
                    elif action=='upload-initialize':result={'disposition':'upload_ready','artifactId':fields['artifactId'],'uploadId':'fixture','byteLength':fields['byteLength'],'partSizeBytes':16777216,'partCount':1}
                    elif action=='upload-parts':result={'disposition':'upload_parts','artifactId':fields['artifactId'],'grants':[{'partNumber':1,'url':'https://scoped.invalid/'+fields['artifactId'],'headers':{}}]}
                    elif action=='upload-complete':
                        output=next(item for item in outputs if item['artifactId']==fields['artifactId'])
                        result={'disposition':'upload_completed','artifactId':output['artifactId'],'object':{'key':'execution/'+output['artifactId'],'etag':'"sealed"','byteLength':fields['byteLength'],'sha256':fields['sha256'],'contentType':output['contentType']}}
                    else:raise AssertionError(action)
                    return type('Result',(),{'disposition':result})()
                def command(self,action,**fields):
                    calls.append((action,fields));assert starts
                    if action=='read-disposition':return type('Result',(),{'disposition':{'disposition':'started'}})()
                    assert action=='commit-artifact'
                    if lost_ack:
                        from narriflow_media.control import ExecutionControlError
                        raise ExecutionControlError('execution_http_unavailable')
                    failed=fields['artifact']['role']=='render_outcome'
                    return type('Result',(),{'disposition':{'disposition':'committed','artifactId':fields['artifact']['artifactId'],
                        'renderGroup':{'status':'failed' if failed else 'completed','requested':1,'succeeded':0 if failed else 1,'failed':1 if failed else 0,'superseded':0}}})()
            class Storage:
                async def request(self,grant,method,body,headers,*_):
                    assert starts
                    if method=='GET':
                        assert headers['if-match']=='"source"';start,end=map(int,headers['range'][6:].split('-'))
                        return TransferResponse(206,{'etag':'"source"','content-length':str(end-start+1),'content-range':f'bytes {start}-{end}/{len(payload)}'},payload[start:end+1])
                    uploads[grant.url.rsplit('/',1)[-1]]=bytes(body)
                    return TransferResponse(200,{'ETag':hashlib.md5(body,usedforsecurity=False).hexdigest()},b'')
            async def verified_runtime(*_,**__):return fingerprint
            session=Session();package=await load_work_package(session)
            if lost_ack:
                with self.assertRaises(ArtifactCommitUnconfirmed):
                    await run_render_group(session,package,work,transport=Storage(),source_transport=Storage(),**({} if enforce_runtime else {'verify_runtime':verified_runtime}))
                self.assertEqual([action for action,_ in calls if action in {'commit-artifact','fail','upload-abort'}],['commit-artifact'])
                self.assertEqual(list(uploads),[outputs[0]['artifactId']])
                return
            measured=await run_render_group(session,package,work,transport=Storage(),source_transport=Storage(),**({} if enforce_runtime else {'verify_runtime':verified_runtime}))
            self.assertEqual(len(starts),1)
            self.assertEqual(measured['detectorExecutions'],0)
            commits=[fields['artifact'] for action,fields in calls if action=='commit-artifact']
            measured={**measured,'starts':len(starts),'artifacts':[{'role':item['role'],'byteLength':item['byteLength'],'sha256':item['sha256']} for item in commits]}
            if source_mismatch:
                self.assertEqual([item['role'] for item in commits],['render_outcome'])
                self.assertEqual(set(uploads),{outputs[1]['artifactId']})
                self.assertEqual(json.loads(uploads[outputs[1]['artifactId']]),{'version':1,'kind':'failed','renderId':render_id,
                    'bindingHash':outputs[1]['bindingHash'],'errorCode':'source_identity_mismatch','disposition':'permanent'})
                self.assertEqual(measured['outcome'],{'status':'failed','requested':1,'succeeded':0,'failed':1,'superseded':0})
                return measured
            self.assertEqual([item['role'] for item in commits],['render_variant'])
            self.assertEqual(hashlib.sha256(uploads[outputs[0]['artifactId']]).hexdigest(),commits[0]['sha256'])
            self.assertEqual(commits[0]['renderVariant']['usedStockIds'],[])
            self.assertEqual(measured['outcome'],{'status':'completed','requested':1,'succeeded':1,'failed':0,'superseded':0})
            return measured
