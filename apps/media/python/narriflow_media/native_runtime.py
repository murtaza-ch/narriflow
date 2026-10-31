"""Assigned native operations. Client creation and invocation admission live elsewhere."""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import re
from typing import Sequence

from .artifacts import AssignedArtifacts
from .callback_delivery_runtime import run_callback_delivery
from .control import ExecutionControlError, ExecutorSession
from .generated_image_runtime import run_generated_image as execute_generated_image
from .publication_runtime import run_publication as execute_publication, validate_publication_package
from .fetch import FileSnapshot
from .multipart import TransferTransport
from .outbound_runtime import run_rss_probe
from .process import MediaProcessError, run_owned_process_async
from .transfer import MAX_BYTES, WorkPackage

MAX_PROBE_BYTES = 65536
MAX_NOTIFICATION_BYTES = 16 * 1024 * 1024


class NativeOperationFailure(RuntimeError):
    def __init__(self, code: str, retryable: bool = False):
        super().__init__(code)
        self.code, self.retryable = code, retryable


def _environment():
    value = {name: os.environ[name] for name in (
        'PATH','HOME','LANG','LC_ALL','LC_CTYPE','TMPDIR','TMP','TEMP','SSL_CERT_FILE','SSL_CERT_DIR','CURL_CA_BUNDLE',
        'OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS','ORT_INTRA_OP_NUM_THREADS','OPENCV_FOR_THREADS_NUM','OPENCV_FFMPEG_THREADS',
    ) if name in os.environ}
    for name in ('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'):
        value[name] = ''
    value['NO_PROXY'] = value['no_proxy'] = ''
    return value


def _json(data: bytes, maximum: int):
    if not 0 < len(data) <= maximum:
        raise NativeOperationFailure('native_result_invalid')
    def invalid(_): raise ValueError()
    try:
        return json.loads(data,parse_constant=invalid)
    except (ValueError,UnicodeError):
        raise NativeOperationFailure('native_result_invalid') from None


def _dump(value):
    try:
        return json.dumps(value,separators=(',',':'),sort_keys=True,ensure_ascii=False,allow_nan=False).encode()
    except (ValueError,TypeError):
        raise NativeOperationFailure('native_command_invalid') from None


def _integer(value, maximum, minimum=1):
    return type(value) is int and minimum <= value <= maximum


def _digest(value):
    return isinstance(value,str) and re.fullmatch(r'[a-f0-9]{64}',value) is not None


def _work(work: Path):
    if work.is_symlink() or not work.is_dir():
        raise NativeOperationFailure('native_scratch_invalid')
    return work.resolve()


def _file_facts(path: Path, session: ExecutorSession, maximum: int):
    if path.is_symlink():
        raise NativeOperationFailure('native_result_invalid')
    before=FileSnapshot.read(path)
    if not _integer(before.size,maximum):
        raise NativeOperationFailure('native_result_invalid')
    digest=hashlib.sha256()
    with path.open('rb') as source:
        while True:
            session.assert_live()
            chunk=source.read(1024*1024)
            if not chunk: break
            digest.update(chunk)
    if before != FileSnapshot.read(path):
        raise NativeOperationFailure('native_source_changed')
    return before.size,digest.hexdigest()


async def _execute(session, argv, body, timeout, file_limit):
    session.assert_live()
    try:
        return await run_owned_process_async(argv,input_bytes=body,timeout_seconds=min(timeout,session.remaining_seconds),
            kill_grace_seconds=5,max_file_bytes=file_limit,env=_environment(),
            on_start=session.on_process_start,cancel_event=session.cancel_event)
    except MediaProcessError as error:
        if error.code in {'media_process_start_unconfirmed','media_execution_cancelled'}:
            raise ExecutionControlError('execution_start_unconfirmed' if error.code=='media_process_start_unconfirmed' else 'execution_authority_lost') from None
        raise NativeOperationFailure('native_process_unavailable',True) from None


def _curl_quote(value: str):
    if not isinstance(value,str) or any(ord(char)<32 for char in value):
        raise NativeOperationFailure('native_source_invalid')
    return '"'+value.replace('\\','\\\\').replace('"','\\"')+'"'


