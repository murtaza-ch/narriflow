from __future__ import annotations

import base64
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

from narriflow_media.control import ControlResponse,ExecutionControlClient,ExecutorSession
from narriflow_media.multipart import TransferResponse
from narriflow_media.native_runtime import run_asset_validation
from narriflow_media.transfer import load_work_package
from narriflow_media.signing import verify_execution_request


def instant(seconds): return datetime.fromtimestamp(seconds,timezone.utc).isoformat().replace('+00:00','Z')


class NativeOperationTests(unittest.IsolatedAsyncioTestCase):
    @unittest.skipUnless(shutil.which('openssl') and shutil.which('curl') and shutil.which('bun'),'native tools required')
    async def test_actual_font_download_validation_and_two_commits_start_only_after_owned_process_ack(self):
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
                self.send_response(200);self.send_header('ETag','"font"');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
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
                elif action=='process-start':state['started']=True;result={'disposition':'started'}
                elif action=='upload-initialize':result={'disposition':'upload_ready','artifactId':command['artifactId'],'uploadId':'private','byteLength':command['byteLength'],'partSizeBytes':16777216,'partCount':1}
                elif action=='upload-parts':result={'disposition':'upload_parts','artifactId':command['artifactId'],'grants':[{'partNumber':1,'url':f'https://r2.example/{command["artifactId"]}','headers':{},'expiresAt':instant(now+60)}]}
                elif action=='upload-complete':
                    output=next(v for v in outputs if v['artifactId']==command['artifactId']);result={'disposition':'upload_completed','artifactId':output['artifactId'],'object':{'key':f'execution/{output["artifactId"]}','etag':'"sealed"','byteLength':command['byteLength'],'sha256':command['sha256'],'contentType':output['contentType']}}
                elif action=='commit-artifact':result={'disposition':'committed','artifactId':command['artifact']['artifactId']}
                else:raise AssertionError(action)
                return ControlResponse(200,{'X-Execution-Server-Time':instant(now)},json.dumps(result).encode())
            class Storage:
                async def request(self,grant,method,body,headers,*args):
                    uploads[grant.url.rsplit('/',1)[-1]]=bytes(body)
                    return TransferResponse(200,{'ETag':hashlib.md5(body,usedforsecurity=False).hexdigest()},b'')
            client=ExecutionControlClient(origin='https://api.example',key_id='fixture',key=b'k'*32,transport=transport,retry_delay_seconds=0)
            try:
                with ExecutorSession.acquire(client,reference={'inputHash':'a'*64},attempt_token='fixture') as session:
                    package=await load_work_package(session);work=path/'work';work.mkdir()
                    await run_asset_validation(session,package,work,transport=Storage())
                self.assertTrue(state['get_after_start']);self.assertEqual(state['if_match'],'"font"')
                self.assertEqual([c['action'] for c in calls].count('process-start'),1)
                self.assertEqual(uploads[outputs[0]['artifactId']],payload)
                evidence=json.loads(uploads[outputs[1]['artifactId']]);self.assertEqual(evidence['kind'],'font');self.assertEqual(evidence['sha256'],digest)
                self.assertEqual([c['artifact']['role'] for c in calls if c['action']=='commit-artifact'],['validated_font','probe'])
            finally:
                if previous is None:os.environ.pop('CURL_CA_BUNDLE',None)
                else:os.environ['CURL_CA_BUNDLE']=previous
                server.shutdown();server.server_close();thread.join(2)


if __name__=='__main__':unittest.main()
