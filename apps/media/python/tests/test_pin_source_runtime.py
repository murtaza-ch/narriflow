from __future__ import annotations

from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
from threading import Event,Thread
from types import SimpleNamespace
import unittest
from uuid import uuid4

from narriflow_media.native_runtime import download_assigned_source
from narriflow_media.transfer import WorkPackage,_wire


class PinSourceOperationTests(unittest.IsolatedAsyncioTestCase):
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
