from __future__ import annotations

from datetime import datetime,timezone
import hashlib
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from uuid import uuid4

from narriflow_media.control import ControlResponse,ExecutionControlClient
from narriflow_media.entrypoint import invoke_native
from narriflow_media.multipart import TransferResponse
from narriflow_media.native_runtime import run_asset_validation,run_outbound_delivery
from narriflow_media.signing import verify_execution_request


def instant(seconds): return datetime.fromtimestamp(seconds,timezone.utc).isoformat().replace('+00:00','Z')


class NativeOperationTests(unittest.IsolatedAsyncioTestCase):
    async def font_operation(self,mode='success'):
        root=Path(__file__).resolve().parents[4]
        font=root/'packages/caption-fonts/fonts/Inter-SemiBold.ttf'
        payload=font.read_bytes();digest=hashlib.sha256(payload).hexdigest()
        state={'started':False};calls=[];uploads={};outputs=[]
        for role,mime,limit in [('validated_font','font/ttf',len(payload)),('probe','application/json',65536)]:
            outputs.append({'artifactId':str(uuid4()),'role':role,'contentType':mime,'contentTypes':[mime], 'maxBytes':limit,'bindingHash':'a'*64})
        class Source(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                state['get_after_start']=state['started'];state['if_match']=self.headers.get('If-Match')
                self.send_response(200)
                if mode=='oversized_headers':self.send_header('X-Padding','a'*70000)
                self.send_header('ETag','"changed"' if mode=='changed_source' else '"font"');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory);cert,key=path/'cert.pem',path/'key.pem'
            subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-days','1',
                '-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
            server=ThreadingHTTPServer(('127.0.0.1',0),Source);context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(cert,key)
            server.socket=context.wrap_socket(server.socket,server_side=True);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            previous=os.environ.get('CURL_CA_BUNDLE');os.environ['CURL_CA_BUNDLE']=str(cert)
            def transport(origin,target,body,headers,timeout):
                verify_execution_request(signature=json.loads(headers['X-Execution-Signature']),key_ring={'fixture':b'k'*32},audience='executor-control',method='POST',target=target,body=body,now_seconds=int(time.time()))
                command,now=json.loads(body),time.time();calls.append(command);action=command['action']
                if action=='acquire':result={'disposition':'acquired','fence':{k:command[k] for k in ['reference','attemptToken','owner']},'serverTime':instant(now),'leaseExpiresAt':instant(now+120),'operationDeadlineAt':instant(now+600)}
                elif action=='work-package':result={'disposition':'work_package','functionName':'asset_validation','inputHash':'a'*64,
                    'input':{'kind':'inline','command':{'kind':'font','expected':{'contentType':'font/ttf','byteLength':len(payload),'sha256':digest}}},
                    'sources':[{'name':'asset_source','storageKey':'frozen/font','etag':'"font"','byteLength':len(payload),'sha256':digest,
                        'url':f'https://127.0.0.1:{server.server_port}/font','headers':{'If-Match':'"font"'},'expiresAt':instant(now+90)}], 'outputs':outputs}
                elif action=='process-start':
                    state['started']=True
                    if mode=='lost_start_ack':raise TimeoutError('private start acknowledgement')
                    result={'disposition':'started'}
                elif action=='upload-initialize':result={'disposition':'upload_ready','artifactId':command['artifactId'],'uploadId':'private','byteLength':command['byteLength'],'partSizeBytes':16777216,'partCount':1}
                elif action=='upload-parts':result={'disposition':'upload_parts','artifactId':command['artifactId'],'grants':[{'partNumber':1,'url':f'https://r2.example/{command["artifactId"]}','headers':{},'expiresAt':instant(now+60)}]}
                elif action=='upload-complete':
                    output=next(v for v in outputs if v['artifactId']==command['artifactId']);result={'disposition':'upload_completed','artifactId':output['artifactId'],'object':{'key':f'execution/{output["artifactId"]}','etag':'"sealed"','byteLength':command['byteLength'],'sha256':command['sha256'],'contentType':output['contentType']}}
                elif action=='commit-artifact':
                    if command['artifact']['role']=='probe':state['completed']=True
                    if mode=='lost_commit_ack':raise TimeoutError('private commit acknowledgement')
                    result={'disposition':'committed','artifactId':command['artifact']['artifactId']}
                elif action=='fail':state['failed']=True;result={'disposition':'retry_due','dueAt':instant(now+1)}
                elif action=='read-disposition':
                    result={'disposition':'completed' if state.get('completed') else 'failed' if state.get('failed') else 'started'}
                    if result['disposition']=='failed':result['failureCode']='media_execution_failed'
                else:raise AssertionError(action)
                return ControlResponse(200,{'X-Execution-Server-Time':instant(now)},json.dumps(result).encode())
            class Storage:
                async def request(self,grant,method,body,headers,*args):
                    uploads[grant.url.rsplit('/',1)[-1]]=bytes(body)
                    return TransferResponse(200,{'ETag':hashlib.md5(body,usedforsecurity=False).hexdigest()},b'')
            client=ExecutionControlClient(origin='https://api.example',key_id='fixture',key=b'k'*32,transport=transport,retry_delay_seconds=0)
            try:
                invocation={'reference':{'dispatchId':str(uuid4()),'deploymentEpoch':1,'kind':'modal_execution','subject':{'kind':'native_validation','id':str(uuid4())},'generation':1,'inputHash':'a'*64},'attemptToken':str(uuid4())}
                async def operation(session,package,work):
                    await run_asset_validation(session,package,work,transport=Storage())
                outcome=await invoke_native(invocation,'asset_validation',client=client,operation=operation,max_operation_seconds=600)
                if mode=='lost_start_ack':
                    self.assertEqual(outcome,{'disposition':'unconfirmed'});self.assertNotIn('get_after_start',state);self.assertEqual(uploads,{})
                    self.assertNotIn('fail',[c['action'] for c in calls]);return
                if mode in {'changed_source','oversized_headers'}:
                    self.assertEqual(outcome,{'disposition':'failed'});self.assertEqual(uploads,{})
                    self.assertNotIn('upload-initialize',[c['action'] for c in calls]);return
                if mode=='lost_commit_ack':
                    self.assertEqual(outcome,{'disposition':'unconfirmed'});self.assertEqual(set(uploads),{outputs[0]['artifactId']})
                    self.assertEqual(uploads[outputs[0]['artifactId']],payload)
                    self.assertEqual([c['action'] for c in calls].count('commit-artifact'),3)
                    self.assertNotIn('fail',[c['action'] for c in calls]);self.assertNotIn('upload-abort',[c['action'] for c in calls]);return
                self.assertEqual(outcome,{'disposition':'completed'})
                self.assertTrue(state['get_after_start']);self.assertEqual(state['if_match'],'"font"')
                self.assertEqual([c['action'] for c in calls].count('process-start'),1)
                self.assertEqual(uploads[outputs[0]['artifactId']],payload)
                evidence=json.loads(uploads[outputs[1]['artifactId']]);self.assertEqual(evidence['kind'],'font');self.assertEqual(evidence['sha256'],digest)
                self.assertEqual([c['artifact']['role'] for c in calls if c['action']=='commit-artifact'],['validated_font','probe'])
            finally:
                if previous is None:os.environ.pop('CURL_CA_BUNDLE',None)
                else:os.environ['CURL_CA_BUNDLE']=previous
                server.shutdown();server.server_close();thread.join(2)

    @unittest.skipUnless(shutil.which('openssl') and shutil.which('curl') and shutil.which('bun'),'native tools required')
    async def test_actual_font_download_validation_and_two_commits_start_only_after_owned_process_ack(self):
        await self.font_operation()

    async def test_changed_source_etag_never_creates_an_upload(self):
        await self.font_operation('changed_source')

    async def test_oversized_source_headers_are_rejected_before_upload(self):
        await self.font_operation('oversized_headers')

    async def test_lost_native_start_ack_delivers_no_source_grant_and_makes_no_second_mutation(self):
        await self.font_operation('lost_start_ack')

    async def test_lost_binary_commit_ack_preserves_object_and_stops_before_probe_upload(self):
        await self.font_operation('lost_commit_ack')

    async def test_rss_typed_child_receipt_is_uploaded_only_after_start_ack_and_with_a_sanitized_environment(self):
        calls=[];stored=[];state={'completed':False};artifact=str(uuid4())
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory);marker=path/'started';executable=path/'rss-child'
            executable.write_text('#!'+os.sys.executable+'\n'+
                'import json,os,sys\nfrom pathlib import Path\n'+
                f'assert Path({str(marker)!r}).read_text()=="acknowledged"\n'+
                'assert os.environ.get("DATABASE_URL") is None\n'+
                'assert not os.environ.get("HTTPS_PROXY")\n'+
                'command=json.load(sys.stdin);body=json.dumps({"title":"Fixture","episodes":[],"etag":None,"lastModified":None,"finalUrl":command["input"]["url"],"notModified":False}).encode()\n'+
                'Path(command["outputPath"]).write_bytes(body);print(json.dumps({"byteLength":len(body)}))\n')
            executable.chmod(0o700)
            def control(origin,target,body,headers,timeout):
                command,now=json.loads(body),time.time();calls.append(command);action=command['action']
                if action=='acquire':result={'disposition':'acquired','fence':{key:command[key] for key in ['reference','attemptToken','owner']},'serverTime':instant(now),'leaseExpiresAt':instant(now+120),'operationDeadlineAt':instant(now+600)}
                elif action=='work-package':result={'disposition':'work_package','functionName':'outbound_delivery','inputHash':'a'*64,'input':{'kind':'inline','command':{'kind':'rss_feed','url':'https://feed.example/rss','etag':None,'lastModified':None}},'sources':[],'outputs':[{'artifactId':artifact,'role':'outbound_receipt','contentType':'application/json','contentTypes':['application/json'],'maxBytes':4194304,'bindingHash':'a'*64}]}
                elif action=='process-start':marker.write_text('acknowledged');result={'disposition':'started'}
                elif action=='upload-initialize':result={'disposition':'upload_ready','artifactId':artifact,'uploadId':'private','byteLength':command['byteLength'],'partSizeBytes':16777216,'partCount':1}
                elif action=='upload-parts':result={'disposition':'upload_parts','artifactId':artifact,'grants':[{'partNumber':1,'url':'https://r2.example/rss','headers':{},'expiresAt':instant(now+60)}]}
                elif action=='upload-complete':result={'disposition':'upload_completed','artifactId':artifact,'object':{'key':'execution/assigned','etag':'"sealed"','byteLength':command['byteLength'],'sha256':command['sha256'],'contentType':'application/json'}}
                elif action=='commit-artifact':state['completed']=True;result={'disposition':'committed','artifactId':artifact}
                elif action=='read-disposition':result={'disposition':'completed' if state['completed'] else 'started'}
                else:raise AssertionError(action)
                return ControlResponse(200,{'X-Execution-Server-Time':instant(now)},json.dumps(result).encode())
            class Storage:
                async def request(self,grant,method,body,headers,*args):
                    stored.append(bytes(body));return TransferResponse(200,{'ETag':hashlib.md5(body,usedforsecurity=False).hexdigest()},b'')
            client=ExecutionControlClient(origin='https://api.example',key_id='fixture',key=b'k'*32,transport=control,retry_delay_seconds=0)
            invocation={'reference':{'dispatchId':str(uuid4()),'deploymentEpoch':1,'kind':'modal_execution','subject':{'kind':'outbound_probe','id':str(uuid4())},'generation':1,'inputHash':'a'*64},'attemptToken':str(uuid4())}
            async def operation(session,package,work):
                await run_outbound_delivery(session,package,work,transport=Storage(),bun_executable=str(executable))
            previous=os.environ.get('DATABASE_URL');os.environ['DATABASE_URL']='synthetic-private-database'
            try:outcome=await invoke_native(invocation,'outbound_delivery',client=client,operation=operation,max_operation_seconds=600)
            finally:
                if previous is None:os.environ.pop('DATABASE_URL',None)
                else:os.environ['DATABASE_URL']=previous
            self.assertEqual(outcome,{'disposition':'completed'})
            self.assertEqual(len(stored),1);self.assertEqual(json.loads(stored[0])['title'],'Fixture')
            self.assertEqual([call['action'] for call in calls].count('process-start'),1)
            self.assertEqual(calls[-1]['action'],'read-disposition')


if __name__=='__main__':unittest.main()
