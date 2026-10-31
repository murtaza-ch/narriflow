"""Whole-original direct reads, normalized local probes and source audio extraction."""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
from pathlib import Path
from typing import Sequence

from .control import ExecutionControlError
from .fetch import ExistingSourceAudio,FileSnapshot,VerifiedSourceFile,SourceFetchFailure,verify_source_audio_binding
from .manifest import MediaSource,MAX_SOURCE_BYTES,build_audio_manifest
from .process import MediaProcessError,run_owned_process_async
from .source_sink import ScopedSourceSink,_environment

MAX_DURATION_SECONDS=4*60*60


def _json(data):
    if not isinstance(data,bytes) or not 0<len(data)<=1024*1024:raise SourceFetchFailure('source_probe_failed',True)
    def invalid(_):raise ValueError()
    try:return json.loads(data,parse_constant=invalid)
    except (ValueError,UnicodeError):raise SourceFetchFailure('source_probe_failed',True) from None


def _duration(probe):
    value=probe.get('durationSec')
    if type(value) not in {int,float} or not math.isfinite(value) or value<=0:raise SourceFetchFailure('media_duration_unavailable')
    if value>MAX_DURATION_SECONDS:raise SourceFetchFailure('ingest_max_duration_exceeded')
    return value


class NativeFileRuntime:
    def __init__(self,session,*,bun_executable='bun',download_executable:Sequence[str]|None=None):
        self.session,self.bun,self.download_executable=session,bun_executable,download_executable
        self.source=Path(__file__).resolve().parents[2]/'src'

    async def _run(self,argv,body,maximum=MAX_SOURCE_BYTES,timeout=2700):
        self.session.assert_live()
        try:
            return await run_owned_process_async(argv,input_bytes=json.dumps(body,separators=(',',':'),allow_nan=False).encode(),
                env=_environment(),timeout_seconds=min(timeout,self.session.remaining_seconds),max_file_bytes=maximum,
                on_start=self.session.on_process_start,cancel_event=self.session.cancel_event)
        except MediaProcessError as error:
            if error.code in {'media_process_start_unconfirmed','media_execution_cancelled'}:
                raise ExecutionControlError('execution_start_unconfirmed' if error.code=='media_process_start_unconfirmed' else 'execution_authority_lost') from None
            raise SourceFetchFailure('source_download_failed',True) from None

    async def download(self,source,work):
        path=work/'original.bin'
        result=await self._run(list(self.download_executable) if self.download_executable is not None else [self.bun,str(self.source/'direct-source-cli.ts')],
            {'source':source,'outputPath':str(path.resolve()),'deadlineMs':max(1,int(min(2700,self.session.remaining_seconds)*1000))})
        if result.returncode:
            try:
                error=_json(result.stderr);code=error['errorCode']
                if code not in {'drive_token_expired','drive_file_unavailable','zoom_recording_unavailable','remote_media_too_large','remote_media_invalid_content_type','remote_url_unsafe','remote_fetch_timeout','source_download_failed','remote_download_failed','worker_invalid_payload'}:raise ValueError()
                raise SourceFetchFailure(code,error.get('retryable') is True)
            except (ValueError,KeyError):raise SourceFetchFailure('source_download_failed',True) from None
        facts=_json(result.stdout)
        if set(facts)!={'byteLength','contentType'} or type(facts['byteLength']) is not int or not 0<facts['byteLength']<=MAX_SOURCE_BYTES or path.is_symlink() or FileSnapshot.read(path).size!=facts['byteLength'] or not isinstance(facts['contentType'],str):
            raise SourceFetchFailure('source_download_failed',True)
        path.chmod(0o400)
        return path,facts['contentType']

    async def probe(self,path):
        result=await self._run([self.bun,str(self.source/'probe-cli.ts')],{'sourcePath':str(path.resolve())},timeout=60)
        if result.returncode:raise SourceFetchFailure('source_probe_failed',True)
        value=_json(result.stdout);_duration(value)
        if (type(value.get('hasAudio')) is not bool or type(value.get('hasVideo')) is not bool or not isinstance(value.get('sourceProbe'),dict)
                or not isinstance(value.get('facts'),dict) or not isinstance(value['facts'].get('audios'),list) or not isinstance(value['facts'].get('videos'),list)
                or bool(value['facts']['audios'])!=value['hasAudio'] or bool(value['facts']['videos'])!=value['hasVideo']):
            raise SourceFetchFailure('source_probe_failed',True)
        return value

    async def extract_audio(self,path,probe,work):
        output=work/'source-audio.m4a'
        if output.exists() or not probe['facts']['audios']:raise SourceFetchFailure('source_audio_video_mismatch')
        index=probe['facts']['audios'][0]['index']
        if type(index) is not int or not 0<=index<=1024:raise SourceFetchFailure('source_audio_video_mismatch')
        result=await self._run([self.bun,str(self.source/'source-audio-cli.ts')],{'sourcePath':str(path.resolve()),'outputPath':str(output.resolve()),
            'audioStreamIndex':index,'deadlineMs':max(1,int(min(2700,self.session.remaining_seconds)*1000))},2*1024**3)
        if result.returncode:raise SourceFetchFailure('source_audio_failed',True)
        value=_json(result.stdout)
        if set(value)!={'byteLength'} or output.is_symlink() or FileSnapshot.read(output).size!=value['byteLength']:raise SourceFetchFailure('source_audio_failed',True)
        output.chmod(0o400)
        return output

    async def hash(self,path):
        def measure():
            before=FileSnapshot.read(path)
            if not 0<before.size<=MAX_SOURCE_BYTES:raise SourceFetchFailure('remote_media_too_large')
            digest=hashlib.sha256()
            with path.open('rb') as stream:
                for chunk in iter(lambda:stream.read(4*1024*1024),b''):
                    self.session.assert_live();digest.update(chunk)
            if FileSnapshot.read(path)!=before:raise SourceFetchFailure('source_audio_video_mismatch')
            return before,digest.hexdigest()
        return await asyncio.to_thread(measure)


