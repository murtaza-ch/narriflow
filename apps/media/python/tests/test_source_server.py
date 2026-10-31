import http.client
import threading
import unittest

from narriflow_media.multipart import TransferResponse
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
