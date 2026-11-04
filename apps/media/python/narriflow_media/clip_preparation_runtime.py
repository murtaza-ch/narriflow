"""One charged native child prepares source observations and scoped artifacts."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from .artifacts import AssignedArtifacts
from .control import ExecutionControlError
from .native_runtime import NativeOperationFailure, _environment, _file_facts, _json, _work
from .process import MediaProcessError, run_owned_process_async, verified_runtime_id
from .source_server import ScopedSourceServer

LIMITS={'clip_preview':512*1024**2,'preview_peaks':256*1024,'layout_evidence':1024**2}


def environment():
    value=_environment()
    for name in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS','ORT_INTRA_OP_NUM_THREADS','OPENCV_FOR_THREADS_NUM','OPENCV_FFMPEG_THREADS'):
        value[name]='2'
    value['PYTHONNOUSERSITE']='1'
    return value


async def verify_prepare_runtime(session,*,bun_executable='bun'):
    verified=verified_runtime_id()
    if verified is not None:return verified
    result=await run_owned_process_async([bun_executable,str(Path(__file__).resolve().parents[2]/'scripts/check-render-environment.ts'),
        '--enforce','--stage','start','--json','--profile','render'],timeout_seconds=min(60,session.remaining_seconds),
        env=environment(),cancel_event=session.cancel_event)
    session.assert_live()
    value=_json(result.stdout,1024**2) if result.returncode==0 else None
    if not isinstance(value,dict) or not isinstance(value.get('id'),str):raise NativeOperationFailure('clip_preparation_runtime_invalid',True)
    return value['id']


async def run_prepare_clip(session,package,work:Path,*,transport=None,source_transport=None,bun_executable='bun',
                           verify_runtime=verify_prepare_runtime):
    package.assert_session(session);session.assert_live();directory=_work(work);command=package.command
    if (package.function_name!='prepare_clip' or not isinstance(command,dict) or command.get('kind')!='prepare_clip'
            or command.get('version')!=1):raise NativeOperationFailure('clip_preparation_command_invalid')
    if await verify_runtime(session,bun_executable=bun_executable)!=command.get('toolchainFingerprint'):
        raise NativeOperationFailure('clip_preparation_runtime_invalid',True)
    original=[source for source in package.sources if source['name']=='original']
    if len(original)!=1 or {key:original[0].get(key) for key in ('storageKey','etag','byteLength','sha256')}!=command.get('source'):
        raise NativeOperationFailure('clip_preparation_source_invalid')
    outputs={output['role']:output for output in package.outputs}
    if len(outputs)!=len(package.outputs) or set(outputs)!=set(LIMITS):raise NativeOperationFailure('native_assignment_invalid')
    for role,output in outputs.items():
        if (output['bindingHash']!=command.get('bindingHash') or output['maxBytes']>LIMITS[role]
                or output['contentType']!=('video/mp4' if role=='clip_preview' else 'application/json')):
            raise NativeOperationFailure('native_assignment_invalid')
    input_path=directory/'preparation-input.json'
    if input_path.exists():raise NativeOperationFailure('native_scratch_invalid')
    raw=json.dumps(command,separators=(',',':'),allow_nan=False,ensure_ascii=False).encode()
    if len(raw)>16*1024**2:raise NativeOperationFailure('clip_preparation_command_invalid')
    input_path.write_bytes(raw);input_path.chmod(0o400)
    with ScopedSourceServer(session,original,transport=source_transport) as sources:
        def on_start(pid):
            session.on_process_start(pid);sources.allow_reads()
        body=json.dumps({'inputPath':str(input_path),'work':str(directory),'sourcePath':sources.url('original'),
            'previewArtifactId':outputs['clip_preview']['artifactId'],'peaksArtifactId':outputs['preview_peaks']['artifactId']},separators=(',',':')).encode()
        try:
            result=await run_owned_process_async([bun_executable,str(Path(__file__).resolve().parents[2]/'src/prepare-clip-cli.ts')],input_bytes=body,
                timeout_seconds=session.remaining_seconds,kill_grace_seconds=5,env=environment(),
                on_start=on_start,cancel_event=session.cancel_event,max_file_bytes=LIMITS['clip_preview'])
        except MediaProcessError as error:
            if error.code in {'media_process_start_unconfirmed','media_execution_cancelled'}:
                raise ExecutionControlError('execution_start_unconfirmed' if error.code=='media_process_start_unconfirmed' else 'execution_authority_lost') from None
            raise NativeOperationFailure('clip_preparation_process_unavailable',True) from None
        session.assert_live()
        if result.returncode:
            code='clip_preparation_failed';retryable=True
            for line in result.stderr.splitlines():
                try:
                    failure=json.loads(line)
                    if failure.get('message')=='clip_preparation_failed' and failure.get('errorCode') in {'source_identity_mismatch','clip_preparation_command_invalid'}:
                        code=failure['errorCode'];retryable=False
                except (ValueError,AttributeError):pass
            raise NativeOperationFailure(code,retryable)
        returned=_json(result.stdout,65536)
        if not isinstance(returned,dict) or set(returned)!={'previewPath','peaksPath','layoutPath'}:
            raise NativeOperationFailure('native_result_invalid')
        names={'clip_preview':('previewPath','preview.mp4'),'preview_peaks':('peaksPath','preview.peaks.json'),'layout_evidence':('layoutPath','layout.json')}
        paths={}
        for role,(field,name) in names.items():
            if role=='preview_peaks' and returned[field] is None:continue
            if returned[field]!=str(directory/name):raise NativeOperationFailure('native_result_invalid')
            path=directory/name
            if path.is_symlink() or not path.is_file() or not 0<path.stat().st_size<=outputs[role]['maxBytes']:raise NativeOperationFailure('native_result_invalid')
            path.chmod(0o400);paths[role]=path
        manifest=_json(paths['layout_evidence'].read_bytes(),LIMITS['layout_evidence'])
        if (not isinstance(manifest,dict) or manifest.get('preparationId')!=command.get('preparationId') or manifest.get('bindingHash')!=command.get('bindingHash')
                or manifest.get('preview',{}).get('artifactId')!=outputs['clip_preview']['artifactId']
                or (manifest.get('peaks',{}).get('state')=='ready')!=('preview_peaks' in paths)
                or 'preview_peaks' in paths and manifest['peaks'].get('artifactId')!=outputs['preview_peaks']['artifactId']):
            raise NativeOperationFailure('native_result_invalid')
        artifacts=AssignedArtifacts(session,package)
        for role in ('clip_preview','preview_peaks','layout_evidence'):
            if role not in paths:continue
            size,sha=await asyncio.to_thread(_file_facts,paths[role],session,outputs[role]['maxBytes'])
            await artifacts.upload(outputs[role]['artifactId'],paths[role],content_type=outputs[role]['contentType'],byte_length=size,sha256=sha,transport=transport)
        return {'bytesTransferred':sources.bytes_transferred,'upstreamRequests':sources.upstream_requests,'sourceBytes':original[0]['byteLength']}