def _source_headers(data: bytes):
    if len(data)>65536:
        raise NativeOperationFailure('native_source_invalid')
    # curl may emit an informational response before the final HTTP header.
    headers={}
    for line in data.decode('latin-1').splitlines():
        if line.startswith('HTTP/'):
            headers={}
        elif ':' in line:
            name,value=line.split(':',1);headers[name.lower()]=value.strip()
    return headers


async def download_assigned_source(session: ExecutorSession, package: WorkPackage, work: Path, *,
                                   source_name: str, maximum_bytes: int, curl_executable: str='curl',
                                   range_end: int|None=None) -> Path:
    """Only a source in the verified work package can become a curl request."""
    package.assert_session(session)
    sources=[source for source in package.sources if source['name']==source_name]
    if len(sources)!=1 or not _integer(maximum_bytes,MAX_BYTES) or not _integer(sources[0]['byteLength'],MAX_BYTES):
        raise NativeOperationFailure('native_source_invalid')
    frozen=sources[0];source=dict(frozen);directory=_work(work)
    if range_end is not None:
        if not _integer(range_end,min(16*1024*1024,maximum_bytes,frozen['byteLength'])):
            raise NativeOperationFailure('native_source_invalid')
    elif frozen['byteLength']>maximum_bytes or not _digest(frozen.get('sha256')):
        raise NativeOperationFailure('native_source_invalid')
    expected_bytes=frozen['byteLength'] if range_end is None else range_end
    expected_status=b'200' if range_end is None else b'206'
    destination=directory/'source.bin';header_path=directory/'source.headers'
    if destination.exists() or header_path.exists():
        raise NativeOperationFailure('native_scratch_invalid')
    for attempt in range(3):
        session.assert_live()
        headers={name.lower():value for name,value in source['headers'].items()}
        if headers.get('if-match',frozen['etag'])!=frozen['etag']:
            raise NativeOperationFailure('native_source_invalid')
        headers['if-match']=frozen['etag'];headers['accept-encoding']='identity'
        if range_end is not None:
            expected_range=f'bytes=0-{range_end-1}'
            if headers.get('range',expected_range)!=expected_range:raise NativeOperationFailure('native_source_invalid')
            headers['range']=expected_range
        elif 'range' in headers:
            raise NativeOperationFailure('native_source_invalid')
        remaining=session.remaining_seconds
        options={'url':source['url'],'request':'GET','output':str(destination),'dump-header':str(header_path),
            'proto':'=https','proto-redir':'=https','max-redirs':'0','connect-timeout':'10','max-time':f'{remaining:.3f}',
            'speed-time':'30','speed-limit':'1','max-filesize':str(expected_bytes),'write-out':'%{http_code}'}
        config='silent\nshow-error\nfail\ngloboff\n'+''.join(name+' = '+_curl_quote(value)+'\n' for name,value in options.items())
        config+=''.join('header = '+_curl_quote(name+': '+value)+'\n' for name,value in headers.items())
        # --disable is first, so neither ~/.curlrc nor environment proxies can
        # alter the frozen request. Work details remain off the process argv.
        result=await _execute(session,[curl_executable,'--disable','--config','-'],config.encode(),remaining,maximum_bytes)
        status=result.stdout.strip()
        if result.returncode==0 and status==expected_status:
            with header_path.open('rb') as header_file:
                response=_source_headers(header_file.read(65537))
            if response.get('etag')!=frozen['etag'] or response.get('content-length')!=str(expected_bytes) or range_end is not None and response.get('content-range')!=f'bytes 0-{range_end-1}/{frozen["byteLength"]}':
                raise NativeOperationFailure('native_source_changed')
            size,sha=await asyncio.to_thread(_file_facts,destination,session,maximum_bytes)
            if size!=expected_bytes or (range_end is None or expected_bytes==frozen['byteLength']) and 'sha256' in frozen and sha!=frozen['sha256']:
                raise NativeOperationFailure('native_source_changed')
            destination.chmod(0o400)
            return destination
        if status==b'412' or result.returncode in {23,63,73}:
            raise NativeOperationFailure('native_source_changed')
        if attempt==2 or status not in {b'000',b'403',b'408',b'429',b'500',b'502',b'503',b'504'}:
            raise NativeOperationFailure('native_source_unavailable',True)
        destination.unlink(missing_ok=True);header_path.unlink(missing_ok=True)
        fresh=(await asyncio.to_thread(session.transfer,'source-read',sourceId=source_name)).disposition
        if fresh['object']!={name:frozen[name] for name in ('storageKey','etag','byteLength','sha256') if name in frozen}:
            raise NativeOperationFailure('native_source_changed')
        source={**frozen,**fresh['grant']}
    raise NativeOperationFailure('native_source_unavailable',True)


