from __future__ import annotations

from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import os
import hashlib,json,sys,wave
from pathlib import Path
import ssl
import subprocess
import tempfile
from threading import Event,Thread
from types import SimpleNamespace
import unittest
from uuid import uuid4

from narriflow_media.native_runtime import download_assigned_source
from narriflow_media.pin_source_runtime import run_upload_pin
from narriflow_media.process import run_owned_process_async
from narriflow_media.multipart import TransferResponse
from narriflow_media.control import ExecutionControlError
from narriflow_media.fetch import SourceFetchFailure
from narriflow_media.transfer import WorkPackage,_wire


class PinSourceOperationTests(unittest.IsolatedAsyncioTestCase):
    async def pin_operation(self,mode="success"):
        with tempfile.TemporaryDirectory() as directory:
            work=Path(directory);fixture=work/'fixture.wav';marker=work/'started'
            with wave.open(str(fixture),'wb') as output:
                output.setnchannels(1);output.setsampwidth(2);output.setframerate(16000);output.writeframes(bytes(8000))
            content=fixture.read_bytes();artifact_id=str(uuid4());trace=[];stored=[];state={}
            fence={'reference':{'inputHash':'a'*64},'attemptToken':str(uuid4()),'owner':str(uuid4())}
            def started(pid):os.kill(pid,0);marker.write_text('started');state['started']=True
            def transfer(action,**fields):
                self.assertTrue(state.get('started'));trace.append(action)
                if action=='upload-initialize' and mode=='prefix_mutated':
                    first=state['first'];first.chmod(0o600);first.write_bytes(b'changed');first.chmod(0o400)
                if action=='upload-initialize':value={'artifactId':artifact_id,'uploadId':'private','byteLength':len(content),'partSizeBytes':16777216,'partCount':1}
                elif action=='source-range':value={'grant':{'url':'https://r2.example/source','headers':{'If-Match':'"frozen"','Range':f'bytes=0-{len(content)-1}'},'expiresAt':'2099-01-01T00:00:00Z'}}
                elif action=='upload-parts':value={'grants':[{'partNumber':1,'url':'https://r2.example/part','headers':{},'expiresAt':'2099-01-01T00:00:00Z'}]}
                elif action=='upload-complete' and mode=='completion_unknown':raise ExecutionControlError('execution_transport_unavailable')
                elif action=='upload-abort':value={'disposition':'upload_aborted'}
                elif action=='upload-complete':value={'object':{'key':'execution/server-assigned','etag':'"completed"','byteLength':len(content),'sha256':fields['sha256'],'contentType':'audio/wav'}}
                else:raise AssertionError(action)
                return SimpleNamespace(disposition=value)
            session=SimpleNamespace(fence=fence,assert_live=lambda:None,on_process_start=started,cancel_event=Event(),remaining_seconds=120,transfer=transfer)
            source={'storageKey':'uploads/frozen','etag':'"frozen"','byteLength':len(content),'contentType':'audio/wav'}
            command={'kind':'upload_source','audioPolicy':'none','projectId':str(uuid4()),'sourceRevision':1,'mediaIdentity':{'provider':'upload','mediaId':str(uuid4())},
                'sourceAudioId':fence['attemptToken'],'toolchainFingerprint':'d'*64,'probeVersion':'normalized-probe-v1','existingSourceAudio':None,'languageProbe':None,'source':source}
            package=WorkPackage('pin_source','a'*64,_wire(command),_wire([{**{key:source[key] for key in ['storageKey','etag','byteLength']},'name':'upload_source','url':'https://r2.example/frozen','headers':{'If-Match':'"frozen"'},'expiresAt':'2099-01-01T00:00:00Z'}]),
                _wire([{'artifactId':artifact_id,'role':'source_video','bindingHash':'b'*64,'contentType':'audio/wav','contentTypes':['audio/wav'],'maxBytes':len(content),'sourceEtag':'"frozen"','sourceByteLength':len(content)}]),_wire(fence))
            async def first(session,package,work,**options):
                self.assertEqual(options['range_end'],len(content));path=work/'source.bin'
                code='import json,sys;from pathlib import Path;v=json.load(sys.stdin);assert Path(v["marker"]).exists();Path(v["output"]).write_bytes(Path(v["input"]).read_bytes())'
                result=await run_owned_process_async([sys.executable,'-c',code],input_bytes=json.dumps({'marker':str(marker),'input':str(fixture),'output':str(path)}).encode(),on_start=session.on_process_start,timeout_seconds=10,env={'PATH':os.environ['PATH']})
                self.assertEqual(result.returncode,0);path.chmod(0o400);state['first']=path;return path
            class Storage:
                async def request(self,grant,method,body,headers,*args):
                    if method!='PUT':raise AssertionError('The initial conditional range was downloaded twice')
                    stored.append(bytes(body));return TransferResponse(200,{'ETag':hashlib.md5(body,usedforsecurity=False).hexdigest()},b'')
            class Sink:
                def __init__(self,*args,**options):pass
                async def video_ready(self,artifact,audio,*,completed):
                    trace.append('publish');self_audio=audio
                    if self_audio is not None:raise AssertionError('No-speech pin fabricated audio')
                    state['completed']=completed;state['probe']=artifact.probe
            if mode=='prefix_mutated':
                with self.assertRaisesRegex(SourceFetchFailure,'upload_source_changed'):
                    await run_upload_pin(session,package,work,prefix_reader=first,transport=Storage(),sink_class=Sink)
                self.assertNotIn('upload-complete',trace);self.assertIn('upload-abort',trace);self.assertNotIn('publish',trace);return
            if mode=='completion_unknown':
                with self.assertRaises(ExecutionControlError):
                    await run_upload_pin(session,package,work,prefix_reader=first,transport=Storage(),sink_class=Sink)
                self.assertNotIn('upload-abort',trace);self.assertNotIn('publish',trace);return
            await run_upload_pin(session,package,work,prefix_reader=first,transport=Storage(),sink_class=Sink)
            self.assertEqual(stored,[content]);self.assertLess(trace.index('upload-complete'),trace.index('publish'))
            self.assertEqual(trace.count('upload-initialize'),1);self.assertEqual(state['completed'].sha256,hashlib.sha256(content).hexdigest());self.assertFalse(state['probe']['hasVideo'])

    async def test_pin_completion_precedes_probe_publication_and_never_uploads_the_original_twice(self):
        await self.pin_operation()

    async def test_mutating_the_verified_prefix_aborts_the_unpublished_pin(self):
        await self.pin_operation('prefix_mutated')

    async def test_an_unknown_completion_acknowledgement_never_becomes_abort_or_publication(self):
        await self.pin_operation('completion_unknown')

    async def test_first_conditional_range_uses_a_real_owned_curl_before_any_remaining_pin_work(self):
        payload=b'0123456789abcdef';state={}
        class Source(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                state['after_start']=state.get('started',False);state['range']=self.headers.get('Range');state['etag']=self.headers.get('If-Match')
                self.send_response(206);self.send_header('ETag','"frozen"');self.send_header('Content-Length','6');self.send_header('Content-Range','bytes 0-5/16');self.end_headers();self.wfile.write(payload[:6])
        with tempfile.TemporaryDirectory() as directory:
            work=Path(directory);cert,key=work/'cert.pem',work/'key.pem'
            subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],check=True,capture_output=True,timeout=10)
            server=ThreadingHTTPServer(('127.0.0.1',0),Source);context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(cert,key);server.socket=context.wrap_socket(server.socket,server_side=True)
            thread=Thread(target=server.serve_forever,daemon=True);thread.start()
            def start(pid):os.kill(pid,0);state['started']=True
            session=SimpleNamespace(fence={'reference':{'inputHash':'a'*64},'attemptToken':str(uuid4()),'owner':str(uuid4())},assert_live=lambda:None,on_process_start=start,cancel_event=Event(),remaining_seconds=60)
            package=WorkPackage('pin_source','a'*64,_wire({}),_wire([{'name':'upload_source','storageKey':'uploads/frozen','etag':'"frozen"','byteLength':16,'url':f'https://127.0.0.1:{server.server_port}/frozen','headers':{'If-Match':'"frozen"'},'expiresAt':'2099-01-01T00:00:00Z'}]),_wire([]),_wire(session.fence))
            previous=os.environ.get('CURL_CA_BUNDLE');os.environ['CURL_CA_BUNDLE']=str(cert)
            try:
                path=await download_assigned_source(session,package,work,source_name='upload_source',maximum_bytes=16*1024*1024,range_end=6)
                self.assertEqual(path.read_bytes(),payload[:6]);self.assertEqual(path.stat().st_mode&0o222,0)
                self.assertEqual(state,{'started':True,'after_start':True,'range':'bytes=0-5','etag':'"frozen"'})
            finally:
                if previous is None:os.environ.pop('CURL_CA_BUNDLE',None)
                else:os.environ['CURL_CA_BUNDLE']=previous
                server.shutdown();server.server_close();thread.join(2)


if __name__=='__main__':unittest.main()
