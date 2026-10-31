"""One supervised ZIP child streams only frozen assigned source identities."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from .artifacts import AssignedArtifacts
from .control import ExecutionControlError
from .native_runtime import NativeOperationFailure, _environment, _file_facts, _json, _work
from .process import MediaProcessError, run_owned_process_async
from .source_runtime import verify_source_runtime
from .source_server import ScopedSourceServer

MAX_INPUT=4*1024**3
MAX_OUTPUT=MAX_INPUT+64*1024**2


async def run_export_bundle(session,package,work:Path,*,transport=None,source_transport=None,bun_executable='bun',verify_runtime=verify_source_runtime):
    package.assert_session(session);session.assert_live();directory=_work(work);command=package.command
    if (package.function_name!='export_bundle' or not isinstance(command,dict) or command.get('kind')!='export_bundle' or command.get('version')!=1
            or command.get('workflowRunId')!=session.fence['reference']['subject']['id'] or session.fence['reference']['subject']['kind']!='workflow_run'):
        raise NativeOperationFailure('export_bundle_command_invalid')
    if await verify_runtime(session,bun_executable=bun_executable)!=command.get('toolchainFingerprint'):
        raise NativeOperationFailure('export_bundle_runtime_invalid',True)
    outputs=package.outputs
    if (len(outputs)!=1 or outputs[0]['role']!='export_bundle' or outputs[0]['contentType']!='application/zip'
            or outputs[0]['bindingHash']!=command.get('bindingHash') or outputs[0]['maxBytes']>MAX_OUTPUT):
        raise NativeOperationFailure('native_assignment_invalid')
    frozen=command.get('sources')
    if not isinstance(frozen,list) or not 1<=len(frozen)<=400:
        raise NativeOperationFailure('export_bundle_command_invalid')
    sources=[{'name':source['name'],**source['object']} for source in frozen]
    if sum(source['byteLength'] for source in sources)>MAX_INPUT:raise NativeOperationFailure('export_bundle_command_invalid')
    input_path=directory/'bundle-input.json'
    if input_path.exists():raise NativeOperationFailure('native_scratch_invalid')
    raw=json.dumps(command,separators=(',',':'),allow_nan=False,ensure_ascii=False).encode()
    if len(raw)>16*1024**2:raise NativeOperationFailure('export_bundle_command_invalid')
    input_path.write_bytes(raw);input_path.chmod(0o400)
    with ScopedSourceServer(session,sources,transport=source_transport) as server:
        def on_start(pid):
            session.on_process_start(pid);server.allow_reads()
        body=json.dumps({'inputPath':str(input_path),'work':str(directory),'sourceBaseUrl':server.url(sources[0]['name']).rsplit('/',1)[0]+'/'},separators=(',',':')).encode()
        try:
            result=await run_owned_process_async([bun_executable,str(Path(__file__).resolve().parents[2]/'src/export-bundle-cli.ts')],input_bytes=body,
                timeout_seconds=session.remaining_seconds,kill_grace_seconds=5,env=_environment(),on_start=on_start,
                cancel_event=session.cancel_event,max_file_bytes=MAX_OUTPUT)
        except MediaProcessError as error:
            if error.code in {'media_process_start_unconfirmed','media_execution_cancelled'}:
                raise ExecutionControlError('execution_start_unconfirmed' if error.code=='media_process_start_unconfirmed' else 'execution_authority_lost') from None
            raise NativeOperationFailure('export_bundle_process_unavailable',True) from None
        session.assert_live()
        if result.returncode:
            code='export_bundle_process_failed'
            for line in result.stderr.splitlines():
                try:
                    failure=json.loads(line)
                    if failure.get('errorCode') in {'export_bundle_command_invalid','export_bundle_source_changed','export_bundle_manifest_invalid','export_bundle_output_too_large'}:code=failure['errorCode']
                except (ValueError,AttributeError):pass
            raise NativeOperationFailure(code,code=='export_bundle_process_failed')
        returned=_json(result.stdout,65536);path=directory/'bundle.zip'
        if not isinstance(returned,dict) or set(returned)!={'path','byteLength','sha256'} or returned['path']!=str(path):raise NativeOperationFailure('native_result_invalid')
        if path.is_symlink() or not path.is_file():raise NativeOperationFailure('native_result_invalid')
        path.chmod(0o400)
        size,sha=await asyncio.to_thread(_file_facts,path,session,outputs[0]['maxBytes'])
        if size!=returned['byteLength'] or sha!=returned['sha256']:raise NativeOperationFailure('native_result_invalid')
        published=await AssignedArtifacts(session,package).upload(outputs[0]['artifactId'],path,content_type='application/zip',byte_length=size,sha256=sha,transport=transport)
        return {'bundleId':command['bundleId'],'artifactId':published.artifact_id,'byteLength':size,'sha256':sha,'sourceBytesTransferred':server.bytes_transferred}