def _outputs(package: WorkPackage, roles: set[str]):
    result={}
    for output in package.outputs:
        if output['role'] in result or output['role'] not in roles or output['bindingHash']!=package.input_hash:
            raise NativeOperationFailure('native_assignment_invalid')
        result[output['role']]=output
    if set(result)!=roles:
        raise NativeOperationFailure('native_assignment_invalid')
    return result


def _asset_command(command):
    if (not isinstance(command,dict) or command.get('kind') not in {'font','visual','thumbnail'} or
            set(command)!={'kind','expected'}|({'sourceTimeMs'} if command['kind']=='thumbnail' else set())):
        raise NativeOperationFailure('native_command_invalid')
    expected=command['expected']
    if (not isinstance(expected,dict) or set(expected)!={'contentType','byteLength','sha256'} or
            not isinstance(expected['contentType'],str) or not _digest(expected['sha256'])):
        raise NativeOperationFailure('native_command_invalid')
    kind=command['kind'];limit=20*1024**2 if kind=='font' else 2*1024**3 if kind=='visual' else MAX_BYTES
    allowed={'font':{'font/ttf','font/otf','font/woff2','application/font-sfnt'},
        'visual':{'image/png','image/jpeg','image/webp','video/mp4','video/quicktime'},'thumbnail':{'video/mp4'}}
    if (not _integer(expected['byteLength'],limit) or expected['contentType'] not in allowed[kind]
            or kind=='thumbnail' and not _integer(command['sourceTimeMs'],86400000,0)):
        raise NativeOperationFailure('native_command_invalid')
    return kind,limit


def _evidence(value, kind, expected, size, sha):
    common={'kind','sha256','byteLength'}
    fields={'font':{'format','family','style','weight','face'},'visual':{'contentType','mediaKind','width','height','durationSec'},
        'thumbnail':{'contentType','mediaKind','width','height','durationSec'}}
    valid=isinstance(value,dict) and set(value)==common|fields[kind] and value.get('kind')==kind and value.get('sha256')==sha and value.get('byteLength')==size
    if not valid:raise NativeOperationFailure('native_result_invalid')
    if kind=='font':
        face=value['face'];formats={'font/ttf':'ttf','application/font-sfnt':'ttf','font/otf':'otf','font/woff2':'woff2'}
        if (value['format']!=formats[expected['contentType']] or not isinstance(value['family'],str) or not 1<=len(value['family'])<=120
                or not isinstance(value['style'],str) or not 1<=len(value['style'])<=80 or not _integer(value['weight'],900,100)
                or not isinstance(face,dict) or set(face)!={'name','file','assName','weight','style','ascent','descent','capHeight'}
                or face['file']!='' or not isinstance(face['name'],str) or not 1<=len(face['name'])<=120
                or not isinstance(face['assName'],str) or not 1<=len(face['assName'])<=256 or re.search(r'[,\\{}\r\n]',face['assName'])
                or not _integer(face['weight'],900,100) or face['style'] not in {'normal','italic'}
                or any(type(face[name]) not in {int,float} or not math.isfinite(face[name]) or not 0<=face[name]<=10 for name in ['ascent','descent','capHeight'])
                or face['ascent']+face['descent']<=0):raise NativeOperationFailure('native_result_invalid')
    else:
        if (not _integer(value['width'],16384) or not _integer(value['height'],16384) or value['width']*value['height']>40000000
                or value['mediaKind'] not in {'image','video'}):raise NativeOperationFailure('native_result_invalid')
        duration=value['durationSec'];mime=value['contentType']
        if (value['mediaKind']=='image' and (duration is not None or mime not in {'image/png','image/jpeg','image/webp'})
                or value['mediaKind']=='video' and (type(duration) not in {int,float} or not math.isfinite(duration) or not 0<duration<=86400 or mime not in {'video/mp4','video/quicktime'})
                or mime!=('image/jpeg' if kind=='thumbnail' else expected['contentType'])):raise NativeOperationFailure('native_result_invalid')
    if kind!='thumbnail' and (sha!=expected['sha256'] or size!=expected['byteLength']):raise NativeOperationFailure('native_result_invalid')
    return value