def source_manifest(command,probe,snapshot,sha):
    identity=MediaSource(command['mediaIdentity']['provider'],command['mediaIdentity']['mediaId'])
    if probe['probeVersion']!=command['probeVersion']:raise SourceFetchFailure('source_runtime_invalid')
    if probe['hasAudio']:
        return build_audio_manifest(source=identity,source_revision=command['sourceRevision'],audio_format_id='stream:'+str(probe['facts']['audios'][0]['index']),
            language=None,probe=probe,byte_length=snapshot.size,sha256=sha,toolchain_fingerprint=command['toolchainFingerprint'])
    return {'sourceRevision':command['sourceRevision'],'mediaIdentity':{'provider':identity.provider,'mediaId':identity.media_id},'audioTrack':None,
        'byteLength':snapshot.size,'sha256':sha,'durationSeconds':_duration(probe),'wholeSource':True,'audioStartTimeSec':None,
        'probeVersion':probe['probeVersion'],'toolchainFingerprint':command['toolchainFingerprint']}


async def publish_original(session,package,work,path,content_type,*,runtime,sink,completed=None):
    command=package.command;before=FileSnapshot.read(path);probe=await runtime.probe(path);snapshot,sha=await runtime.hash(path)
    if before!=snapshot or completed is not None and (completed.sha256!=sha or completed.byte_length!=snapshot.size):raise SourceFetchFailure('source_audio_video_mismatch')
    manifest=source_manifest(command,probe,snapshot,sha)
    output=next(value for value in package.outputs if value['role']=='source_video')
    if content_type not in output['contentTypes']:content_type='application/octet-stream'
    video=VerifiedSourceFile(path,manifest,probe,snapshot,content_type)
    existing=ExistingSourceAudio(command['existingSourceAudio']) if command['existingSourceAudio'] is not None else None
    if existing is not None:
        verify_source_audio_binding(existing,video)
        if existing.binding['projectId']!=command['projectId'] or existing.binding['toolchainFingerprint']!=command['toolchainFingerprint'] or existing.binding['probeVersion']!=command['probeVersion']:
            raise SourceFetchFailure('source_audio_video_mismatch')
        await sink.refresh_optional_probe()
    audio=existing
    if existing is None and command['audioPolicy']!='none' and probe['hasAudio']:
        audio_path=await runtime.extract_audio(path,probe,work);audio_before=FileSnapshot.read(audio_path);audio_probe=await runtime.probe(audio_path);audio_snapshot,audio_sha=await runtime.hash(audio_path)
        if audio_before!=audio_snapshot or not audio_probe['hasAudio']:raise SourceFetchFailure('source_audio_video_mismatch')
        # Track facts describe the selected upstream stream, not its AAC read object.
        audio_manifest={**manifest,'byteLength':audio_snapshot.size,'sha256':audio_sha,'durationSeconds':_duration(audio_probe),
            'audioStartTimeSec':audio_probe['facts']['audios'][0]['startTimeSec'] or 0}
        audio=VerifiedSourceFile(audio_path,audio_manifest,audio_probe,audio_snapshot,'audio/mp4')
        verify_source_audio_binding(audio,video)
        await sink.audio_ready(audio)
    elif existing is not None and not probe['hasAudio']:
        raise SourceFetchFailure('source_audio_video_mismatch')
    await sink.video_ready(video,audio,**({'completed':completed} if completed is not None else {}))


async def run_direct_source(session,package,work,*,bun_executable='bun',runtime=None,sink_class=ScopedSourceSink):
    package.assert_session(session);command=package.command
    if package.function_name!='fetch_source' or command.get('kind')!='direct_source' or command.get('audioPolicy') not in {'required','none','pending_pack'}:
        raise SourceFetchFailure('source_runtime_invalid')
    runtime=runtime if runtime is not None else NativeFileRuntime(session,bun_executable=bun_executable)
    sink=sink_class(session,package,work,bun_executable=bun_executable)
    path,mime=await runtime.download(command['source'],work)
    await publish_original(session,package,work,path,mime,runtime=runtime,sink=sink)
