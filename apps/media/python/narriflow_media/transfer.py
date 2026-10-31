"""The fixed signed transfer protocol and native multipart adapter.

Executors send assigned identifiers and measured checksums. Storage keys,
provider upload IDs and part inventories never go back across this boundary.
"""
from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass, field
import hashlib
import json
import re
import time
from urllib.parse import urlsplit
from uuid import UUID

from .control import ExecutionControlError, ExecutorSession, _instant
from .multipart import (CompletedObject, MultipartDestination, MultipartTransferError,
                        PART_SIZE_BYTES, SignedGrant, SignedHttpTransport)

TARGET = '/api/execution/transfer'
MAX_BYTES = 10 * 1024**3
SHA = re.compile(r'[a-f0-9]{64}')
MIME = re.compile(r'[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*')
ROLES = {'source_audio', 'source_video', 'layout_evidence', 'render_variant', 'render_outcome', 'clip_preview', 'preview_peaks', 'probe', 'thumbnail',
         'export_bundle', 'dub_mix', 'validated_font', 'validated_asset', 'outbound_receipt', 'publication_checkpoint'}
FUNCTIONS = {'fetch_source', 'pin_source', 'prepare_clip', 'render_group', 'probe_extract', 'thumbnail',
             'export_bundle', 'dub_mix', 'outbound_delivery', 'asset_validation', 'generated_image', 'publication'}


def _invalid():
    raise ExecutionControlError('execution_transfer_invalid')


def _object(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= set(value) <= set(required) | set(optional):
        _invalid()
    return value


def _text(value, maximum, pattern=None):
    if not isinstance(value, str) or not 0 < len(value) <= maximum or pattern and re.fullmatch(pattern, value) is None:
        _invalid()
    return value


def _integer(value, maximum, minimum=1):
    if type(value) is not int or not minimum <= value <= maximum:
        _invalid()
    return value


def _id(value):
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            _invalid()
    except ValueError:
        _invalid()
    return value


def _digest(value, length):
    try:
        if not isinstance(value, str) or len(base64.b64decode(value, validate=True)) != length or base64.b64encode(base64.b64decode(value)).decode() != value:
            _invalid()
    except ValueError:
        _invalid()


def _grant(value, *, additional=()):
    _object(value, {'url', 'headers', 'expiresAt', *additional})
    try:
        parsed = urlsplit(_text(value['url'], 8192))
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None or parsed.password is not None
                or parsed.fragment or parsed.port is not None and not 0 < parsed.port <= 65535
                or any(ord(c) <= 32 for c in value['url'])):
            _invalid()
    except ValueError:
        _invalid()
    headers = value['headers']
    if not isinstance(headers, dict) or len(headers) > 64:
        _invalid()
    for name, content in headers.items():
        _text(name, 128, r"[!#$%&'*+.^_`|~0-9A-Za-z-]+")
        if not isinstance(content, str) or len(content) > 1024 or re.search(r'[\r\n\x00]', content):
            _invalid()
    _instant(value['expiresAt'])


def _storage_object(value, *, completed=False):
    key = 'key' if completed else 'storageKey'
    _object(value, {key, 'etag', 'byteLength'} | ({'sha256', 'contentType'} if completed else set()), () if completed else {'sha256'})
    _text(value[key], 1024)
    _text(value['etag'], 160, r'[\x21-\x7e]+')
    _integer(value['byteLength'], MAX_BYTES)
    if 'sha256' in value:
        _text(value['sha256'], 64, SHA)
    if completed:
        _text(value['contentType'], 128, MIME)