async def run_asset_validation(session: ExecutorSession, package: WorkPackage, work: Path, *,
                               transport: TransferTransport | None=None, curl_executable: str='curl',
                               executable: Sequence[str] | None=None) -> None:
    package.assert_session(session)
    if package.function_name!='asset_validation':raise NativeOperationFailure('native_command_invalid')
    command=package.command;kind,input_limit=_asset_command(command);directory=_work(work)
    binary_role={'font':'validated_font','visual':'validated_asset','thumbnail':'thumbnail'}[kind]
    outputs=_outputs(package,{binary_role,'probe'})
    if outputs['probe']['contentType']!='application/json' or outputs['probe']['maxBytes']>MAX_PROBE_BYTES:
        raise NativeOperationFailure('native_assignment_invalid')
    expected_mime='image/jpeg' if kind=='thumbnail' else command['expected']['contentType']
    if expected_mime not in outputs[binary_role]['contentTypes'] or (kind!='thumbnail' and outputs[binary_role]['maxBytes']<command['expected']['byteLength']):
        raise NativeOperationFailure('native_assignment_invalid')
    source=next((value for value in package.sources if value['name']=='asset_source'),None)
    if source is None or source['byteLength']!=command['expected']['byteLength'] or source.get('sha256')!=command['expected']['sha256']:
        raise NativeOperationFailure('native_source_invalid')
    source_path=await download_assigned_source(session,package,directory,source_name='asset_source',maximum_bytes=input_limit,curl_executable=curl_executable)
    output_path=directory/'validated.bin';probe_path=directory/'probe.json'
    if output_path.exists() or probe_path.exists():raise NativeOperationFailure('native_scratch_invalid')
    body=_dump({**command,'sourcePath':str(source_path),'outputPath':str(output_path)})
    argv=list(executable) if executable is not None else ['bun',str(Path(__file__).resolve().parents[2]/'src/asset-validation-cli.ts')]
    file_limit=20*1024**2 if kind in {'font','thumbnail'} else 2*1024**3
    result=await _execute(session,argv,body,90,file_limit)
    if result.returncode:
        code='native_validation_failed';retryable=False
        for line in reversed(result.stderr.splitlines()):
            try:
                details=json.loads(line);candidate=details.get('errorCode')
                if isinstance(candidate,str) and re.fullmatch(r'(?:brand_font|visual_asset|asset_validation)_[a-z_]{1,80}',candidate):
                    code=candidate;retryable=details.get('retryable') is True;break
            except (ValueError,AttributeError):pass
        raise NativeOperationFailure(code,retryable)
    size,sha=await asyncio.to_thread(_file_facts,output_path,session,file_limit)
    evidence=_evidence(_json(result.stdout,MAX_PROBE_BYTES),kind,command['expected'],size,sha)
    proof=_dump(evidence)
    if len(proof)>min(MAX_PROBE_BYTES,outputs['probe']['maxBytes']):raise NativeOperationFailure('native_result_invalid')
    with probe_path.open('xb') as output:output.write(proof)
    output_path.chmod(0o400);probe_path.chmod(0o400)
    content_type=command['expected']['contentType'] if kind=='font' else evidence['contentType']
    artifacts=AssignedArtifacts(session,package)
    await artifacts.upload(outputs[binary_role]['artifactId'],output_path,content_type=content_type,byte_length=size,sha256=sha,transport=transport)
    await artifacts.upload(outputs['probe']['artifactId'],probe_path,content_type='application/json',byte_length=len(proof),sha256=hashlib.sha256(proof).hexdigest(),transport=transport)


