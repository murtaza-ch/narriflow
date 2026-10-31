"""One actual Bun child renders through a private, narrowly typed control bridge."""
from __future__ import annotations

import asyncio
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import secrets
from threading import BoundedSemaphore, Event, Lock, Thread

from .artifacts import AssignedArtifacts
from .clip_preparation_runtime import environment, verify_prepare_runtime
from .control import ExecutionControlError
from .native_runtime import NativeOperationFailure, _file_facts, _json, _work
from .process import MediaProcessError, run_owned_process_async
from .source_server import ScopedSourceServer, CHUNK_BYTES


def artifact_binding(input_hash, render_id, role):
    value={'version':1,'kind':'render_artifact','role':role,'renderId':render_id,'inputHash':input_hash}
    return hashlib.sha256(json.dumps(value,separators=(',',':')).encode()).hexdigest()


class RenderControlServer:
    def __init__(self,session,package,work,sources,*,transport=None):
        self.session=session;self.work=work;self.sources=sources;self.transport=transport
        self.artifacts=AssignedArtifacts(session,package);self.outputs={};self.uploaded={};self.settled=set()
        self.outcome=None;self.error=None;self._lock=Lock();self._started=Event();self._slots=BoundedSemaphore(4)
        self._path='/'+secrets.token_urlsafe(32)
        command=package.command;self._command=command
        members={variant['renderId'] for variant in command['variants']}
        if not 1<=len(members)<=4:raise NativeOperationFailure('render_command_invalid')
        for output in package.outputs:
            role=output['role']
            render_id=next((value for value in members if output['bindingHash']==artifact_binding(package.input_hash,value,role)),None)
            mime='video/mp4' if role=='render_variant' else 'application/json'
            maximum=10*1024**3 if role=='render_variant' else 65536
            if (role not in {'render_variant','render_outcome'} or render_id is None or (render_id,role) in self.outputs
                    or output['contentType']!=mime or output['maxBytes']>maximum):raise NativeOperationFailure('native_assignment_invalid')
            self.outputs[render_id,role]=output
        self.render_ids=sorted({value[0] for value in self.outputs})
        if not self.render_ids or any((identity,role) not in self.outputs for identity in self.render_ids for role in ('render_variant','render_outcome')):
            raise NativeOperationFailure('native_assignment_invalid')
        owner=self
        class Handler(BaseHTTPRequestHandler):
            protocol_version='HTTP/1.1'
            def log_message(self,*_):pass
            def do_POST(self):
                self.close_connection=True
                if self.path!=owner._path:return self.reply(404,{})
                if not owner._slots.acquire(blocking=False):return self.reply(503,{})
                try:
                    raw=self.headers.get('Content-Length','')
                    if not re.fullmatch(r'[0-9]{1,5}',raw) or not 0<int(raw)<=65536:raise ValueError()
                    body=self.rfile.read(int(raw))
                    if len(body)!=int(raw):raise ValueError()
                    value=owner.handle(_json(body,65536))
                    self.reply(200,value)
                except BaseException as error:
                    with owner._lock:
                        if owner.error is None:owner.error=error
                    owner.session.cancel_event.set()
                    self.reply(502,{'errorCode':'render_control_unavailable'})
                finally:owner._slots.release()
            def reply(self,status,value):
                raw=json.dumps(value,separators=(',',':'),allow_nan=False).encode()
                self.send_response(status);self.send_header('Content-Length',str(len(raw)));self.send_header('Content-Type','application/json');self.send_header('Connection','close');self.end_headers()
                try:self.wfile.write(raw)
                except (OSError,ConnectionError):pass
        self._server=ThreadingHTTPServer(('127.0.0.1',0),Handler);self._server.daemon_threads=True;self._server.block_on_close=False
        self._thread=Thread(target=self._server.serve_forever,kwargs={'poll_interval':0.05},daemon=True,name='render-control')
        self.url=f'http://127.0.0.1:{self._server.server_address[1]}'+self._path

    def __enter__(self):self._thread.start();return self
    def __exit__(self,*_):self._server.shutdown();self._server.server_close();self._thread.join(timeout=1)
    def allow(self):self.session.assert_live();self._started.set()

    def path(self,value,*,exists=False):
        if not isinstance(value,str) or len(value)>4096:raise NativeOperationFailure('native_scratch_invalid')
        path=Path(value)
        if not path.is_absolute() or path.is_symlink() or self.work not in path.resolve().parents:raise NativeOperationFailure('native_scratch_invalid')
        cursor=path.parent
        while cursor!=self.work:
            if cursor.is_symlink():raise NativeOperationFailure('native_scratch_invalid')
            cursor=cursor.parent
        if exists and not path.is_file():raise NativeOperationFailure('native_scratch_invalid')
        return path

    def _record(self,published):
        if published.render_group is not None:
            with self._lock:
                if self.outcome is not None and self.outcome!=published.render_group:raise ExecutionControlError('execution_response_invalid')
                self.outcome=published.render_group

    def handle(self,command):
        if not self._started.is_set():raise ExecutionControlError('execution_start_unconfirmed')
        if not isinstance(command,dict):raise NativeOperationFailure('render_command_invalid')
        operation=command.get('operation')
        fields={'authority':set(),'finish':set(),'upload':{'renderId','path','usedStockIds'},'complete':{'renderId','byteLength','durationSec','captionDiagnostics'},
            'fail':{'renderId','errorCode','disposition'},'download':{'sourceName','path','maxBytes'}}
        if operation not in fields or set(command)!={'operation'}|fields[operation]:raise NativeOperationFailure('render_command_invalid')
        if operation=='finish':
            if self.outcome is None or self.settled!=set(self.render_ids):raise ExecutionControlError('execution_result_unconfirmed')
            return self.outcome
        self.session.assert_live()
        if operation=='authority':
            if self.session.command('read-disposition').disposition.get('disposition')!='started':raise ExecutionControlError('execution_authority_lost')
            return {}
        if operation=='download':
            name=command['sourceName'];source=self.sources._sources.get(name)
            if source is None or type(command['maxBytes']) is not int or not source['byteLength']<=command['maxBytes']<=10*1024**3:raise NativeOperationFailure('native_source_invalid')
            path=self.path(command['path']);digest=hashlib.sha256();cursor=0
            with path.open('xb') as output:
                while cursor<source['byteLength']:
                    chunk=self.sources._read(source,cursor,min(source['byteLength']-1,cursor+CHUNK_BYTES-1))
                    output.write(chunk);digest.update(chunk);cursor+=len(chunk)
            if source.get('sha256')!=digest.hexdigest():raise NativeOperationFailure('native_source_changed')
            path.chmod(0o400);return {}
        render_id=command['renderId']
        if render_id not in self.render_ids or render_id in self.settled:raise ExecutionControlError('execution_artifact_already_claimed')
        if operation=='upload':
            assigned=self.outputs[render_id,'render_variant'];path=self.path(command['path'],exists=True)
            ids=command['usedStockIds']
            allowed={item['attribution']['pexelsId'] for item in self._command['autoBroll']['resolved']}
            if not isinstance(ids,list) or len(ids)>6 or any(type(value) is not int or value not in allowed for value in ids) or len(set(ids))!=len(ids):raise NativeOperationFailure('render_command_invalid')
            size,sha=_file_facts(path,self.session,assigned['maxBytes']);path.chmod(0o400)
            completed=asyncio.run(self.artifacts.upload_only(assigned['artifactId'],path,content_type='video/mp4',byte_length=size,sha256=sha,transport=self.transport))
            with self._lock:self.uploaded[render_id]=(completed,ids)
            return {}
        if operation=='complete':
            uploaded=self.uploaded.get(render_id)
            if uploaded is None or command['byteLength']!=uploaded[0].byte_length:raise NativeOperationFailure('native_result_invalid')
            facts={'renderId':render_id,'durationSec':command['durationSec'],'usedStockIds':uploaded[1]}
            if command['captionDiagnostics'] is not None:facts['captionDiagnostics']=command['captionDiagnostics']
            published=asyncio.run(self.artifacts.commit_uploaded(self.outputs[render_id,'render_variant']['artifactId'],facts_builder=lambda _: {'renderVariant':facts}))
        else:
            if (not isinstance(command['errorCode'],str) or re.fullmatch(r'[a-z][a-z0-9_]{0,99}',command['errorCode']) is None
                    or command['disposition'] not in {'retryable','permanent'}):raise NativeOperationFailure('render_command_invalid')
            assigned=self.outputs[render_id,'render_outcome']
            failure={'version':1,'kind':'failed','renderId':render_id,'bindingHash':assigned['bindingHash'],'errorCode':command['errorCode'],'disposition':command['disposition']}
            path=self.work/(render_id+'-failure.json');raw=json.dumps(failure,separators=(',',':')).encode();path.write_bytes(raw);path.chmod(0o400)
            published=asyncio.run(self.artifacts.upload(assigned['artifactId'],path,content_type='application/json',byte_length=len(raw),sha256=hashlib.sha256(raw).hexdigest(),transport=self.transport))
        with self._lock:self.settled.add(render_id)
        self._record(published);return {}


