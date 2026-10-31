"""A supervised Dub child gets finite local ports, never control/storage keys."""
from __future__ import annotations

import asyncio
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import secrets
import sys
from threading import Event, Lock, Thread

from .artifacts import AssignedArtifacts
from .control import ExecutionControlError
from .native_runtime import NativeOperationFailure, _environment, _file_facts, _json, _work
from .process import MediaProcessError, run_owned_process_async
from .source_runtime import verify_source_runtime
from .source_server import ScopedSourceServer, CHUNK_BYTES

STAGES={'translation_intent':('probe','application/json',65536),'translation_result':('probe','application/json',1024**2),
        'speech_intent':('probe','application/json',65536),'audio':('dub_mix','audio/mpeg',64*1024**2),
        'video':('dub_mix','video/mp4',10*1024**3),'final_result':('probe','application/json',65536)}


def artifact_binding(request_hash,stage):
    return hashlib.sha256(json.dumps({'version':1,'kind':'dubbing_artifact','requestHash':request_hash,'stage':stage},separators=(',',':')).encode()).hexdigest()


class DubbingControlServer:
    def __init__(self,session,package,work,sources,*,transport=None):
        self.session=session;self.command=package.command;self.work=work;self.sources=sources;self.transport=transport
        self.artifacts=AssignedArtifacts(session,package);self.outputs={};self.completed=set();self.outcome=None;self.error=None
        self._started=Event();self._lock=Lock();self._path='/'+secrets.token_urlsafe(32)
        for output in package.outputs:
            stage=next((name for name in STAGES if output['bindingHash']==artifact_binding(self.command['requestHash'],name)),None)
            if stage is None or stage in self.outputs:raise NativeOperationFailure('native_assignment_invalid')
            role,mime,maximum=STAGES[stage]
            if output['role']!=role or output['contentType']!=mime or output['maxBytes']>maximum:raise NativeOperationFailure('native_assignment_invalid')
            self.outputs[stage]=output
        if 'final_result' not in self.outputs:raise NativeOperationFailure('native_assignment_invalid')
        owner=self
        class Handler(BaseHTTPRequestHandler):
            protocol_version='HTTP/1.1'
            def log_message(self,*_):pass
            def do_POST(self):
                self.close_connection=True
                if self.path!=owner._path:return self.reply(404,{})
                if not owner._lock.acquire(blocking=False):return self.reply(503,{})
                try:
                    raw=self.headers.get('Content-Length','')
                    if not re.fullmatch(r'[0-9]{1,5}',raw) or not 0<int(raw)<=65536:raise ValueError()
                    body=self.rfile.read(int(raw))
                    if len(body)!=int(raw):raise ValueError()
                    self.reply(200,owner.handle(_json(body,65536)))
                except BaseException as error:
                    if owner.error is None:owner.error=error
                    owner.session.cancel_event.set();self.reply(502,{'errorCode':'dubbing_control_unavailable'})
                finally:owner._lock.release()
            def reply(self,status,value):
                raw=json.dumps(value,separators=(',',':'),allow_nan=False).encode()
                self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.send_header('Connection','close');self.end_headers()
                try:self.wfile.write(raw)
                except (OSError,ConnectionError):pass
        self._server=ThreadingHTTPServer(('127.0.0.1',0),Handler);self._server.daemon_threads=True;self._server.block_on_close=False
        self.url=f'http://127.0.0.1:{self._server.server_address[1]}'+self._path
        self._thread=Thread(target=self._server.serve_forever,kwargs={'poll_interval':0.05},daemon=True,name='dubbing-control')

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

    def handle(self,value):
        if not self._started.is_set():raise ExecutionControlError('execution_start_unconfirmed')
        if not isinstance(value,dict) or self.outcome is not None:raise NativeOperationFailure('dubbing_command_invalid')
        operation=value.get('operation');fields={'authority':set(),'download':{'sourceName','path','maxBytes'},'checkpoint':{'stage','path'},'publish':{'stage','path'}}
        if operation not in fields or set(value)!={'operation'}|fields[operation]:raise NativeOperationFailure('dubbing_command_invalid')
        self.session.assert_live()
        if operation=='authority':
            if self.session.command('read-disposition').disposition.get('disposition')!='started':raise ExecutionControlError('execution_authority_lost')
            return {}
        path=self.path(value['path'],exists=operation!='download')
        if operation=='download':
            source=self.sources._sources.get(value['sourceName'])
            caps={'base_video':10*1024**3,'translation_result':1024**2,'dub_audio':64*1024**2,'dub_video':10*1024**3}
            if source is None or type(value['maxBytes']) is not int or not source['byteLength']<=value['maxBytes']<=caps[source['name']]:raise NativeOperationFailure('native_source_invalid')
            digest=hashlib.sha256();cursor=0
            with path.open('xb') as output:
                while cursor<source['byteLength']:
                    chunk=self.sources._read(source,cursor,min(source['byteLength']-1,cursor+CHUNK_BYTES-1));output.write(chunk);digest.update(chunk);cursor+=len(chunk)
            if 'sha256' in source and source['sha256']!=digest.hexdigest():raise NativeOperationFailure('native_source_changed')
            path.chmod(0o400);return {}
        stage=value['stage'];assigned=self.outputs.get(stage)
        if assigned is None or stage in self.completed or (operation=='publish')!=(stage in {'audio','video'}):raise NativeOperationFailure('native_assignment_invalid')
        size,sha=_file_facts(path,self.session,assigned['maxBytes']);path.chmod(0o400)
        if operation=='checkpoint':
            evidence=_json(path.read_bytes(),STAGES[stage][2])
            if (not isinstance(evidence,dict) or evidence.get('stage')!=stage or evidence.get('requestHash')!=self.command['requestHash']
                    or evidence.get('dubId')!=self.command['request']['dubId']):raise NativeOperationFailure('native_result_invalid')
        asyncio.run(self.artifacts.upload(assigned['artifactId'],path,content_type=assigned['contentType'],byte_length=size,sha256=sha,transport=self.transport))
        self.completed.add(stage)
        if stage=='final_result':
            if evidence.get('outcome') not in {'completed','rejected','unknown'}:raise NativeOperationFailure('native_result_invalid')
            self.outcome={'outcome':evidence['outcome']}
        return {'byteLength':size,'sha256':sha} if operation=='publish' else {}