async def run_outbound_delivery(session: ExecutorSession, package: WorkPackage, work: Path, *,
                                transport: TransferTransport | None=None, bun_executable: str='bun',
                                curl_executable: str='curl') -> None:
    package.assert_session(session)
    command=package.command
    if package.function_name!='outbound_delivery' or not isinstance(command,dict) or command.get('kind') not in {'rss_feed','signed_notification'}:
        raise NativeOperationFailure('native_command_invalid')
    outputs=_outputs(package,{'outbound_receipt'});output=outputs['outbound_receipt']
    notification=command['kind']=='signed_notification'
    maximum=MAX_PROBE_BYTES if notification else 4*1024**2
    if output['contentType']!='application/json' or output['maxBytes']>maximum:
        raise NativeOperationFailure('native_assignment_invalid')
    directory=_work(work)
    try:
        if notification:
            body=command.get('body');sources=package.sources
            if (not isinstance(body,dict) or set(body)!={'source','sha256','byteLength'} or body['source']!='notification_body'
                    or len(sources)!=1 or sources[0]['name']!='notification_body'
                    or sources[0].get('sha256')!=body['sha256'] or sources[0]['byteLength']!=body['byteLength']):
                raise NativeOperationFailure('native_source_invalid')
            source=await download_assigned_source(session,package,directory,source_name='notification_body',
                maximum_bytes=MAX_NOTIFICATION_BYTES,curl_executable=curl_executable)
            path=await run_callback_delivery(command,source,directory,on_process_start=session.on_process_start,
                cancel_event=session.cancel_event,bun_executable=bun_executable)
        else:
            if package.sources:raise NativeOperationFailure('native_assignment_invalid')
            path=await run_rss_probe(command,directory,on_process_start=session.on_process_start,
                cancel_event=session.cancel_event,bun_executable=bun_executable)
    except MediaProcessError as error:
        if error.code in {'media_process_start_unconfirmed','media_execution_cancelled'}:
            raise ExecutionControlError('execution_start_unconfirmed' if error.code=='media_process_start_unconfirmed' else 'execution_authority_lost') from None
        raise
    size,sha=await asyncio.to_thread(_file_facts,path,session,maximum)
    path.chmod(0o400)
    await AssignedArtifacts(session,package).upload(output['artifactId'],path,content_type='application/json',byte_length=size,sha256=sha,transport=transport)


