from contextlib import redirect_stderr
import http.client
from io import StringIO
import json
import socket
import threading
import time
import tracemalloc
import unittest
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from narriflow_media.multipart import MultipartTransferError, SignedHttpTransport, TransferResponse
from narriflow_media.source_server import ScopedSourceServer


class Session:
    def __init__(self, source):
        self.source=source;self.cancel_event=threading.Event();self.grants=[]
    def assert_live(self):
        if self.cancel_event.is_set():raise RuntimeError('lost')
    def transfer(self, action, **fields):
        self.assert_live();self.grants.append((action,fields))
        return type('Result',(),{'disposition':{'object':{key:self.source[key] for key in ['storageKey','etag','byteLength','sha256']},
            'grant':{'url':'https://scoped.invalid/source','headers':{'if-match':self.source['etag']}}}})()


class Transport:
    def __init__(self, data, etag='"source"'):
        self.data=data;self.etag=etag;self.requests=[]
    async def request(self, grant, method, body, headers, maximum, cancelled):
        self.requests.append((grant,method,dict(headers),maximum));start,end=map(int,headers['range'][6:].split('-'))
        if grant.headers['if-match']!=self.etag:return TransferResponse(412,{},b'')
        return TransferResponse(206,{'etag':self.etag,'content-length':str(end-start+1),
            'content-range':f'bytes {start}-{end}/{len(self.data)}'},self.data[start:end+1])


