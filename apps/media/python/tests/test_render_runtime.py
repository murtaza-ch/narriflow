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

    async def test_a_refused_upload_fails_only_its_variant_with_a_typed_retryable_code(self):
        await self.actual_operation(refused_upload=True)

    async def test_changed_source_probe_publishes_only_a_typed_permanent_failure_proof(self):
        await self.actual_operation(source_mismatch=True)

    async def test_two_hundred_frozen_assets_use_only_the_original_initial_grant_and_read_the_selected_asset_on_demand(self):
        await self.actual_operation(many_assets=True)

    async def test_three_hour_source_renders_a_ten_second_middle_window_without_reading_the_whole_source(self):
        await self.actual_operation(long_source=True)

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

    async def actual_operation(self,*,fingerprint='a'*64,enforce_runtime=False,lost_ack=False,source_mismatch=False,many_assets=False,long_source=False,source_path=None,source_sha256=None,prepared_bundle=None,resolution='720p',aspect_ratio='ratio_1_1',fixture_document=None,inspect_output=None,refused_upload=False):
        root=Path(__file__).resolve().parents[4]
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory);source=Path(source_path) if source_path is not None else base/'original.mp4';work=base/'work';work.mkdir()
            if source_path is None:
                subprocess.run(['ffmpeg','-nostdin','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=s=320x180:r=30:d=4','-f','lavfi','-i','sine=f=330:sample_rate=48000:d=4','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart','-shortest',str(source)],check=True,timeout=10)
            if long_source:
                piece=base/'piece.mp4';source.rename(piece)
                subprocess.run(['ffmpeg','-nostdin','-hide_banner','-loglevel','error','-y','-stream_loop','2699','-i',str(piece),'-t','10800','-c','copy','-movflags','+faststart',str(source)],check=True,timeout=60)
            source_size=source.stat().st_size
            if source_sha256 is None:
                with source.open('rb') as stream:source_sha=hashlib.file_digest(stream,'sha256').hexdigest()
            else:
                self.assertRegex(source_sha256,r'^[a-f0-9]{64}$');source_sha=source_sha256
            payload=None if long_source or source_path is not None else source.read_bytes()
            library_payload=None;audio=[]
            if many_assets:
                library=base/'library.wav'
                subprocess.run(['ffmpeg','-nostdin','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=f=880:sample_rate=16000:d=1','-c:a','pcm_s16le',str(library)],check=True,timeout=10)
                library_payload=library.read_bytes()
                audio=[{'name':f'audio_{index}','id':str(uuid4()),'title':'Fixture library','durationSec':1,'object':{'storageKey':f'audio/frozen/{index}',
                    'etag':'"library"','byteLength':len(library_payload),'sha256':hashlib.sha256(library_payload).hexdigest()}} for index in range(200)]
            if prepared_bundle is None:
                script="""import {readFileSync} from 'node:fs';import {productionWorkerProcessModule as worker} from './apps/media/src/worker-process.ts';import {clipPreparationBinding} from './packages/services/src/clip-preparation-input.ts';import {clipPreparationEngineHash,clipPreparationPreviewWindow} from './packages/services/src/clip-preparation-policy.ts';import {clipPreparationInputSchema} from './packages/validators/src/clip-preparation.ts';const raw=JSON.parse(readFileSync(0,'utf8'));raw.sourceProbe=(await worker.inspectMedia({sourcePath:raw.sourcePath,signal:new AbortController().signal,deadlineMs:10000})).sourceProbe;delete raw.sourcePath;raw.engineHash=await clipPreparationEngineHash(raw.toolchainFingerprint);raw.document=JSON.parse(readFileSync('./apps/media/src/__fixtures__/render-golden/documents.json','utf8')).cases['solo-auto-vertical'].document;const value=clipPreparationInputSchema.omit({bindingHash:true}).parse(raw);const preparation={...value,bindingHash:await clipPreparationBinding(value)};console.log(JSON.stringify({preparation,previewWindow:clipPreparationPreviewWindow(preparation)}));"""
                if source_mismatch:
                    script=script.replace('delete raw.sourcePath;', 'delete raw.sourcePath;raw.sourceProbe.video.width++;raw.sourceProbe.facts.videos[0].width++;')
                if many_assets:
                    script=script.replace('const value=clipPreparationInputSchema',f'raw.document.studioEdits.music={{assetId:{json.dumps(audio[-1]["id"])}}};const value=clipPreparationInputSchema')
                if long_source:
                    script=script.replace('const value=clipPreparationInputSchema',"raw.document.clipStartSec+=5400;raw.document.clipEndSec+=5406;for(const utterance of raw.document.transcriptSlice){utterance.startSec+=5400;utterance.endSec+=5400;for(const word of utterance.words??[]){word.startSec+=5400;word.endSec+=5400;}}const value=clipPreparationInputSchema")
                if fixture_document is not None:
                    script=script.replace('const value=clipPreparationInputSchema', 'raw.document=raw.fixtureDocument;delete raw.fixtureDocument;const value=clipPreparationInputSchema')
                raw={'version':1,'kind':'prepare_clip','preparationId':str(uuid4()),'projectId':str(uuid4()),'clipId':str(uuid4()),'sourceRevision':1,'editorRevision':0,
                    'toolchainFingerprint':fingerprint,'engineHash':'b'*64,'wholeSource':not long_source,'llmModel':'caption-only' if long_source or fixture_document is not None else 'fixture','sourcePath':str(source),
                    'source':{'storageKey':'execution/frozen/original','etag':'"source"','byteLength':source_size,'sha256':source_sha}}
                if fixture_document is not None:raw['fixtureDocument']=fixture_document
                prepared=subprocess.run(['bun','-e',script],input=json.dumps(raw).encode(),capture_output=True,cwd=root,timeout=20,check=True)
                generated=json.loads(prepared.stdout);preparation=generated['preparation'];preview_window=generated['previewWindow']
            else:
                preparation=prepared_bundle['preparation'];preview_window=prepared_bundle['ready']['result']['preview']
                self.assertEqual(preparation['source']['byteLength'],source_size);self.assertEqual(preparation['source']['sha256'],source_sha)
            render_id=str(uuid4());group_id=str(uuid4());hash='d'*64
            command={'version':1,'kind':'render_group','watermark':True,'groupId':group_id,'workflowRunId':str(uuid4()),'workSetGeneration':str(uuid4()),'preparation':preparation,
                'prepared':{'preview':dict(preparation['source'],storageKey='execution/prepared/preview.mp4'),'result':{'version':1,'preparationId':preparation['preparationId'],'bindingHash':preparation['bindingHash'],
                    'preview':{'artifactId':str(uuid4()),'startSec':preview_window['startSec'],'durationSec':preview_window['durationSec']},'peaks':{'state':'unavailable','reason':'peaks_unavailable'},
                    'layout':{'automatic':{'state':'failed','reason':'analysis_unavailable'},'screen':None,'split':None}}},
                'workspace':{'id':str(uuid4()),'ownerUserId':str(uuid4()),'pricingTier':'business' if long_source or prepared_bundle is not None else 'free'},'captionLanguage':None,'brandSnapshot':None,
                'clip':{'index':0,'title':None,'hookText':'fixture','category':'hook','brollCues':None},
                'variants':[{'renderId':render_id,'aspectRatio':aspect_ratio,'resolution':resolution,'exportVariantId':None,'export':None}],
                'assets':{'visuals':[],'fonts':[],'audio':audio,'logo':None},'autoBroll':{'configured':False,'request':None,'resolved':[]}}
            if prepared_bundle is not None:command['prepared']=prepared_bundle['ready']
            capsule=json.dumps(command,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
            outputs=[{'artifactId':str(uuid4()),'role':role,'bindingHash':artifact_binding(hash,render_id,role),'contentType':mime,'contentTypes':[mime],'maxBytes':maximum}
                for role,mime,maximum in [('render_variant','video/mp4',512*1024**2),('render_outcome','application/json',65536)]]
            uploads={};upload_parts={};calls=[];starts=[];source_reads=[]
            class Session:
                fence={'reference':{'inputHash':hash,'subject':{'kind':'render_group','id':group_id}},'attemptToken':str(uuid4()),'owner':str(uuid4())}
                remaining_seconds=180;cancel_event=threading.Event()
                def assert_live(self):
                    if self.cancel_event.is_set():raise RuntimeError('cancelled')
                def on_process_start(self,pid):os.kill(pid,0);starts.append(pid)
                def transfer(self,action,**fields):
                    calls.append((action,fields));result={}
                    if action=='work-package':result={'disposition':'work_package','functionName':'render_group','inputHash':hash,'input':({'kind':'object','url':'https://scoped.invalid/capsule','headers':{},'storageKey':'projects/frozen/render-input.json',
                            'etag':'"capsule"','byteLength':len(capsule),'sha256':hashlib.sha256(capsule).hexdigest()} if many_assets or prepared_bundle is not None else {'kind':'inline','command':command}),
                        'sources':[{'name':'original',**preparation['source'],'url':'https://scoped.invalid/original','headers':{'if-match':'"source"'}}],'outputs':outputs}
                    elif action=='source-read':
                        assert starts
                        name=fields['sourceId'];frozen=preparation['source'] if name=='original' else next(item['object'] for item in audio if item['name']==name)
                        result={'disposition':'source_read','sourceId':name,'object':frozen,'grant':{'url':'https://scoped.invalid/'+name,'headers':{'if-match':frozen['etag']}}}
                    elif action=='upload-initialize':result={'disposition':'upload_ready','artifactId':fields['artifactId'],'uploadId':'fixture','byteLength':fields['byteLength'],'partSizeBytes':16777216,'partCount':(fields['byteLength']+16777215)//16777216}
                    elif action=='upload-parts':result={'disposition':'upload_parts','artifactId':fields['artifactId'],'grants':[{'partNumber':part['partNumber'],'url':'https://scoped.invalid/'+fields['artifactId']+'/'+str(part['partNumber']),'headers':{}} for part in fields['parts']]}
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
                    if grant.url=='https://scoped.invalid/capsule':
                        self_size=len(capsule)
                        return TransferResponse(200,{'etag':'"capsule"','content-length':str(self_size)},capsule)
                    assert starts
                    if method=='GET':
                        original=grant.url.endswith('/original');data=payload if original else library_payload
                        etag='"source"' if original else '"library"'
                        assert headers['if-match']==etag;start,end=map(int,headers['range'][6:].split('-'))
                        if inspect_output is not None and original:source_reads.append({'start':start,'end':end,'ifMatch':headers['if-match']})
                        if original and payload is None:
                            with source.open('rb') as stream:stream.seek(start);body=stream.read(end-start+1)
                            size=source_size
                        else:
                            assert data is not None
                            body=data[start:end+1];size=len(data)
                        return TransferResponse(206,{'etag':etag,'content-length':str(end-start+1),'content-range':f'bytes {start}-{end}/{size}'},body)
                    artifact_id,part_number=grant.url.rsplit('/',2)[-2:]
                    if refused_upload and artifact_id==outputs[0]['artifactId']:return TransferResponse(400,{},b'')
                    upload_parts.setdefault(artifact_id,{})[int(part_number)]=bytes(body)
                    uploads[artifact_id]=b''.join(value for _,value in sorted(upload_parts[artifact_id].items()))
                    return TransferResponse(200,{'ETag':hashlib.md5(body,usedforsecurity=False).hexdigest()},b'')
            async def verified_runtime(*_,**__):return fingerprint
            session=Session();package=await load_work_package(session,transport=Storage())
            self.assertEqual([item['name'] for item in package.sources],['original'])
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
            if refused_upload:
                self.assertFalse(Session.cancel_event.is_set())
                self.assertEqual([item['role'] for item in commits],['render_outcome'])
                self.assertEqual(json.loads(uploads[outputs[1]['artifactId']]),{'version':1,'kind':'failed','renderId':render_id,
                    'bindingHash':outputs[1]['bindingHash'],'errorCode':'render_upload_failed','disposition':'retryable'})
                self.assertEqual(measured['outcome'],{'status':'failed','requested':1,'succeeded':0,'failed':1,'superseded':0})
                return measured
            if source_mismatch:
                self.assertEqual([item['role'] for item in commits],['render_outcome'])
                self.assertEqual(set(uploads),{outputs[1]['artifactId']})
                self.assertEqual(json.loads(uploads[outputs[1]['artifactId']]),{'version':1,'kind':'failed','renderId':render_id,
                    'bindingHash':outputs[1]['bindingHash'],'errorCode':'source_identity_mismatch','disposition':'permanent'})
                self.assertEqual(measured['outcome'],{'status':'failed','requested':1,'succeeded':0,'failed':1,'superseded':0})
                return measured
            self.assertEqual([item['role'] for item in commits],['render_variant'],uploads.get(outputs[1]['artifactId']))
            self.assertEqual(hashlib.sha256(uploads[outputs[0]['artifactId']]).hexdigest(),commits[0]['sha256'])
            self.assertEqual(commits[0]['renderVariant']['usedStockIds'],[])
            self.assertEqual(measured['outcome'],{'status':'completed','requested':1,'succeeded':1,'failed':0,'superseded':0})
            if long_source:
                self.assertGreaterEqual(preparation['sourceProbe']['durationSec'],10800)
                self.assertEqual(preparation['document']['clipStartSec'],5400)
                self.assertEqual(preparation['document']['clipEndSec'],5410)
                self.assertLess(measured['bytesTransferred'],source_size)
                measured.update(sourceByteLength=source_size,sourceDurationSec=preparation['sourceProbe']['durationSec'],
                    requestedWindow={'startSec':5400,'endSec':5410},previewWindow=preview_window)
            if many_assets:
                names=sorted({fields['sourceId'] for action,fields in calls if action=='source-read'})
                self.assertEqual(names,['audio_199','original'])
                measured['frozenAssetCount']=len(audio);measured['sourceNamesRead']=names
            if inspect_output is not None:
                output_path=base/'uploaded-output.mp4';output_path.write_bytes(uploads[outputs[0]['artifactId']])
                measured['outputValidation']=inspect_output(output_path,source_reads)
            return measured
