"""Pin a verified upload through conditional ranges into its assigned multipart object."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
import re

from .control import ExecutionControlError
from .fetch import FileSnapshot,SourceFetchFailure
from .file_source_runtime import NativeFileRuntime,publish_original
from .multipart import PART_SIZE_BYTES,SignedHttpTransport,TransferResponse,MultipartTransferError,pin_source
from .native_runtime import NativeOperationFailure,download_assigned_source
from .source_sink import ScopedSourceSink
from .transfer import ScopedMultipartControl


async def run_upload_pin(session,package,work:Path,*,bun_executable='bun',curl_executable='curl',
                         transport=None,runtime=None,sink_class=ScopedSourceSink,prefix_reader=download_assigned_source):
    package.assert_session(session);command=package.command
    if (package.function_name!='pin_source' or command.get('kind')!='upload_source' or
            command.get('audioPolicy') not in {'required','none','pending_pack'}):
        raise SourceFetchFailure('source_runtime_invalid')
    source=command['source'];sources=[value for value in package.sources if value['name']=='upload_source']
    outputs=[value for value in package.outputs if value['role']=='source_video']
    if (len(sources)!=1 or len(outputs)!=1 or any(sources[0].get(key)!=source[key] for key in ['storageKey','etag','byteLength'])
            or outputs[0].get('sourceEtag')!=source['etag'] or outputs[0].get('sourceByteLength')!=source['byteLength']
            or outputs[0]['maxBytes']!=source['byteLength'] or source['contentType'] not in outputs[0]['contentTypes']):
        raise SourceFetchFailure('worker_invalid_payload')
    if work.is_symlink() or not work.is_dir():raise SourceFetchFailure('worker_invalid_payload')
    path=work/'original.bin'
    if path.exists() or path.is_symlink():raise SourceFetchFailure('worker_invalid_payload')
    first_end=min(PART_SIZE_BYTES,source['byteLength'])
    try:
        first=await prefix_reader(session,package,work,source_name='upload_source',maximum_bytes=PART_SIZE_BYTES,
            range_end=first_end,curl_executable=curl_executable)
    except NativeOperationFailure as error:
        raise SourceFetchFailure('upload_source_changed' if error.code=='native_source_changed' else 'source_download_failed',error.code!='native_source_changed') from None
    first_snapshot=FileSnapshot.read(first)
    if first.is_symlink() or first_snapshot.size!=first_end:raise SourceFetchFailure('upload_source_changed')
    session.assert_live()
    descriptor=os.open(path,os.O_CREAT|os.O_EXCL|os.O_RDWR|getattr(os,'O_NOFOLLOW',0),0o600)
    native=transport if transport is not None else SignedHttpTransport(timeout_seconds=60)
    class Tee:
        async def request(self,grant,method,body,headers,maximum,cancelled):
            session.assert_live()
            if method!='GET':return await native.request(grant,method,body,headers,maximum,cancelled)
            values={name.lower():value for name,value in headers.items()};match=re.fullmatch(r'bytes=(\d+)-(\d+)',values.get('range',''))
            if not match or values.get('if-match')!=source['etag']:raise MultipartTransferError('multipart_source_changed')
            start,end=int(match[1]),int(match[2])+1
            if not 0<=start<end<=source['byteLength'] or end-start>PART_SIZE_BYTES:raise MultipartTransferError('multipart_source_changed')
            if start==0:
                if end!=first_end or FileSnapshot.read(first)!=first_snapshot:raise MultipartTransferError('multipart_source_changed')
                data=await asyncio.to_thread(first.read_bytes)
                if FileSnapshot.read(first)!=first_snapshot:raise MultipartTransferError('multipart_source_changed')
                response=TransferResponse(206,{'ETag':source['etag'],'Content-Length':str(len(data)),'Content-Range':f'bytes 0-{end-1}/{source["byteLength"]}'},data)
            else:response=await native.request(grant,method,body,headers,maximum,cancelled)
            session.assert_live()
            if response.status==206:
                if len(response.body)!=end-start:raise MultipartTransferError('multipart_source_changed')
                # A bounded local write keeps descriptor ownership in this task;
                # no cancelled background writer can outlive the private file.
                if os.pwrite(descriptor,response.body,start)!=len(response.body):raise MultipartTransferError('multipart_source_changed')
            return response
    try:
        os.ftruncate(descriptor,source['byteLength'])
        control=await ScopedMultipartControl.initialize(session,artifact_id=outputs[0]['artifactId'],byte_length=source['byteLength'],
            content_type=source['contentType'],source_etag=source['etag'])
        try:
            completed=await pin_source(control.destination,source_etag=source['etag'],control=control,transport=Tee(),
                assert_owned=session.assert_live,cancel_event=session.cancel_event,expected_sha256=sources[0].get('sha256'))
        except MultipartTransferError as error:
            if control.completion_started:raise ExecutionControlError('execution_completion_unconfirmed') from None
            raise SourceFetchFailure('upload_source_changed' if error.code=='multipart_source_changed' else 'source_download_failed',error.code!='multipart_source_changed') from None
    finally:os.close(descriptor)
    path.chmod(0o400)
    runtime=runtime if runtime is not None else NativeFileRuntime(session,bun_executable=bun_executable)
    sink=sink_class(session,package,work,bun_executable=bun_executable)
    await publish_original(session,package,work,path,source['contentType'],runtime=runtime,sink=sink,completed=completed)