class SourceServerTests(unittest.TestCase):
    def fixture(self, data):
        source={'name':'original','storageKey':'execution/1/source','etag':'"source"','byteLength':len(data),'sha256':'a'*64}
        return source,Session(source),Transport(data)

    def get(self, server, path=None, range='bytes=7-26'):
        connection=http.client.HTTPConnection('127.0.0.1',server.port,timeout=3)
        connection.request('GET',path or server.path('original'),headers={'Range':range})
        response=connection.getresponse();result=(response.status,dict(response.getheaders()),response.read());connection.close();return result

    def test_actual_http_reads_are_start_gated_conditional_and_bounded_to_the_requested_range(self):
        data=bytes(range(256))*16384;source,session,transport=self.fixture(data)
        with ScopedSourceServer(session,[source],transport=transport) as server:
            self.assertEqual(self.get(server)[0],503);self.assertEqual(transport.requests,[])
            server.allow_reads()
            status,headers,body=self.get(server)
            self.assertEqual((status,headers['Content-Range'],body),(206,f'bytes 7-26/{len(data)}',data[7:27]))
            self.assertEqual(transport.requests[0][2],{'range':'bytes=7-26','if-match':'"source"','accept-encoding':'identity'})
            self.assertEqual(server.bytes_transferred,20)
            self.assertEqual(self.get(server,path='/arbitrary')[0],404)
            self.assertEqual(len(transport.requests),1)

    def test_source_overwrite_and_owner_loss_refuse_further_reads(self):
        source,session,transport=self.fixture(b'0123456789abcdef')
        with ScopedSourceServer(session,[source],transport=transport) as server:
            server.allow_reads();transport.etag='"changed"'
            self.assertEqual(self.get(server,range='bytes=0-3')[0],502)
            self.assertTrue(session.cancel_event.is_set())
            before=len(transport.requests)
            self.assertEqual(self.get(server,range='bytes=4-7')[0],503)
            self.assertEqual(len(transport.requests),before)

    def test_a_midstream_upstream_disconnect_retries_the_exact_range_with_fresh_authority(self):
        data = bytes(range(256)) * 1024
        source, session, _ = self.fixture(data)
        requests = []
        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                requested = self.headers['Range'];requests.append((requested, self.headers['If-Match']))
                if len(requests) == 2:
                    self.connection.shutdown(socket.SHUT_RDWR);self.connection.close();return
                start, end = map(int, requested[6:].split('-'));body = data[start:end + 1]
                self.send_response(206);self.send_header('ETag', '"source"')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Content-Range', f'bytes {start}-{end}/{len(data)}')
                self.end_headers();self.wfile.write(body)
        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        thread = threading.Thread(target=upstream.serve_forever, daemon=True);thread.start()
        original_transfer = session.transfer
        def transfer(action, **fields):
            result = original_transfer(action, **fields)
            result.disposition['grant']['url'] = f'http://127.0.0.1:{upstream.server_port}/source'
            return result
        session.transfer = transfer
        try:
            with ScopedSourceServer(session, [source], transport=SignedHttpTransport(allow_loopback_http=True)) as server:
                server.allow_reads()
                status, _, body = self.get(server, range=f'bytes=0-{len(data) - 1}')
                self.assertEqual((status, body), (206, data))
                self.assertEqual(server.bytes_transferred, len(data))
                self.assertFalse(session.cancel_event.is_set())
            self.assertEqual(len(requests), 4)
            self.assertEqual(requests[1], requests[2])
            self.assertTrue(all(etag == '"source"' for _, etag in requests))
            self.assertEqual(len(session.grants), 4)
        finally:
            upstream.shutdown();upstream.server_close();thread.join(timeout=1)

    def test_upstream_206_partial_body_eof_retries_after_downstream_headers_open(self):
        data = bytes(range(256)) * 1024
        source, session, _ = self.fixture(data)
        requests, sent = [], {}
        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                requested = self.headers['Range'];requests.append((requested, self.headers['If-Match']))
                start, end = map(int, requested[6:].split('-'));body = data[start:end + 1]
                self.send_response(206);self.send_header('ETag', '"source"')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Content-Range', f'bytes {start}-{end}/{len(data)}')
                self.end_headers()
                number = len(requests)
                body = body[:17] if number == 2 else body
                self.wfile.write(body);self.wfile.flush();sent[number] = len(body)
                self.close_connection = True
        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        thread = threading.Thread(target=upstream.serve_forever, daemon=True);thread.start()
        original_transfer = session.transfer
        def transfer(action, **fields):
            result = original_transfer(action, **fields)
            result.disposition['grant']['url'] = f'http://127.0.0.1:{upstream.server_port}/source'
            return result
        session.transfer = transfer
        try:
            with ScopedSourceServer(session, [source], transport=SignedHttpTransport(allow_loopback_http=True)) as server:
                server.allow_reads()
                status, _, body = self.get(server, range=f'bytes=0-{len(data) - 1}')
                self.assertEqual((status, body), (206, data))
                self.assertEqual(server.bytes_transferred, len(data))
                self.assertFalse(session.cancel_event.is_set())
            self.assertEqual(sent, {1: 65536, 2: 17, 3: 131072, 4: 65536})
            self.assertEqual(requests[1], requests[2])
            self.assertTrue(all(etag == '"source"' for _, etag in requests))
            self.assertEqual(len(session.grants), 4)
        finally:
            upstream.shutdown();upstream.server_close();thread.join(timeout=1)

    def test_actual_upstream_eof_exhaustion_cancel_and_invalid_response_bounds(self):
        for mode, expected_calls in [('truncated', 3), ('cancelled', 1), ('short-declaration', 1),
                ('long-declaration', 1), ('oversized', 1), ('unbounded-oversized', 1), ('etag', 1), ('range', 1)]:
            with self.subTest(mode=mode):
                source, session, _ = self.fixture(b'0123456789abcdef')
                requests = []
                class Upstream(BaseHTTPRequestHandler):
                    def log_message(self, *_): pass
                    def do_GET(self):
                        requests.append((self.headers['Range'], self.headers['If-Match']))
                        self.send_response(206)
                        self.send_header('ETag', '"changed"' if mode == 'etag' else '"source"')
                        self.send_header('Content-Range', 'bytes 1-4/16' if mode == 'range' else 'bytes 0-3/16')
                        length = 3 if mode == 'short-declaration' else 8 if mode == 'long-declaration' else 5 if mode == 'oversized' else 4
                        if mode != 'unbounded-oversized': self.send_header('Content-Length', str(length))
                        self.end_headers()
                        if mode == 'cancelled': session.cancel_event.set()
                        body = b'01' if mode in {'truncated', 'cancelled', 'long-declaration'} else b'012'
                        if mode in {'oversized', 'etag', 'range'}: body = b'0123'
                        if mode in {'oversized', 'unbounded-oversized'}: body = b'01234'
                        self.wfile.write(body);self.wfile.flush();self.close_connection = True
                upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
                thread = threading.Thread(target=upstream.serve_forever, daemon=True);thread.start()
                original_transfer = session.transfer
                def transfer(action, **fields):
                    result = original_transfer(action, **fields)
                    result.disposition['grant']['url'] = f'http://127.0.0.1:{upstream.server_port}/source'
                    return result
                session.transfer = transfer
                logs = StringIO()
                try:
                    with redirect_stderr(logs), ScopedSourceServer(session, [source], transport=SignedHttpTransport(allow_loopback_http=True)) as server:
                        server.allow_reads()
                        self.assertEqual(self.get(server, range='bytes=0-3')[0], 502)
                        self.assertEqual(server.bytes_transferred, 0)
                        self.assertEqual(server.upstream_requests, 0)
                        if mode == 'cancelled': self.assertEqual(self.get(server, range='bytes=4-7')[0], 503)
                    self.assertEqual(requests, [('bytes=0-3', '"source"')] * expected_calls)
                    self.assertEqual(len(session.grants), expected_calls)
                    if mode == 'truncated':
                        records = [json.loads(line) for line in logs.getvalue().splitlines()]
                        self.assertEqual(len(records), 3)
                        self.assertTrue(all(row['phase'] == 'response_body' and row['status'] == 206
                            and row['failureKind'] == 'incomplete_body' and row['bufferedResponseBytes'] == 2 for row in records))
                    if mode in {'short-declaration', 'etag', 'range'}:
                        self.assertTrue(session.cancel_event.is_set())
                finally:
                    upstream.shutdown();upstream.server_close();thread.join(timeout=1)

    def test_transport_retries_are_bounded_and_stop_on_owner_loss_or_invalid_grants(self):
        for code, cancel, expected_calls in [('multipart_transport_failed', False, 3),
                ('multipart_transport_failed', True, 1), ('multipart_grant_invalid', False, 1),
                ('multipart_response_too_large', False, 1)]:
            with self.subTest(code=code, cancel=cancel):
                source, session, _ = self.fixture(b'0123456789abcdef')
                requests = []
                class FailedTransport:
                    async def request(self, *args):
                        requests.append(args)
                        if cancel: session.cancel_event.set()
                        raise MultipartTransferError(code)
                with ScopedSourceServer(session, [source], transport=FailedTransport()) as server:
                    server.allow_reads()
                    self.assertEqual(self.get(server, range='bytes=0-3')[0], 502)
                    self.assertEqual(server.bytes_transferred, 0)
                    if cancel: self.assertEqual(self.get(server, range='bytes=4-7')[0], 503)
                self.assertEqual(len(requests), expected_calls)
                self.assertEqual(len(session.grants), expected_calls)

    def test_transport_recovery_rechecks_the_frozen_source_before_another_request(self):
        source, session, _ = self.fixture(b'0123456789abcdef')
        requests = []
        class FailedTransport:
            async def request(self, *args):
                requests.append(args)
                session.source = {**source, 'etag': '"changed"'}
                raise MultipartTransferError('multipart_transport_failed')
        with ScopedSourceServer(session, [source], transport=FailedTransport()) as server:
            server.allow_reads()
            self.assertEqual(self.get(server, range='bytes=0-3')[0], 502)
            self.assertTrue(session.cancel_event.is_set())
            self.assertEqual(server.bytes_transferred, 0)
        self.assertEqual(len(requests), 1)
        self.assertEqual(len(session.grants), 2)

    def test_overlapping_reads_reuse_only_verified_immutable_bytes_and_still_require_a_live_owner(self):
        data=bytes(range(64));source,session,transport=self.fixture(data)
        with ScopedSourceServer(session,[source],transport=transport) as server:
            server.allow_reads()
            self.assertEqual(self.get(server,range='bytes=7-26')[2],data[7:27])
            self.assertEqual(self.get(server,range='bytes=10-15')[2],data[10:16])
            self.assertEqual(len(transport.requests),1)
            self.assertEqual(self.get(server,range='bytes=0-30')[2],data[:31])
            self.assertEqual([row[2]['range'] for row in transport.requests],['bytes=7-26','bytes=0-6','bytes=27-30'])
            self.assertEqual(server.bytes_transferred,31)
            self.assertEqual(server.upstream_requests,3)
            session.cancel_event.set()
            self.assertEqual(self.get(server,range='bytes=10-15')[0],503)
            self.assertEqual(len(transport.requests),3)

    def test_an_open_ended_reader_that_stops_after_32_bytes_does_not_prefetch_a_megabyte(self):
        source,session,_=self.fixture(b'x')
        source['byteLength']=10*1024**3
        class VirtualTransport:
            async def request(self,grant,method,body,headers,maximum,cancelled):
                time.sleep(.002)
                start,end=map(int,headers['range'][6:].split('-'));length=end-start+1
                return TransferResponse(206,{'etag':'"source"','content-length':str(length),
                    'content-range':f'bytes {start}-{end}/{source["byteLength"]}'},b'x'*length)
        with ScopedSourceServer(session,[source],transport=VirtualTransport()) as server:
            server.allow_reads()
            connection=http.client.HTTPConnection('127.0.0.1',server.port,timeout=3)
            connection.request('GET',server.path('original'),headers={'Range':'bytes=0-'})
            response=connection.getresponse();self.assertEqual(response.read(32),b'x'*32)
            response.close();connection.close()
            time.sleep(.1)
            self.assertLessEqual(server.bytes_transferred,512*1024)
            before=server.bytes_transferred;time.sleep(.1)
            self.assertEqual(server.bytes_transferred,before)

    def test_a_ten_gib_source_has_a_bounded_cache_that_evicts_bytes_without_changing_output(self):
        class VirtualData:
            def __len__(self):return 10*1024**3
            def __getitem__(self,span):return b'x'*(span.stop-span.start)
        source,session,transport=self.fixture(VirtualData())
        with ScopedSourceServer(session,[source],transport=transport) as server:
            server.allow_reads();tracemalloc.start()
            try:
                connection=http.client.HTTPConnection('127.0.0.1',server.port,timeout=3)
                connection.request('GET',server.path('original'),headers={'Range':f'bytes=0-{80*1024**2-1}'})
                response=connection.getresponse();received=0
                while chunk:=response.read(64*1024):
                    self.assertEqual(chunk,b'x'*len(chunk));received+=len(chunk)
                response.close();connection.close()
                self.assertEqual(received,80*1024**2)
                self.assertEqual(len(self.get(server,range=f'bytes=0-{1024**2-1}')[2]),1024**2)
                self.assertEqual(server.bytes_transferred,81*1024**2)
                requests=len(transport.requests)
                self.assertEqual(len(self.get(server,range=f'bytes={79*1024**2}-{80*1024**2-1}')[2]),1024**2)
                self.assertEqual(len(transport.requests),requests)
                _,peak=tracemalloc.get_traced_memory()
            finally:tracemalloc.stop()
            self.assertLess(peak,80*1024**2)
            print(json.dumps({'message':'native_source_cache_memory','virtualSourceBytes':len(transport.data),
                'readBytes':server.bytes_transferred,'peakTrackedBytes':peak,'ceilingBytes':80*1024**2}))

    def test_tiny_cached_ranges_also_have_a_finite_entry_bound(self):
        source,session,transport=self.fixture(bytes(range(256))*2)
        with ScopedSourceServer(session,[source],transport=transport) as server:
            server.allow_reads()
            for index in range(129):
                offset=index*2
                self.assertEqual(self.get(server,range=f'bytes={offset}-{offset}')[2],transport.data[offset:offset+1])
            self.assertEqual(len(transport.requests),129)
            self.assertEqual(self.get(server,range='bytes=0-0')[2],b'\0')
            self.assertEqual(len(transport.requests),130)
            self.assertEqual(self.get(server,range='bytes=256-256')[2],b'\0')
            self.assertEqual(len(transport.requests),130)