async def run_dubbing(session,package,work:Path,*,api_key=None,transport=None,source_transport=None,bun_executable='bun',verify_runtime=verify_source_runtime,cli_path=None):
    package.assert_session(session);session.assert_live();directory=_work(work);command=package.command
    if (package.function_name!='dub_mix' or not isinstance(command,dict) or command.get('kind')!='dub_mix' or command.get('version')!=1
            or command.get('request',{}).get('workflowRunId')!=session.fence['reference']['subject']['id'] or session.fence['reference']['subject']['kind']!='workflow_run'):
        raise NativeOperationFailure('dubbing_command_invalid')
    if await verify_runtime(session,bun_executable=bun_executable)!=command.get('toolchainFingerprint'):raise NativeOperationFailure('dubbing_runtime_invalid',True)
    sources=list(package.sources);names={source['name'] for source in sources}
    if (len(names)!=len(sources) or not names<={'base_video','translation_result','dub_audio','dub_video'} or 'base_video' not in names
            or any(source['name']!='base_video' and 'sha256' not in source for source in sources)):
        raise NativeOperationFailure('native_source_invalid')
    base=next(source for source in sources if source['name']=='base_video')
    if {key:base[key] for key in ('storageKey','etag','byteLength','sha256') if key in base}!=command.get('baseVideo'):raise NativeOperationFailure('native_source_invalid')
    raw=json.dumps(command,separators=(',',':'),allow_nan=False,ensure_ascii=False).encode()
    if len(raw)>16*1024**2:raise NativeOperationFailure('dubbing_command_invalid')
    input_path=directory/'dubbing-input.json';input_path.write_bytes(raw);input_path.chmod(0o400)
    with ScopedSourceServer(session,sources,transport=source_transport) as source_server,DubbingControlServer(session,package,directory,source_server,transport=transport) as control:
        env=_environment()
        if any(stage in control.outputs for stage in ('translation_intent','speech_intent')) and api_key is None:raise NativeOperationFailure('dub_provider_configuration_invalid')
        if api_key is not None:
            if not isinstance(api_key,str) or not 0<len(api_key)<=8192 or any(char in api_key for char in '\r\n\0'):raise NativeOperationFailure('dub_provider_configuration_invalid')
            env['OPENAI_API_KEY']=api_key
        def on_start(pid):session.on_process_start(pid);source_server.allow_reads();control.allow()
        body=json.dumps({'inputPath':str(input_path),'work':str(directory),'rpcUrl':control.url,'sourceNames':sorted(names),'stages':list(control.outputs)},separators=(',',':')).encode()
        try:
            result=await run_owned_process_async([bun_executable,str(cli_path or Path(__file__).resolve().parents[2]/'src/dubbing-cli.ts')],input_bytes=body,
                timeout_seconds=session.remaining_seconds,kill_grace_seconds=5,env=env,on_start=on_start,cancel_event=session.cancel_event,max_file_bytes=10*1024**3)
        except MediaProcessError as error:
            if control.error:raise control.error
            if error.code in {'media_process_start_unconfirmed','media_execution_cancelled'}:raise ExecutionControlError('execution_authority_lost') from None
            raise NativeOperationFailure('dubbing_process_unavailable',True) from None
        if control.error:raise control.error
        for line in result.stderr.splitlines():
            try:
                diagnostic=json.loads(line)
                code=diagnostic.get('errorCode')
                if diagnostic.get('message')=='dubbing_audio_inspection_unconfirmed' and isinstance(code,str) and re.fullmatch(r'[a-z][a-z0-9_]{0,99}',code):
                    print(json.dumps({'level':'warn','message':'dubbing_audio_inspection_unconfirmed','errorCode':code}),file=sys.stderr)
                if diagnostic.get('message')=='dubbing_provider_outcome_unconfirmed' and diagnostic.get('providerStage') in {'translation','speech'} and diagnostic.get('phase') in {'request','response','body','payload'}:
                    print(json.dumps({'level':'warn','message':'dubbing_provider_outcome_unconfirmed','providerStage':diagnostic['providerStage'],'phase':diagnostic['phase'],
                        'ioCode':diagnostic.get('ioCode') if diagnostic.get('ioCode') in {'EEXIST','EBADF','ENOSPC','EACCES','EPERM','ERR_INVALID_ARG_TYPE','ERR_INVALID_ARG_VALUE'} else None}),file=sys.stderr)
            except (ValueError,AttributeError):pass
        if result.returncode or control.outcome is None or _json(result.stdout,65536)!=control.outcome:raise NativeOperationFailure('dubbing_result_unconfirmed',True)
        return {**control.outcome,'sourceBytesTransferred':source_server.bytes_transferred}