async def run_generated_image(session: ExecutorSession, package: WorkPackage, work: Path, *,
                              api_key: str | None = None, transport: TransferTransport | None = None,
                              bun_executable: str = 'bun', curl_executable: str = 'curl') -> None:
    """One provider POST or exact recovery; SQL remains the publication authority."""
    package.assert_session(session)
    command = package.command
    if (package.function_name != 'generated_image' or not isinstance(command, dict) or
            command.get('kind') != 'generated_image' or command.get('mode') not in {'generate', 'recover'} or
            not _integer(command.get('maxOutputBytes'), 100000000, 1000000)):
        raise NativeOperationFailure('native_command_invalid')
    outputs = _outputs(package, {'validated_asset', 'probe'})
    binary, proof = outputs['validated_asset'], outputs['probe']
    if (binary['contentType'] != 'image/png' or binary['contentTypes'] != ['image/png'] or
            binary['maxBytes'] != command['maxOutputBytes'] or proof['contentType'] != 'application/json' or
            proof['maxBytes'] > MAX_PROBE_BYTES):
        raise NativeOperationFailure('native_assignment_invalid')
    directory = _work(work)
    source_path = None
    if command['mode'] == 'recover':
        expected = command.get('expected')
        if (not isinstance(expected, dict) or set(expected) != {'contentType', 'byteLength', 'sha256'} or
                expected['contentType'] != 'image/png' or len(package.sources) != 1 or
                package.sources[0]['name'] != 'generated_result' or
                package.sources[0].get('sha256') != expected['sha256'] or
                package.sources[0]['byteLength'] != expected['byteLength']):
            raise NativeOperationFailure('native_source_invalid')
        source_path = await download_assigned_source(session, package, directory,
            source_name='generated_result', maximum_bytes=command['maxOutputBytes'], curl_executable=curl_executable)
    elif package.sources:
        raise NativeOperationFailure('native_source_invalid')
    try:
        files = await execute_generated_image(command, directory, binary_artifact_id=binary['artifactId'],
            on_process_start=session.on_process_start, cancel_event=session.cancel_event,
            api_key=api_key if command['mode'] == 'generate' else None, source_path=source_path,
            bun_executable=bun_executable)
    except MediaProcessError as error:
        if error.code in {'media_process_start_unconfirmed', 'media_execution_cancelled'}:
            raise ExecutionControlError('execution_start_unconfirmed' if error.code == 'media_process_start_unconfirmed' else 'execution_authority_lost') from None
        raise
    proof_size, proof_sha = await asyncio.to_thread(_file_facts, files.evidence_path, session, MAX_PROBE_BYTES)
    artifacts = AssignedArtifacts(session, package)
    # The probe freezes the accepted provider reference and binary fingerprint
    # before any binary publication can be acknowledged. Lost upload ACKs can
    # then recover this exact assigned object without another provider POST.
    await artifacts.upload(proof['artifactId'], files.evidence_path, content_type='application/json',
        byte_length=proof_size, sha256=proof_sha, transport=transport)
    if files.image_path is None:
        return
    size, sha = await asyncio.to_thread(_file_facts, files.image_path, session, command['maxOutputBytes'])
    image = files.evidence.get('image')
    if (not isinstance(image, dict) or image.get('kind') != 'visual' or image.get('mediaKind') != 'image' or
            image.get('contentType') != 'image/png' or image.get('sha256') != sha or image.get('byteLength') != size):
        raise NativeOperationFailure('native_result_invalid')
    await artifacts.upload(binary['artifactId'], files.image_path, content_type='image/png',
        byte_length=size, sha256=sha, transport=transport)


async def run_publication(session: ExecutorSession, package: WorkPackage, work: Path, *,
                          transport: TransferTransport | None = None, bun_executable: str = 'bun',
                          curl_executable: str = 'curl') -> None:
    """Exact named sources only. Python keeps control and assignment custody;
    the bounded Bun process performs the frozen provider protocol."""
    validate_publication_package(session, package)
    names = [source['name'] for source in package.sources]
    if ('publication_media' not in names or len(names) != len(set(names)) or
            set(names) - {'publication_media', 'publication_thumbnail', 'publication_instructions'}):
        raise NativeOperationFailure('publication_source_invalid')
    context = package.publication
    if (('publication_instructions' in names) != ('priorCheckpointKey' in context) or
            ('publication_thumbnail' in names) != ('thumbnail' in context)):
        raise NativeOperationFailure('publication_source_invalid')
    directory = _work(work)
    paths = {}
    for name, maximum in (('publication_media', MAX_BYTES), ('publication_thumbnail', 2 * 1024**3),
                           ('publication_instructions', 16 * 1024**2)):
        if name not in names:
            continue
        source_directory = directory / name
        source_directory.mkdir(mode=0o700)
        paths[name] = await download_assigned_source(session, package, source_directory,
            source_name=name, maximum_bytes=maximum, curl_executable=curl_executable)
    try:
        await execute_publication(session, package, directory, media_path=paths['publication_media'],
            thumbnail_path=paths.get('publication_thumbnail'), instructions_path=paths.get('publication_instructions'),
            bun_executable=bun_executable, upload_transport=transport)
    except MediaProcessError as error:
        if error.code in {'media_process_start_unconfirmed', 'media_execution_cancelled'}:
            raise ExecutionControlError('execution_start_unconfirmed' if error.code == 'media_process_start_unconfirmed' else 'execution_authority_lost') from None
        raise