async def run_render_group(session,package,work:Path,*,transport=None,source_transport=None,bun_executable='bun',verify_runtime=verify_prepare_runtime):
    package.assert_session(session);session.assert_live();directory=_work(work);command=package.command
    if (package.function_name!='render_group' or not isinstance(command,dict) or command.get('kind')!='render_group' or command.get('version')!=1
            or not isinstance(command.get('preparation'),dict) or command.get('groupId')!=session.fence['reference'].get('subject',{}).get('id')):
        raise NativeOperationFailure('render_command_invalid')
    if await verify_runtime(session,bun_executable=bun_executable)!=command['preparation'].get('toolchainFingerprint'):raise NativeOperationFailure('render_runtime_invalid',True)
    original=[source for source in package.sources if source['name']=='original']
    if len(original)!=1 or {key:original[0].get(key) for key in ('storageKey','etag','byteLength','sha256')}!=command['preparation'].get('source'):raise NativeOperationFailure('native_source_invalid')
    try:
        assets=command['assets'];frozen=[*assets['visuals'],*assets['fonts'],*assets['audio'],*([assets['logo']] if assets['logo'] else [])]
        sources=[original[0],*({'name':value['name'],**value['object']} for value in frozen)]
    except (KeyError,TypeError):raise NativeOperationFailure('render_command_invalid') from None
    raw=json.dumps(command,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
    if len(raw)>16*1024**2:raise NativeOperationFailure('render_command_invalid')
    input_path=directory/'render-input.json';input_path.write_bytes(raw);input_path.chmod(0o400)
    with ScopedSourceServer(session,sources,transport=source_transport) as source_server, RenderControlServer(session,package,directory,source_server,transport=transport) as control:
        def on_start(pid):session.on_process_start(pid);source_server.allow_reads();control.allow()
        body=json.dumps({'inputPath':str(input_path),'work':str(directory),'attemptToken':session.fence['attemptToken'],
            'renderIds':control.render_ids,'rpcUrl':control.url,'sourceBaseUrl':source_server.url('original').rsplit('/',1)[0]+'/'},separators=(',',':')).encode()
        try:
            result=await run_owned_process_async([bun_executable,str(Path(__file__).resolve().parents[2]/'src/render-group-cli.ts')],input_bytes=body,
                timeout_seconds=session.remaining_seconds,kill_grace_seconds=5,env=environment(),on_start=on_start,cancel_event=session.cancel_event,max_file_bytes=10*1024**3)
        except MediaProcessError as error:
            if control.error:raise control.error
            if error.code in {'media_process_start_unconfirmed','media_execution_cancelled'}:raise ExecutionControlError('execution_authority_lost') from None
            raise NativeOperationFailure('render_process_unavailable',True) from None
        if control.error:raise control.error
        if result.returncode or control.outcome is None or _json(result.stdout,65536)!=control.outcome:raise NativeOperationFailure('render_result_unconfirmed',True)
        return {'outcome':control.outcome,'bytesTransferred':source_server.bytes_transferred,'upstreamRequests':source_server.upstream_requests}
