"""Private ranged reads for FFmpeg from verified, scoped source assignments."""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import re
import secrets
import socket
from threading import BoundedSemaphore, Event, Lock, Thread

from .control import ExecutionControlError
from .multipart import SignedGrant, SignedHttpTransport

CHUNK_BYTES = 1024 * 1024
INITIAL_CHUNK_BYTES = 64 * 1024
SOCKET_SEND_BYTES = 64 * 1024
MAX_CONNECTIONS = 4
MAX_CACHE_BYTES = 32 * 1024 * 1024
MAX_CACHE_ENTRIES = 128


class ScopedSourceServer:
    """Loopback transport only. The operation supplies verified package sources.

    No source URL is handed to FFmpeg. Each upstream chunk gets a fresh scoped
    grant and If-Match. A 32MiB/128-entry LRU reuses verified immutable intervals
    within this operation, plus at most four 1MiB response buffers.
    The actual Popen start acknowledgement must precede allow_reads().
    """
    def __init__(self, session, sources, *, transport=None):
        self._session=session;self._transport=transport or SignedHttpTransport()
        self._sources={source['name']:dict(source) for source in sources}
        if len(self._sources)!=len(sources) or not 1<=len(sources)<=4096:
            raise ExecutionControlError('execution_source_invalid')
        for name,source in self._sources.items():
            if (not isinstance(name,str) or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,159}',name) is None
                    or type(source.get('byteLength')) is not int or not 0<source['byteLength']<=10*1024**3
                    or not isinstance(source.get('etag'),str) or re.fullmatch(r'"[^\r\n"]+"',source['etag']) is None):
                raise ExecutionControlError('execution_source_invalid')
        self._started=Event();self._stopped=Event();self._slots=BoundedSemaphore(MAX_CONNECTIONS)
        self._counter_lock=Lock();self.bytes_transferred=0;self.upstream_requests=0
        self._cache_lock=Lock();self._cache=OrderedDict();self._cache_bytes=0
        self._connection_lock=Lock();self._connections=set()
        self._nonce=secrets.token_urlsafe(32)
        owner=self
        class Handler(BaseHTTPRequestHandler):
            protocol_version='HTTP/1.1'
            def setup(self):
                super().setup()
                self.connection.setsockopt(socket.SOL_SOCKET,socket.SO_SNDBUF,SOCKET_SEND_BYTES)
                self.connection.settimeout(30)
            def log_message(self,*_):pass
            def do_HEAD(self):self.handle_source(True)
            def do_GET(self):self.handle_source(False)
            def handle_source(self,head):
                self.close_connection=True
                prefix='/'+owner._nonce+'/'
                source=owner._sources.get(self.path[len(prefix):]) if self.path.startswith(prefix) else None
                if source is None:return self.empty(404)
                try:owner._assert_readable()
                except Exception:return self.empty(503)
                if not owner._slots.acquire(blocking=False):return self.empty(503)
                with owner._connection_lock:owner._connections.add(self.connection)
                try:
                    length=source['byteLength'];start,end=0,length-1;status=200
                    requested=self.headers.get('Range')
                    if requested is not None:
                        match=re.fullmatch(r'bytes=([0-9]+)-([0-9]*)',requested)
                        if match is None:return self.empty(416)
                        start=int(match[1]);end=min(length-1,int(match[2])) if match[2] else length-1;status=206
                        if start>end or start>=length:return self.empty(416)
                    first=None
                    if not head:
                        try:first=owner._read(source,start,min(end,start+INITIAL_CHUNK_BYTES-1))
                        except Exception:return self.empty(502)
                    self.send_response(status)
                    self.send_header('Content-Length',str(end-start+1));self.send_header('Content-Type','application/octet-stream')
                    self.send_header('ETag',source['etag']);self.send_header('Accept-Ranges','bytes')
                    self.send_header('Connection','close')
                    if status==206:self.send_header('Content-Range',f'bytes {start}-{end}/{length}')
                    self.end_headers()
                    if head:return
                    cursor=start;chunk_limit=INITIAL_CHUNK_BYTES
                    while cursor<=end:
                        owner._assert_readable()
                        chunk=first if first is not None else owner._read(source,cursor,min(end,cursor+chunk_limit-1))
                        first=None
                        self.wfile.write(chunk);self.wfile.flush();cursor+=len(chunk)
                        chunk_limit=min(CHUNK_BYTES,chunk_limit*2)
                except (BrokenPipeError,ConnectionError,OSError,ExecutionControlError):pass
                finally:
                    with owner._connection_lock:owner._connections.discard(self.connection)
                    owner._slots.release()
            def empty(self,status):
                self.send_response(status);self.send_header('Content-Length','0');self.send_header('Connection','close');self.end_headers()
        self._server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self._server.daemon_threads=True;self._server.block_on_close=False
        self.port=self._server.server_address[1]
        self._thread=Thread(target=self._server.serve_forever,kwargs={'poll_interval':0.05},daemon=True,name='scoped-media-source')

    def _assert_readable(self):
        if self._stopped.is_set() or not self._started.is_set():raise ExecutionControlError('execution_source_not_started')
        self._session.assert_live()

    def allow_reads(self):
        self._session.assert_live();self._started.set()

    def path(self,name):
        if name not in self._sources:raise ExecutionControlError('execution_source_invalid')
        return '/'+self._nonce+'/'+name

    def url(self,name):return f'http://127.0.0.1:{self.port}'+self.path(name)

    def _read(self,source,start,end):
        self._assert_readable()
        parts=[];cursor=start
        while cursor<=end:
            self._assert_readable();hit=None;next_start=end+1
            with self._cache_lock:
                for key,data in self._cache.items():
                    name,low,high=key
                    if name!=source['name']:continue
                    if low<=cursor<=high and (hit is None or high>hit[0][2]):hit=(key,data)
                    elif low>cursor:next_start=min(next_start,low)
                if hit is not None:
                    key,data=hit;high=min(end,key[2]);parts.append(data[cursor-key[1]:high-key[1]+1])
                    self._cache.move_to_end(key);cursor=high+1
            if hit is not None:continue
            high=min(end,next_start-1)
            data=self._read_uncached(source,cursor,high)
            self._assert_readable()
            with self._cache_lock:
                key=(source['name'],cursor,high);previous=self._cache.pop(key,None)
                if previous is not None:self._cache_bytes-=len(previous)
                self._cache[key]=data;self._cache_bytes+=len(data)
                while self._cache_bytes>MAX_CACHE_BYTES or len(self._cache)>MAX_CACHE_ENTRIES:
                    _,evicted=self._cache.popitem(last=False);self._cache_bytes-=len(evicted)
            parts.append(data);cursor=high+1
        self._assert_readable()
        return parts[0] if len(parts)==1 else b''.join(parts)

    def _read_uncached(self,source,start,end):
        self._assert_readable()
        expected={key:source[key] for key in ('storageKey','etag','byteLength','sha256') if key in source}
        for attempt in range(3):
            self._assert_readable()
            result=self._session.transfer('source-read',sourceId=source['name']).disposition
            if result.get('object')!=expected:
                self._session.cancel_event.set();raise ExecutionControlError('execution_source_changed')
            grant=result['grant'];headers={'range':f'bytes={start}-{end}','if-match':source['etag'],'accept-encoding':'identity'}
            response=asyncio.run(self._transport.request(SignedGrant(grant['url'],grant['headers']),'GET',None,headers,
                end-start+1,lambda:self._stopped.is_set() or self._session.cancel_event.is_set()))
            self._assert_readable();facts={key.lower():value for key,value in response.headers.items()}
            if response.status in {403,408,429,500,502,503,504} and attempt<2:continue
            if (response.status!=206 or facts.get('etag')!=source['etag'] or facts.get('content-length')!=str(end-start+1)
                    or facts.get('content-range')!=f'bytes {start}-{end}/{source["byteLength"]}' or len(response.body)!=end-start+1):
                self._session.cancel_event.set();raise ExecutionControlError('execution_source_changed')
            with self._counter_lock:
                self.bytes_transferred+=len(response.body);self.upstream_requests+=1
            return response.body
        raise ExecutionControlError('execution_source_unavailable')

    def __enter__(self):self._thread.start();return self
    def __exit__(self,*_):
        self._stopped.set()
        with self._connection_lock:connections=list(self._connections)
        for connection in connections:
            try:connection.shutdown(socket.SHUT_RDWR)
            except OSError:pass
            connection.close()
        self._server.shutdown();self._server.server_close();self._thread.join(timeout=1)
        with self._cache_lock:self._cache.clear();self._cache_bytes=0
