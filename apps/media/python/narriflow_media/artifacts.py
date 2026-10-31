"""Upload and commit only the outputs in this invocation's verified package."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
import math
from pathlib import Path
from threading import Lock
from typing import Any, Callable, TypedDict

from .control import ExecutionControlError, ExecutorSession
from .fetch import FileSnapshot
from .multipart import CompletedObject, SignedHttpTransport, upload_file
from .transfer import (WorkPackage, ScopedMultipartControl, SHA, MIME, _id, _integer,
                       _object, _text)


class ArtifactRoleFacts(TypedDict, total=False):
    sourceAudio: dict[str, Any]
    sourceVideo: dict[str, Any]
    renderVariant: dict[str, Any]


class ArtifactCommitUnconfirmed(ExecutionControlError):
    def __init__(self, artifact_id: str, completed_object: CompletedObject):
        super().__init__('artifact_commit_unconfirmed')
        self.artifact_id, self.completed_object = artifact_id, completed_object


@dataclass(frozen=True)
class PublishedArtifact:
    artifact_id: str
    role: str
    binding_hash: str
    content_type: str
    object: CompletedObject


def _facts(role, builder, completed):
    try:
        value = {} if builder is None else builder(completed)
        # Allow only bounded role metadata. The API validates complete domain
        # schemas and compares the frozen input before its domain transaction.
        wire = json.dumps(value, separators=(',', ':'), allow_nan=False, ensure_ascii=False).encode()
        if len(wire) > 60*1024:
            raise ValueError()
        value = json.loads(wire)
        field = {'source_audio':'sourceAudio', 'source_video':'sourceVideo', 'render_variant':'renderVariant'}.get(role)
        _object(value, set(), {field} if field else set())
        if role in {'source_audio','source_video'} and field not in value:
            raise ValueError()
        if field == 'sourceAudio':
            facts = _object(value[field], {'sourceAudioId','projectId','sourceRevision','mediaIdentity','audioTrack','object',
                'durationSeconds','wholeSource','audioStartTimeSec','probeVersion','toolchainFingerprint'})
            _id(facts['sourceAudioId'])
            if facts['object'] != {'key':completed.key,'etag':completed.etag,'byteLength':completed.byte_length,'sha256':completed.sha256}:
                raise ValueError()
        elif field == 'sourceVideo':
            facts = _object(value[field], {'projectId','sourceRevision','mediaIdentity','audioTrack','probe','wholeSource',
                'audioStartTimeSec','videoStartTimeSec','probeVersion','toolchainFingerprint'})
            if not isinstance(facts['probe'],dict) or not isinstance(facts['probe'].get('facts'),dict):
                raise ValueError()
        elif field == 'renderVariant' and field in value:
            facts = _object(value[field], {'renderId','durationSec'}, {'captionDiagnostics'})
            _id(facts['renderId'])
            if type(facts['durationSec']) not in {int,float} or not math.isfinite(facts['durationSec']) or facts['durationSec'] <= 0:
                raise ValueError()
        if field in {'sourceAudio','sourceVideo'}:
            _id(facts['projectId'])
            _integer(facts['sourceRevision'],2**53-1)
            if facts['wholeSource'] is not True:
                raise ValueError()
            _text(facts['probeVersion'],160,r'[A-Za-z0-9][A-Za-z0-9._:-]*')
            _text(facts['toolchainFingerprint'],64,SHA)
        return value
    except Exception:
        raise ExecutionControlError('execution_artifact_facts_invalid') from None


class AssignedArtifacts:
    def __init__(self, session: ExecutorSession, package: WorkPackage):
        if not isinstance(package,WorkPackage):
            raise ExecutionControlError('execution_work_package_mismatch')
        package.assert_session(session)
        self._session = session
        self._outputs = {value['artifactId']:value for value in package.outputs}
        self._in_flight, self._completed = set(), set()
        self._lock = Lock()

    async def upload(self, artifact_id: str, path: Path, *, content_type: str, byte_length: int, sha256: str,
                     facts_builder: Callable[[CompletedObject], ArtifactRoleFacts] | None = None, transport=None) -> PublishedArtifact:
        self._session.assert_live()
        assigned = self._outputs.get(artifact_id)
        try:
            if assigned is None or content_type not in assigned['contentTypes']:
                raise ValueError()
            _text(content_type,128,MIME)
            _integer(byte_length,assigned['maxBytes'])
            _text(sha256,64,SHA)
            if (assigned.get('sourceByteLength',byte_length) != byte_length or path.is_symlink()
                    or FileSnapshot.read(path).size != byte_length
                    or assigned['role'] in {'source_audio','source_video'} and facts_builder is None):
                raise ValueError()
        except (ValueError,TypeError,OSError,ExecutionControlError):
            raise ExecutionControlError('execution_artifact_invalid') from None
        with self._lock:
            if artifact_id in self._in_flight or artifact_id in self._completed:
                raise ExecutionControlError('execution_artifact_already_claimed')
            self._in_flight.add(artifact_id)
        try:
            control = await ScopedMultipartControl.initialize(self._session, artifact_id=artifact_id,
                byte_length=byte_length, content_type=content_type)
            completed = await upload_file(path, control.destination, control=control,
                transport=transport if transport is not None else SignedHttpTransport(),
                assert_owned=self._session.assert_live, cancel_event=self._session.cancel_event, expected_sha256=sha256)
            with self._lock:
                self._completed.add(artifact_id)
            return await self._commit(assigned,completed,content_type,facts_builder)
        finally:
            with self._lock:
                self._in_flight.discard(artifact_id)

    async def _commit(self,assigned,completed,content_type,facts_builder):
        artifact = {'artifactId':assigned['artifactId'],'role':assigned['role'],'bindingHash':assigned['bindingHash'],
            'contentType':content_type,'byteLength':completed.byte_length,'sha256':completed.sha256,'etag':completed.etag,
            **_facts(assigned['role'],facts_builder,completed)}
        # command() retains exact body, timestamp and delivery ID across its
        # finite retries. Never abort or delete a completed object, including
        # when the domain commit acknowledgement cannot be recovered.
        try:
            result = await asyncio.to_thread(self._session.command,'commit-artifact',artifact=artifact)
            if result.disposition != {'disposition':'committed','artifactId':assigned['artifactId']}:
                raise ExecutionControlError('execution_response_invalid')
        except ExecutionControlError:
            raise ArtifactCommitUnconfirmed(assigned['artifactId'],completed) from None
        return PublishedArtifact(assigned['artifactId'],assigned['role'],assigned['bindingHash'],content_type,completed)


    async def commit_completed(self,artifact_id:str,completed:CompletedObject,*,content_type:str,
                               facts_builder:Callable[[CompletedObject],ArtifactRoleFacts]|None=None)->PublishedArtifact:
        """Commit a server-completed conditional pin. It never creates a new upload."""
        self._session.assert_live();assigned=self._outputs.get(artifact_id)
        try:
            if assigned is None or not isinstance(completed,CompletedObject) or content_type not in assigned['contentTypes']:
                raise ValueError()
            _integer(completed.byte_length,assigned['maxBytes']);_text(completed.sha256,64,SHA)
            _text(completed.key,1024);_text(completed.etag,160,r'[\x21-\x7e]+')
            if assigned.get('sourceByteLength',completed.byte_length)!=completed.byte_length:
                raise ValueError()
        except (ValueError,TypeError,ExecutionControlError):
            raise ExecutionControlError('execution_artifact_invalid') from None
        with self._lock:
            if artifact_id in self._in_flight or artifact_id in self._completed:
                raise ExecutionControlError('execution_artifact_already_claimed')
            self._in_flight.add(artifact_id);self._completed.add(artifact_id)
        try:
            return await self._commit(assigned,completed,content_type,facts_builder)
        finally:
            with self._lock:self._in_flight.discard(artifact_id)
