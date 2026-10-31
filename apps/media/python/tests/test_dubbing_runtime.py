import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
from uuid import uuid4

from narriflow_media.artifacts import ArtifactCommitUnconfirmed
from narriflow_media.control import ExecutionControlError
from narriflow_media.dubbing_runtime import run_dubbing, artifact_binding, STAGES
from narriflow_media.multipart import TransferResponse
from narriflow_media.transfer import load_work_package


class DubbingRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_child_commits_ordered_paid_stages_and_real_mux_then_recovery_posts_nothing(self):
        await self.operation('success')

    async def test_unknown_final_ack_retains_sealed_media_without_another_publication(self):
        await self.operation('lost_final')

    async def test_lost_intent_ack_and_revoked_authority_prevent_paid_post(self):
        for mode in ('lost_intent','revoked','lost_start'):
            await self.operation(mode)

    async def operation(self,mode,*,fingerprint="a"*64,enforce_runtime=False):
        root=Path(__file__).resolve().parents[4];run_id,dub_id=str(uuid4()),str(uuid4())
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary);base=directory/'base.mp4';audio=directory/'speech.mp3'
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=10:d=2','-an','-c:v','libx264','-pix_fmt','yuv420p',str(base)],check=True,capture_output=True,timeout=10)
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','sine=frequency=440:duration=1.5','-c:a','libmp3lame',str(audio)],check=True,capture_output=True,timeout=10)
            base_bytes=base.read_bytes();audio_bytes=audio.read_bytes();starts=[];calls=[];posts=[];objects={};commits=[]
            request={'version':1,'kind':'dubbing_request','dubId':dub_id,'workflowRunId':run_id,'projectId':str(uuid4()),'workspaceId':str(uuid4()),'actorUserId':str(uuid4()),'clipId':str(uuid4()),
                'editorRevision':1,'sourceRevision':1,'baseRender':{'id':str(uuid4()),'storageKey':'projects/frozen/base.mp4','byteLength':len(base_bytes),'durationSec':2},
                'script':'The frozen script','sourceLanguageCode':'en','targetLanguageCode':'es','voice':'marin','aspectRatio':'9:16','provider':'openai','model':'gpt-4o-mini-tts','translationModel':'gpt-5.4-mini'}
            raw={'version':1,'kind':'dub_mix','request':request,'toolchainFingerprint':fingerprint,'baseVideo':{'storageKey':request['baseRender']['storageKey'],'etag':'"base"','byteLength':len(base_bytes)}}
            encoded=subprocess.run(['bun','-e',"import {readFileSync} from 'node:fs';import {frozenDubbingRequestHash} from './packages/services/src/dubbing-policy.ts';import {dubbingInputBinding} from './packages/services/src/dubbing-input.ts';let v=JSON.parse(readFileSync(0,'utf8'));v.requestHash=await frozenDubbingRequestHash(v.request);console.log(JSON.stringify({...v,bindingHash:await dubbingInputBinding(v)}));"],input=json.dumps(raw).encode(),capture_output=True,check=True,cwd=root,timeout=10)
            command=json.loads(encoded.stdout);expires=(datetime.now(timezone.utc)+timedelta(minutes=10)).isoformat().replace('+00:00','Z')
            source_objects={'base_video':command['baseVideo']};source_payloads={'base_video':base_bytes}
            outputs=[{'artifactId':str(uuid4()),'role':role,'bindingHash':artifact_binding(command['requestHash'],stage),'contentType':mime,'contentTypes':[mime],'maxBytes':maximum} for stage,(role,mime,maximum) in STAGES.items()]
            output_stage={output['artifactId']:stage for stage,output in zip(STAGES,outputs)}
            class Provider(BaseHTTPRequestHandler):
                def log_message(self,*_):pass
                def do_POST(self):
                    self.close_connection=True
                    assert self.headers.get('Authorization')=='Bearer dedicated-fixture-key'
                    assert starts and 'read-disposition' in [action for action,_ in calls]
                    body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    posts.append(self.path)
                    if self.path=='/v1/responses':
                        assert body['model']=='gpt-5.4-mini';assert commits[-1]=='translation_intent'
                        content=json.dumps({'id':'resp_controlled','output_text':'El guion congelado'}).encode();mime='application/json'
                    else:
                        assert self.path=='/v1/audio/speech';assert body['input']=='El guion congelado';assert commits[-1]=='speech_intent'
                        content=audio_bytes;mime='audio/mpeg'
                    self.send_response(200);self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(content)));self.end_headers();self.wfile.write(content)
            provider=ThreadingHTTPServer(('127.0.0.1',0),Provider);provider.daemon_threads=True;thread=threading.Thread(target=provider.serve_forever,daemon=True);thread.start()
            cli=directory/'controlled.ts'
            cli.write_text("import {runDubbingCli} from "+json.dumps(str(root/'apps/media/src/dubbing-cli.ts'))+";\nif(process.env.DATABASE_URL||process.env.REDIS_URL||process.env.R2_SECRET_ACCESS_KEY||process.env.EXECUTOR_CONTROL_KEYS_JSON||process.env.DATA_ENCRYPTION_KEY||process.env.MODAL_TOKEN_SECRET||process.env.HTTP_PROXY)throw Error('unsanitized_environment');\nawait runDubbingCli((url,options)=>fetch(new URL(new URL(url).pathname,"+json.dumps(f'http://127.0.0.1:{provider.server_address[1]}')+"),{method:'POST',headers:options.headers,body:String(options.body),signal:options.signal}));\n")
            class Session:
                fence={'reference':{'subject':{'kind':'workflow_run','id':run_id},'inputHash':'b'*64},'attemptToken':str(uuid4()),'owner':str(uuid4())}
                remaining_seconds=120
                def __init__(self):self.cancel_event=threading.Event()
                def assert_live(self):
                    if self.cancel_event.is_set():raise ExecutionControlError('execution_authority_lost')
                def on_process_start(self,pid):
                    os.kill(pid,0);starts.append(pid)
                    if mode=='lost_start':raise ExecutionControlError('execution_http_unavailable')
                def transfer(self,action,**fields):
                    calls.append((action,fields))
                    if action=='work-package':value={'functionName':'dub_mix','inputHash':'b'*64,'input':{'kind':'inline','command':command},
                        'sources':[{'name':name,**source,'url':'https://scoped.invalid/'+name,'headers':{},'expiresAt':expires} for name,source in source_objects.items()],'outputs':outputs}
                    else:
                        assert starts
                        if action=='source-read':
                            name=fields['sourceId'];value={'disposition':'source_read','sourceId':name,'object':source_objects[name],'grant':{'url':'https://scoped.invalid/'+name,'headers':{}}}
                        elif action=='upload-initialize':value={'disposition':'upload_ready','artifactId':fields['artifactId'],'uploadId':fields['artifactId'],'byteLength':fields['byteLength'],'partSizeBytes':16777216,'partCount':1}
                        elif action=='upload-parts':value={'disposition':'upload_parts','artifactId':fields['artifactId'],'grants':[{'partNumber':1,'url':'https://scoped.invalid/upload/'+fields['artifactId'],'headers':{}}]}
                        elif action=='upload-complete':
                            identity=fields['artifactId'];mime=next(output['contentType'] for output in outputs if output['artifactId']==identity)
                            value={'disposition':'upload_completed','artifactId':identity,'object':{'key':'execution/frozen/'+identity,'etag':'"'+identity+'"','byteLength':fields['byteLength'],'sha256':fields['sha256'],'contentType':mime}}
                        else:raise AssertionError(action)
                    return type('Result',(),{'disposition':value})()
                def command(self,action,**fields):
                    calls.append((action,fields));assert starts
                    if action=='read-disposition':return type('Result',(),{'disposition':{'disposition':'failed' if mode=='revoked' else 'started'}})()
                    assert action=='commit-artifact';identity=fields['artifact']['artifactId'];stage=output_stage[identity];commits.append(stage)
                    if (mode=='lost_intent' and stage=='translation_intent') or (mode=='lost_final' and stage=='final_result'):raise ExecutionControlError('execution_http_unavailable')
                    return type('Result',(),{'disposition':{'disposition':'committed','artifactId':identity}})()
            class Storage:
                async def request(self,grant,method,body,headers,*_):
                    assert starts
                    if method=='GET':
                        name=grant.url.rsplit('/',1)[-1];payload=source_payloads[name];assert headers['if-match']==source_objects[name]['etag'];start,end=map(int,headers['range'][6:].split('-'))
                        return TransferResponse(206,{'etag':source_objects[name]['etag'],'content-length':str(end-start+1),'content-range':f'bytes {start}-{end}/{len(payload)}'},payload[start:end+1])
                    identity=grant.url.rsplit('/',1)[-1];objects[identity]=bytes(body)
                    return TransferResponse(200,{'ETag':hashlib.md5(body,usedforsecurity=False).hexdigest()},b'')
            async def verified(session,**options):
                if enforce_runtime:
                    from narriflow_media.source_runtime import verify_source_runtime
                    return await verify_source_runtime(session,**options)
                return fingerprint
            session=Session();package=await load_work_package(session);work=directory/'work';work.mkdir()
            try:
                with patch.dict(os.environ,{'DATABASE_URL':'must-not-reach-child','REDIS_URL':'must-not-reach-child','R2_SECRET_ACCESS_KEY':'must-not-reach-child','HTTP_PROXY':'http://forbidden.invalid','EXECUTOR_CONTROL_KEYS_JSON':'must-not-reach-child','DATA_ENCRYPTION_KEY':'must-not-reach-child','MODAL_TOKEN_SECRET':'must-not-reach-child'}):
                    operation=run_dubbing(session,package,work,api_key='dedicated-fixture-key',transport=Storage(),source_transport=Storage(),verify_runtime=verified,cli_path=cli)
                    if mode in {'lost_final','lost_intent'}:
                        with self.assertRaises(ArtifactCommitUnconfirmed):await operation
                    elif mode in {'revoked','lost_start'}:
                        with self.assertRaises(ExecutionControlError):await operation
                    else:
                        result=await operation;self.assertEqual(result['outcome'],'completed')
                self.assertEqual(len(starts),1)
                if mode in {'lost_intent','revoked','lost_start'}:
                    self.assertEqual(posts,[])
                    if mode=='lost_start':self.assertEqual(commits,[]);self.assertFalse(any(action=='source-read' for action,_ in calls))
                else:
                    self.assertEqual(posts,['/v1/responses','/v1/audio/speech']);self.assertEqual(commits,list(STAGES))
                    self.assertEqual(len(objects),6)
                    final=json.loads(objects[next(identity for identity,stage in output_stage.items() if stage=='final_result')])
                    self.assertEqual(final['outcome'],'completed')
                    video_id=next(identity for identity,stage in output_stage.items() if stage=='video')
                    self.assertEqual(final['video'],{'byteLength':len(objects[video_id]),'sha256':hashlib.sha256(objects[video_id]).hexdigest()})
                    self.assertTrue((work/'dub.mp4').is_file());self.assertEqual(final['probe']['state'],'ready')
                    self.assertFalse(any(action in {'fail','upload-abort'} for action,_ in calls))
                    if mode=='success':
                        for name,stage in [('translation_result','translation_result'),('dub_audio','audio'),('dub_video','video')]:
                            identity=next(identity for identity,value in output_stage.items() if value==stage);payload=objects[identity]
                            source_payloads[name]=payload;source_objects[name]={'storageKey':'execution/frozen/'+identity,'etag':'"'+identity+'"','byteLength':len(payload),'sha256':hashlib.sha256(payload).hexdigest()}
                        outputs[:]=[output for output in outputs if output_stage[output['artifactId']]=='final_result']
                        outputs[0]={**outputs[0],'artifactId':str(uuid4())};output_stage[outputs[0]['artifactId']]='final_result'
                        recovered=directory/'recovered';recovered.mkdir();session=Session();package=await load_work_package(session)
                        result=await run_dubbing(session,package,recovered,transport=Storage(),source_transport=Storage(),verify_runtime=verified,cli_path=cli)
                        self.assertEqual(result['outcome'],'completed');self.assertEqual(len(posts),2);self.assertEqual(len(starts),2)
                return {'mode':mode,'nativeStarts':len(starts),'controlledProviderRequests':len(posts),'committedStageAcknowledgements':len(commits),'completedObjectsRetained':len(objects)}
            finally:
                provider.shutdown();provider.server_close();thread.join(timeout=1)