def validate_transfer_command(command):
    action = command.get('action') if isinstance(command, dict) else None
    fields = {'work-package': set(), 'source-read': {'sourceId'}, 'upload-initialize': {'artifactId', 'byteLength', 'contentType'},
        'upload-parts': {'artifactId', 'parts'}, 'source-range': {'artifactId', 'partNumber'},
        'upload-complete': {'artifactId', 'byteLength', 'sha256'}, 'upload-abort': {'artifactId'}}
    if not isinstance(action, str) or action not in fields:
        _invalid()
    _object(command, {'action', 'fence'} | fields[action])
    if 'artifactId' in command:
        _id(command['artifactId'])
    if 'byteLength' in command:
        _integer(command['byteLength'], MAX_BYTES)
    if 'contentType' in command:
        _text(command['contentType'], 128, MIME)
    if 'sha256' in command:
        _text(command['sha256'], 64, SHA)
    if 'sourceId' in command:
        _text(command['sourceId'], 160, r'[a-z][a-z0-9_]{0,159}')
    if 'partNumber' in command:
        _integer(command['partNumber'], 640)
    if 'parts' in command:
        parts = command['parts']
        if not isinstance(parts, list) or not 1 <= len(parts) <= 16:
            _invalid()
        numbers = set()
        for part in parts:
            _object(part, {'partNumber', 'byteLength', 'checksumMd5', 'checksumSha256'})
            number = _integer(part['partNumber'], 640)
            if number in numbers:
                _invalid()
            numbers.add(number)
            _integer(part['byteLength'], PART_SIZE_BYTES)
            _digest(part['checksumMd5'], 16)
            _digest(part['checksumSha256'], 32)