class GrantReuseTests(unittest.TestCase):
    """A grant is reused across chunks until expiry minus the margin, and refreshed on expiry or 403."""
    def setUp(self):
        self.now=[1_000_000.0]
        self.data=bytes(range(256))*4096

    def fixture_with_expiry(self, lifetime=120):
        source={'name':'original','storageKey':'execution/1/source','etag':'"source"','byteLength':len(self.data),'sha256':'a'*64}
        session=Session(source);transport=Transport(self.data);original=session.transfer
        def transfer(action, **fields):
            result=original(action,**fields)
            expires=datetime.fromtimestamp(self.now[0]+lifetime,timezone.utc).isoformat().replace('+00:00','Z')
            result.disposition['grant']={'url':'https://scoped.invalid/source','headers':{'if-match':source['etag']},'expiresAt':expires}
            return result
        session.transfer=transfer
        return source,session,transport

    def read(self, server, start, end):
        connection=http.client.HTTPConnection('127.0.0.1',server.port,timeout=3)
        connection.request('GET',server.path('original'),headers={'Range':f'bytes={start}-{end}'})
        response=connection.getresponse();result=(response.status,response.read());connection.close();return result

    def test_many_chunks_use_one_source_read_and_identical_bytes(self):
        source,session,transport=self.fixture_with_expiry()
        with ScopedSourceServer(session,[source],transport=transport,clock=lambda:self.now[0]) as server:
            server.allow_reads()
            status,body=self.read(server,0,4*1024**2-1)
            self.assertEqual((status,body),(206,self.data[:4*1024**2]))
            self.assertGreater(len(transport.requests),4)
            self.assertEqual(len(session.grants),1)
            self.assertTrue(all(row[2]['if-match']=='"source"' for row in transport.requests))

    def test_local_cancel_still_stops_reads_with_a_cached_grant(self):
        source,session,transport=self.fixture_with_expiry()
        with ScopedSourceServer(session,[source],transport=transport,clock=lambda:self.now[0]) as server:
            server.allow_reads();self.read(server,0,99)
            session.cancel_event.set();before=len(transport.requests)
            self.assertEqual(self.read(server,100,199)[0],503)
            self.assertEqual(len(transport.requests),before)

    def test_grant_is_refreshed_inside_the_safety_margin(self):
        source,session,transport=self.fixture_with_expiry()
        with ScopedSourceServer(session,[source],transport=transport,clock=lambda:self.now[0]) as server:
            server.allow_reads();self.read(server,0,99)
            self.now[0]+=89;self.read(server,200,299);self.assertEqual(len(session.grants),1)
            self.now[0]+=2;self.assertEqual(self.read(server,400,499)[1],self.data[400:500])
            self.assertEqual(len(session.grants),2)

    def test_a_403_refreshes_the_grant_once_and_the_range_is_unchanged(self):
        source,session,transport=self.fixture_with_expiry();rejected=[]
        original=transport.request
        async def request(grant, method, body, headers, maximum, cancelled):
            if len(transport.requests)==1 and not rejected:
                rejected.append(grant);transport.requests.append((grant,method,dict(headers),maximum))
                return TransferResponse(403,{},b'')
            return await original(grant,method,body,headers,maximum,cancelled)
        transport.request=request
        with ScopedSourceServer(session,[source],transport=transport,clock=lambda:self.now[0]) as server:
            server.allow_reads();self.read(server,0,99)
            self.assertEqual(self.read(server,200,299)[1],self.data[200:300])
            self.assertEqual(len(session.grants),2)
            self.assertEqual(transport.requests[1][2]['range'],transport.requests[2][2]['range'])
            self.assertEqual(self.read(server,400,499)[1],self.data[400:500])
            self.assertEqual(len(session.grants),2)
