from __future__ import annotations

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

from narriflow_media.publication_runtime import run_publication, PublicationFailure
from narriflow_media.process import MediaProcessError
from narriflow_media.transfer import WorkPackage, _wire

ROOT=Path(__file__).resolve().parents[4]
FIXTURE="""import {derivePublicationPurposeKey,sealPublicationPayload} from './packages/services/src/publication-checkpoint-blob.ts';import {parseSocialPublicationConfig} from './packages/services/src/social-publication-config.ts';import {SOCIAL_PROVIDER_CAPABILITIES} from './packages/validators/src/index.ts';const id=()=>crypto.randomUUID(),now=new Date(),future=new Date(+now+3600000).toISOString(),scope={deploymentEpoch:1,socialPostId:id(),attemptId:id(),claimId:id(),bindingHash:'a'.repeat(64)},accountId=id(),projectId=id(),workspaceId=id(),master='test-publication-checkpoint-master-only',all=parseSocialPublicationConfig({SOCIAL_PUBLICATION_CHECKPOINT_KEY:master}),{linkedInVersionSunsetAt,...config}=all.providers;const loaded={socialPost:{id:scope.socialPostId,workspaceId,projectId,status:'publishing',scheduledFor:now.toISOString()},frozen:{clipExportId:id(),clipExportVariantId:id(),editorRevision:0,exportFingerprint:'fixture',storageKey:'execution/frozen/media.mp4',sizeBytes:8,durationSec:1,aspectRatio:'9:16',caption:'Approved fixture',providerSettings:{youtubePrivacyStatus:'unlisted'},socialAccountId:accountId,platform:'youtube_shorts',capabilityVersion:SOCIAL_PROVIDER_CAPABILITIES.youtube_shorts.version,scheduledFor:now.toISOString()},attempt:{id:scope.attemptId,attemptNumber:1,priorAttemptId:null,idempotencyKey:'publication:'+scope.socialPostId+':1',phase:'claimed',outcome:null,nextActionAt:now.toISOString(),providerCallCount:0,startedAt:now.toISOString(),processingDeadline:future,reconciliationDeadline:future},claim:{id:scope.claimId,claimantId:'fixture',leaseExpiresAt:future,heartbeatAt:now.toISOString()},checkpointKind:null,sealedCheckpoint:null,terminalResult:null};const context={version:1,inputKey:{scope,key:await derivePublicationPurposeKey(master,scope,'input_state')},checkpointKey:{scope,key:await derivePublicationPurposeKey(master,scope,'linkedin_instructions')},account:{id:accountId,userId:id(),platform:'youtube_shorts',providerAccountId:'fixture-owner',displayName:'Fixture',handle:null,accessToken:'fixture-provider-token',scopes:['https://www.googleapis.com/auth/youtube.upload'],metadata:null}};const payload={mode:'publish',loaded,operation:null,config:{...config,facebookReelsPublishingEnabled:false},retry:all.retry,providerCallCeiling:100};const encrypted=await sealPublicationPayload(payload,context.inputKey.key,scope,'input_state');console.log(JSON.stringify({envelope:{version:1,kind:'publication',scope,payload:Buffer.from(encrypted).toString('base64url')},context}));"""

class PublicationRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def actual(self,mode='success'):
        made=subprocess.run(['bun','-e',FIXTURE],cwd=ROOT,capture_output=True,timeout=15,check=True)
        prepared=json.loads(made.stdout);scope=prepared['envelope']['scope'];calls=[];requests=[];starts=[]
        class Provider(BaseHTTPRequestHandler):
            def log_message(self,*_):pass
            def do_POST(self):
                requests.append(('POST',self.rfile.read(int(self.headers.get('Content-Length','0')))))
                self.send_response(200);self.send_header('Location','https://www.googleapis.com/upload/resumable/fixture');self.send_header('Content-Length','0');self.end_headers()
            def do_PUT(self):
                payload=self.rfile.read(int(self.headers.get('Content-Length','0')));requests.append(('PUT',payload))
                body=b'{"id":"native-video"}';self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        provider=ThreadingHTTPServer(('127.0.0.1',0),Provider);thread=threading.Thread(target=provider.serve_forever,daemon=True);thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                work=Path(directory).resolve();media=work/'frozen.mp4';media.write_bytes(b'12345678');media.chmod(0o400)
                fixture=work/'fixture-cli.ts';cli=(ROOT/'apps/media/src/publication-cli.ts').as_posix()
                fixture.write_text(f"import {{runPublicationCli}} from {json.dumps(cli)};if(process.env.DATABASE_URL||process.env.REDIS_URL||process.env.SOCIAL_PUBLICATION_CHECKPOINT_KEY)throw Error('secret leaked');const original=fetch;await runPublicationCli({{providerFetch:async(raw,init)=>{{const u=new URL(typeof raw==='string'?raw:raw instanceof URL?raw:raw.url);return original('http://127.0.0.1:{provider.server_port}'+u.pathname+u.search,init);}}}});")
                class Session:
                    fence={'reference':{'deploymentEpoch':1,'subject':{'kind':'social_publication','id':scope['socialPostId']},'inputHash':scope['bindingHash']},'attemptToken':scope['claimId'],'owner':'fixture'}
                    remaining_seconds=120;cancel_event=threading.Event()
                    def assert_live(self):
                        if self.cancel_event.is_set():raise RuntimeError('revoked')
                    def on_process_start(self,pid):
                        os.kill(pid,0);starts.append(pid)
                        if mode=='lost_start':raise TimeoutError('start receipt lost')
                    def command(self,action,**fields):
                        if action!='publication-command':raise AssertionError(action)
                        self.assert_live();command=fields['command'];calls.append(command)
                        if mode=='revoked' and command.get('kind')=='provider_call' and command.get('operation')=='upload':
                            self.cancel_event.set();return type('Reply',(),{'disposition':{'disposition':'cancelled'}})()
                        if command['kind']=='accepted':result={'kind':'settled','outcome':'posted','attemptId':scope['attemptId'],'socialPostId':scope['socialPostId']}
                        elif command['kind'] in {'failed','unknown','interrupted'}:result={'kind':'settled','outcome':'needs_attention','attemptId':scope['attemptId'],'socialPostId':scope['socialPostId'],'code':'publication_unconfirmed'}
                        else:result={'kind':'recorded'}
                        return type('Reply',(),{'disposition':{'disposition':'publication_recorded','result':result}})()
                session=Session();package=WorkPackage('publication',scope['bindingHash'],_wire(prepared['envelope']),_wire([]),_wire([]),_wire(session.fence),_wire(prepared['context']))
                poisoned={name:os.environ.get(name) for name in ('DATABASE_URL','REDIS_URL','SOCIAL_PUBLICATION_CHECKPOINT_KEY')}
                for name in poisoned:os.environ[name]='poisoned-no-native-access'
                try:
                    if mode=='lost_start':
                        with self.assertRaises(MediaProcessError):await run_publication(session,package,work,media_path=media,cli_path=fixture)
                        self.assertEqual(calls,[]);self.assertEqual(requests,[]);self.assertFalse((work/'publication-invocation.json').exists());return
                    if mode=='revoked':
                        with self.assertRaises(MediaProcessError) as cancelled:await run_publication(session,package,work,media_path=media,cli_path=fixture)
                        self.assertEqual(cancelled.exception.code,'media_execution_cancelled')
                        self.assertEqual([method for method,_ in requests],['POST']);self.assertFalse((work/'publication-invocation.json').exists());return
                    result=await run_publication(session,package,work,media_path=media,cli_path=fixture)
                finally:
                    for name,value in poisoned.items():
                        if value is None:os.environ.pop(name,None)
                        else:os.environ[name]=value
                self.assertEqual(result['outcome'],'posted');self.assertEqual(len(starts),1)
                self.assertEqual([method for method,_ in requests],['POST','PUT']);self.assertEqual(requests[-1][1],b'12345678')
                self.assertEqual([value['operation'] for value in calls if value['kind']=='provider_call'],['initialize','upload'])
                self.assertEqual(sum(value['kind']=='accepted' for value in calls),1)
                self.assertFalse((work/'publication-invocation.json').exists())
        finally:
            provider.shutdown();provider.server_close();thread.join(2)

    async def test_real_bun_child_has_no_database_or_redis_and_every_provider_call_is_freshly_admitted(self):await self.actual()
    async def test_unconfirmed_process_start_releases_no_stdio_or_provider_request(self):await self.actual('lost_start')
    async def test_revocation_between_initialize_and_upload_prevents_the_next_http_request(self):await self.actual('revoked')