def parse_transfer_disposition(value):
    kind = value.get('disposition') if isinstance(value, dict) else None
    fields = {'work_package': {'functionName', 'inputHash', 'input', 'sources', 'outputs'},
        'source_read': {'sourceId', 'grant', 'object'}, 'upload_ready': {'artifactId', 'uploadId', 'byteLength', 'partSizeBytes', 'partCount'},
        'upload_parts': {'artifactId', 'grants'}, 'source_range': {'artifactId', 'partNumber', 'grant'},
        'upload_completed': {'artifactId', 'object'}, 'upload_aborted': {'artifactId'}}
    if not isinstance(kind, str) or kind not in fields:
        _invalid()
    _object(value, {'disposition'} | fields[kind], {'publication'} if kind=='work_package' else ())
    if 'artifactId' in value:
        _id(value['artifactId'])
    if kind == 'upload_ready':
        _text(value['uploadId'], 2048)
        _integer(value['byteLength'], MAX_BYTES)
        if value['partSizeBytes'] != PART_SIZE_BYTES or value['partCount'] != (value['byteLength']+PART_SIZE_BYTES-1)//PART_SIZE_BYTES:
            _invalid()
    elif kind == 'upload_parts':
        if not isinstance(value['grants'], list) or not 1 <= len(value['grants']) <= 16:
            _invalid()
        numbers = set()
        for grant in value['grants']:
            _grant(grant, additional={'partNumber'})
            number = _integer(grant['partNumber'], 640)
            if number in numbers:
                _invalid()
            numbers.add(number)
    elif kind == 'source_range':
        _integer(value['partNumber'], 640)
        _grant(value['grant'])
    elif kind == 'source_read':
        _text(value['sourceId'], 160, r'[a-z][a-z0-9_]{0,159}')
        _grant(value['grant'])
        _storage_object(value['object'])
    elif kind == 'upload_completed':
        _storage_object(value['object'], completed=True)
    elif kind == 'work_package':
        # The native dispatch layer owns function-specific immutable schemas.
        if _text(value['functionName'], 80) not in FUNCTIONS:
            _invalid()
        if (value['functionName']=='publication') != ('publication' in value):_invalid()
        if 'publication' in value:
            publication=value['publication']
            _object(publication,{'version','inputKey','checkpointKey','account'},{'priorCheckpointKey','media','thumbnail','webhook'})
            if publication['version']!=1 or len(json.dumps(publication,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode())>32*1024:_invalid()
            for name in ('inputKey','checkpointKey','priorCheckpointKey'):
                if name not in publication:continue
                material=publication[name]
                _object(material,{'key','scope'}|({'artifactId'} if name=='priorCheckpointKey' else set()))
                _text(material['key'],43,r'[A-Za-z0-9_-]{43}')
                if base64.urlsafe_b64encode(base64.urlsafe_b64decode(material['key']+'=')).decode().rstrip('=')!=material['key']:_invalid()
                scope=_object(material['scope'],{'deploymentEpoch','socialPostId','attemptId','claimId','bindingHash'})
                _integer(scope['deploymentEpoch'],2147483647);_text(scope['bindingHash'],64,SHA)
                for field in ('socialPostId','attemptId','claimId'):_id(scope[field])
                if name=='priorCheckpointKey':_id(material['artifactId'])
            if 'webhook' in publication:
                hook=_object(publication['webhook'],{'receiverUrl','bodySha256','signature','deadlineMs','maxResponseBytes','reconciliationMaxMs'})
                _text(hook['bodySha256'],64,SHA);_text(hook['signature'],71,r'sha256=[a-f0-9]{64}')
                _integer(hook['deadlineMs'],60000,1000);_integer(hook['maxResponseBytes'],1048576,1024);_integer(hook['reconciliationMaxMs'],7*86400000,60000)
                if 'media' not in publication:_invalid()
                _grant({'url':hook['receiverUrl'],'headers':{},'expiresAt':publication['media']['expiresAt']})
            for name in ('media','thumbnail'):
                if name in publication:
                    pull=_object(publication[name],{'url','expiresAt'}|({'contentType'} if name=='thumbnail' else set()))
                    if name=='thumbnail' and pull['contentType'] not in {'image/png','image/jpeg','image/webp'}:_invalid()
                    _grant({'url':pull['url'],'headers':{},'expiresAt':pull['expiresAt']})
            account=publication['account']
            if account is not None:
                _object(account,{'id','userId','platform','providerAccountId','displayName','handle','accessToken','scopes','metadata'})
                _id(account['id']);_id(account['userId'])
                if account['platform'] not in {'youtube_shorts','instagram_reels','facebook_reels','tiktok','linkedin','x'}:_invalid()
                metadata=account['metadata']
                if metadata is not None:
                    _object(metadata,set(),{'ownerUrn','igUserId','auditEnforcedPrivate','forcePrivateUploads'})
                    for name in ('ownerUrn','igUserId'):
                        if name in metadata and (not isinstance(metadata[name],str) or len(metadata[name])>2048):_invalid()
                    for name in ('auditEnforcedPrivate','forcePrivateUploads'):
                        if name in metadata and type(metadata[name]) is not bool:_invalid()
                _text(account['providerAccountId'],2048);_text(account['accessToken'],16384)
                if not isinstance(account['displayName'],str) or len(account['displayName'])>512 or account['handle'] is not None and (not isinstance(account['handle'],str) or len(account['handle'])>512):_invalid()
                if not isinstance(account['scopes'],list) or len(account['scopes'])>100:_invalid()
                for scope in account['scopes']:
                    if not isinstance(scope,str) or len(scope)>512:_invalid()
        _text(value['inputHash'], 64, SHA)
        source = value['input']
        if not isinstance(source, dict):
            _invalid()
        if source.get('kind') == 'inline':
            _object(source, {'kind', 'command'})
            if len(json.dumps(source['command'], separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()) > 32*1024:
                _invalid()
        elif source.get('kind') == 'object':
            _grant(source, additional={'kind', 'storageKey', 'etag', 'byteLength', 'sha256'})
            _text(source['storageKey'], 1024)
            _text(source['etag'], 160, r'[\x21-\x7e]+')
            _integer(source['byteLength'], PART_SIZE_BYTES)
            _text(source['sha256'], 64, SHA)
        else:
            _invalid()
        if not isinstance(value['sources'], list) or len(value['sources']) > 16 or not isinstance(value['outputs'], list) or len(value['outputs']) > 16:
            _invalid()
        names, ids = set(), set()
        for source in value['sources']:
            _object(source, {'name', 'storageKey', 'etag', 'byteLength', 'url', 'headers', 'expiresAt'}, {'sha256'})
            _grant({key: source[key] for key in ['url','headers','expiresAt']})
            _storage_object({key: source[key] for key in ['storageKey','etag','byteLength','sha256'] if key in source})
            name = _text(source['name'], 160, r'[a-z][a-z0-9_]{0,159}')
            if name in names:
                _invalid()
            names.add(name)
        for output in value['outputs']:
            _object(output, {'artifactId','role','bindingHash','maxBytes','contentType','contentTypes'}, {'sourceEtag','sourceByteLength'})
            identity = _id(output['artifactId'])
            if identity in ids or _text(output['role'], 80) not in ROLES:
                _invalid()
            ids.add(identity)
            _text(output['bindingHash'], 64, SHA)
            _integer(output['maxBytes'], MAX_BYTES)
            _text(output['contentType'], 128, MIME)
            if not isinstance(output['contentTypes'], list) or not 1 <= len(output['contentTypes']) <= 16:
                _invalid()
            for mime in output['contentTypes']:
                _text(mime, 128, MIME)
            if ('sourceEtag' in output) != ('sourceByteLength' in output):
                _invalid()
            if 'sourceEtag' in output:
                _text(output['sourceEtag'], 160, r'[\x21-\x7e]+')
                _integer(output['sourceByteLength'], MAX_BYTES)
    return value


def check_transfer_response(command, result):
    value = result.disposition
    expected = {'work-package':'work_package', 'source-read':'source_read', 'upload-initialize':'upload_ready',
        'upload-parts':'upload_parts', 'source-range':'source_range', 'upload-complete':'upload_completed', 'upload-abort':'upload_aborted'}
    if value['disposition'] != expected[command['action']]:
        _invalid()
    for name in ('artifactId', 'sourceId', 'partNumber', 'byteLength'):
        if name in command and name in value and command[name] != value[name]:
            _invalid()
    if command['action'] == 'upload-complete' and any(command[name] != value['object'][name] for name in ('byteLength','sha256')):
        _invalid()
    if command['action'] == 'upload-parts' and {part['partNumber'] for part in command['parts']} != {grant['partNumber'] for grant in value['grants']}:
        _invalid()
    grants = ([value['grant']] if 'grant' in value else value.get('grants', []))
    if value['disposition'] == 'work_package':
        grants = value['sources'] + ([value['input']] if value['input']['kind'] == 'object' else [])
    upper = result.server_time_upper + max(0, time.monotonic()-result.received_monotonic)
    if any(_instant(grant['expiresAt']) <= upper+1 for grant in grants):
        raise ExecutionControlError('execution_grant_expired')


@dataclass(frozen=True)
class WorkPackage:
    function_name: str
    input_hash: str
    _command_wire: bytes = field(repr=False)
    _sources_wire: bytes = field(repr=False)
    _outputs_wire: bytes = field(repr=False)
    _fence_wire: bytes = field(repr=False)
    _publication_wire: bytes | None = field(default=None,repr=False)

    @property
    def publication(self):
        return json.loads(self._publication_wire) if self._publication_wire is not None else None

    @property
    def command(self):
        return json.loads(self._command_wire)

    @property
    def sources(self):
        return tuple(json.loads(self._sources_wire))

    @property
    def outputs(self):
        return tuple(json.loads(self._outputs_wire))

    def assert_session(self, session: ExecutorSession):
        if self._fence_wire != _wire(session.fence):
            raise ExecutionControlError('execution_work_package_mismatch')


def _wire(value):
    return json.dumps(value, separators=(',', ':'), sort_keys=True, ensure_ascii=False, allow_nan=False).encode()


async def load_work_package(session: ExecutorSession, *, transport=None) -> WorkPackage:
    """Load only the input assigned by a freshly signed work-package response."""
    storage = transport if transport is not None else SignedHttpTransport()
    for attempt in range(3):
        try:
            value = (await asyncio.to_thread(session.transfer, 'work-package')).disposition
        except ExecutionControlError as error:
            if error.code == 'execution_grant_expired' and attempt < 2:
                continue
            raise
        if value['inputHash'] != session.fence['reference'].get('inputHash'):
            raise ExecutionControlError('execution_input_changed')
        source = value['input']
        if source['kind'] == 'inline':
            command = source['command']
        else:
            try:
                response = await storage.request(SignedGrant(source['url'], source['headers']), 'GET', None,
                    {'If-Match':source['etag']}, PART_SIZE_BYTES, session.cancel_event.is_set)
            except MultipartTransferError as error:
                if error.code == 'multipart_transport_failed' and attempt < 2:
                    continue
                raise ExecutionControlError('execution_input_unavailable') from None
            session.assert_live()
            if response.status in {403, 408, 429, 500, 502, 503, 504} and attempt < 2:
                continue
            headers = {name.lower():content for name,content in response.headers.items()}
            if (response.status != 200 or headers.get('etag') != source['etag']
                    or headers.get('content-length') != str(source['byteLength'])
                    or len(response.body) != source['byteLength']
                    or hashlib.sha256(response.body).hexdigest() != source['sha256']):
                raise ExecutionControlError('execution_input_changed')
            def invalid_constant(_):
                raise ValueError()
            try:
                command = json.loads(bytes(response.body), parse_constant=invalid_constant)
            except (ValueError, UnicodeError):
                raise ExecutionControlError('execution_input_invalid') from None
        return WorkPackage(value['functionName'], value['inputHash'], _wire(command), _wire(value['sources']),
                           _wire(value['outputs']), _wire(session.fence), _wire(value['publication']) if 'publication' in value else None)
    raise ExecutionControlError('execution_input_unavailable')


class ScopedMultipartControl:
    def __init__(self, session, destination, *, content_type, source_etag=None):
        self._session, self.destination, self._source_etag = session, destination, source_etag
        self._content_type = content_type
        self.completion_started = False
        # Reuse the four bodies already held by multipart.py. Only checksum
        # tuples and waiter futures are queued here, never additional media.
        self._part_slots = asyncio.Semaphore(4)
        self._part_pending = []
        self._part_flush = None
        self._part_batches = {}
        self._part_aborted = False

    @classmethod
    async def initialize(cls, session: ExecutorSession, *, artifact_id: str, byte_length: int, content_type: str,
                         source_etag: str | None = None):
        result = await asyncio.to_thread(session.transfer, 'upload-initialize', artifactId=artifact_id,
                                         byteLength=byte_length, contentType=content_type)
        value = result.disposition
        return cls(session, MultipartDestination(artifact_id, value['uploadId'], byte_length, value['partSizeBytes']),
                   content_type=content_type, source_etag=source_etag)

    async def _call(self, action, **fields):
        try:
            return (await asyncio.to_thread(self._session.transfer, action, artifactId=self.destination.artifact_id, **fields)).disposition
        except ExecutionControlError as error:
            if error.code in {'execution_grant_expired', 'execution_transport_unavailable', 'execution_command_deadline'}:
                raise MultipartTransferError('multipart_transport_failed') from None
            raise

    def _flush_part_batch(self):
        if self._part_flush is not None:
            self._part_flush.cancel()
            self._part_flush = None
        batch, self._part_pending = self._part_pending, []
        batch = [(part, waiter) for part, waiter in batch if not waiter.cancelled()]
        if not batch:
            return
        task = asyncio.create_task(self._send_part_batch(batch))
        self._part_batches[task] = batch
        task.add_done_callback(lambda done: self._part_batches.pop(done, None))

    async def _send_part_batch(self, batch):
        try:
            value = await self._call('upload-parts', parts=[part for part, _ in batch])
            grants = value['grants']
            expected = {part['partNumber'] for part, _ in batch}
            if (len(grants) != len(batch) or {grant['partNumber'] for grant in grants} != expected):
                raise MultipartTransferError('multipart_grant_invalid')
            by_number = {grant['partNumber']:SignedGrant(grant['url'], grant['headers']) for grant in grants}
        except (Exception, asyncio.CancelledError) as error:
            if isinstance(error, asyncio.CancelledError):
                error = MultipartTransferError('multipart_cancelled')
            for _, waiter in batch:
                if not waiter.done():
                    waiter.set_exception(error)
        else:
            for part, waiter in batch:
                if not waiter.done():
                    waiter.set_result(by_number[part['partNumber']])

    async def authorize_part(self, part_number, byte_length, checksum_sha256, checksum_md5):
        async with self._part_slots:
            if self._part_aborted:
                raise MultipartTransferError('multipart_cancelled')
            waiter = asyncio.get_running_loop().create_future()
            # Concurrent duplicate part calls retain their separate immutable
            # command identities instead of creating an invalid duplicate array.
            if any(part['partNumber'] == part_number for part, _ in self._part_pending):
                self._flush_part_batch()
            part = {'partNumber':part_number, 'byteLength':byte_length,
                    'checksumMd5':checksum_md5, 'checksumSha256':checksum_sha256}
            self._part_pending.append((part, waiter))
            if len(self._part_pending) == 4:
                self._flush_part_batch()
            elif self._part_flush is None:
                # A partial batch must progress even when other slots are doing
                # slow storage IO. This does not wait for sixteen participants.
                self._part_flush = asyncio.get_running_loop().call_later(0.01, self._flush_part_batch)
            try:
                return await waiter
            finally:
                if waiter.cancelled():
                    self._part_pending = [(part, future) for part, future in self._part_pending if future is not waiter]
                    if not self._part_pending and self._part_flush is not None:
                        self._part_flush.cancel()
                        self._part_flush = None
                    for task, batch in list(self._part_batches.items()):
                        if all(future.cancelled() for _, future in batch):
                            task.cancel()

    async def authorize_source_range(self, start, end, source_etag):
        if (self._source_etag != source_etag or start < 0 or start % PART_SIZE_BYTES
                or end != min(start+PART_SIZE_BYTES, self.destination.byte_length)):
            raise MultipartTransferError('multipart_source_changed')
        value = await self._call('source-range', partNumber=start//PART_SIZE_BYTES+1)
        grant = value['grant']
        expected = {'if-match':source_etag, 'range':f'bytes={start}-{end-1}'}
        headers = {name.lower():content for name,content in grant['headers'].items()}
        if any(headers.get(name) != content for name,content in expected.items()):
            raise MultipartTransferError('multipart_grant_invalid')
        return SignedGrant(grant['url'], grant['headers'])

    async def complete(self, parts, sha256):
        # The API reconciles its own immutable part plan with ListParts. Never
        # serialize the local receipts, even when the object contains640parts.
        self.completion_started = True
        value = await self._call('upload-complete', byteLength=self.destination.byte_length, sha256=sha256)
        obj = value['object']
        if obj['contentType'] != self._content_type:
            raise MultipartTransferError('multipart_completion_unconfirmed')
        return CompletedObject(obj['key'], obj['etag'], obj['byteLength'], obj['sha256'])

    async def abort(self, reason):
        self._part_aborted = True
        if self._part_flush is not None:
            self._part_flush.cancel()
            self._part_flush = None
        queued, self._part_pending = self._part_pending, []
        for _, waiter in queued:
            if not waiter.done():
                waiter.set_exception(MultipartTransferError('multipart_cancelled'))
        tasks = list(self._part_batches)
        for task in tasks:
            for _, waiter in self._part_batches[task]:
                if not waiter.done():
                    waiter.set_exception(MultipartTransferError('multipart_cancelled'))
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await self._call('upload-abort')
