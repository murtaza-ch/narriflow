"""Audio-first source acquisition with one immutable binding and scoped sinks.

Callers acquire the executor owner before calling this module. The sink owns
signed grants and domain commits; this module has no database or R2 credential.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import stat
import tempfile
from typing import Any, Mapping, Protocol

from .manifest import MAX_SOURCE_BYTES, SourceManifestError, YouTubeSource, build_audio_manifest, normalize_youtube_source
from .proxy import BoundProxySession, ProxySessionSequence


class SourceFetchFailure(RuntimeError):
    def __init__(self, code: str, retryable: bool = False):
        super().__init__(code)
        self.code, self.retryable = code, retryable


class ProviderAccessBlocked(SourceFetchFailure):
    def __init__(self):
        super().__init__("source_provider_access_denied")


@dataclass(frozen=True, init=False)
class ExistingSourceAudio:
    """A current sealed binding supplied by the verified work package.

    This validates immutable wire facts. Only the control API can establish
    that the binding is still current for the Project and source revision.
    No local file or new source_audio assignment is manufactured for it.
    """
    _wire: bytes = field(repr=False)

    def __init__(self, binding: Mapping[str, Any]):
        try:
            wire = json.dumps(dict(binding), separators=(",", ":"), sort_keys=True, allow_nan=False).encode()
            value = json.loads(wire)
            fields = {"sourceAudioId", "projectId", "sourceRevision", "mediaIdentity", "audioTrack", "object",
                      "durationSeconds", "wholeSource", "audioStartTimeSec", "probeVersion", "toolchainFingerprint"}
            uuid = r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}"
            identifier = r"[A-Za-z0-9][A-Za-z0-9._:-]{0,159}"
            if len(wire) > 65536 or set(value) != fields or any(not re.fullmatch(uuid, value[name]) for name in ("sourceAudioId", "projectId")):
                raise ValueError()
            if type(value["sourceRevision"]) is not int or not 0 < value["sourceRevision"] <= 2 ** 53 - 1 or value["wholeSource"] is not True:
                raise ValueError()
            identity, track, storage = value["mediaIdentity"], value["audioTrack"], value["object"]
            if set(identity) != {"provider", "mediaId"} or identity["provider"] != "youtube":
                raise ValueError()
            YouTubeSource(identity["mediaId"])
            if (set(track) != {"id", "language", "codec", "sampleRate", "channels"} or not re.fullmatch(identifier, track["id"])
                    or track["language"] is not None and not re.fullmatch(r"[A-Za-z0-9-]{1,32}", track["language"])
                    or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", track["codec"])
                    or type(track["sampleRate"]) is not int or not 0 < track["sampleRate"] <= 768000
                    or type(track["channels"]) is not int or not 0 < track["channels"] <= 64):
                raise ValueError()
            if (set(storage) != {"key", "etag", "byteLength", "sha256"}
                    or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9/_.-]{0,1023}", storage["key"])
                    or any(segment in {"", ".", ".."} for segment in storage["key"].split("/"))
                    or not re.fullmatch(r"[\x21-\x7e]{1,160}", storage["etag"])
                    or type(storage["byteLength"]) is not int or not 0 < storage["byteLength"] <= MAX_SOURCE_BYTES
                    or not re.fullmatch(r"[a-f0-9]{64}", storage["sha256"])):
                raise ValueError()
            for name in ("durationSeconds", "audioStartTimeSec"):
                if type(value[name]) not in {int, float} or not math.isfinite(value[name]):
                    raise ValueError()
            if (value["durationSeconds"] <= 0 or not re.fullmatch(identifier, value["probeVersion"])
                    or not re.fullmatch(r"[a-f0-9]{64}", value["toolchainFingerprint"])):
                raise ValueError()
            object.__setattr__(self, "_wire", wire)
        except (ValueError, TypeError, KeyError, SourceManifestError):
            raise SourceManifestError("source_audio_seed_invalid") from None

    @property
    def binding(self) -> dict[str, Any]:
        return json.loads(self._wire)

    @property
    def manifest(self) -> Mapping[str, Any]:
        return self.binding


class SourceAudioEvidence(Protocol):
    @property
    def manifest(self) -> Mapping[str, Any]: ...


@dataclass(frozen=True)
class ResolvedSource:
    media_id: str
    audio_format_id: str
    video_format_id: str
    language: str | None
    metadata_path: Path = field(repr=False)


@dataclass(frozen=True)
class DownloadedSource:
    path: Path = field(repr=False)
    media_id: str
    audio_format_id: str


@dataclass(frozen=True)
class FileSnapshot:
    size: int
    device: int
    inode: int
    modified_ns: int

    @staticmethod
    def read(path: Path):
        value = path.stat()
        if not stat.S_ISREG(value.st_mode):
            raise SourceManifestError("source_file_changed")
        return FileSnapshot(value.st_size, value.st_dev, value.st_ino, value.st_mtime_ns)


@dataclass(frozen=True)
class VerifiedSourceFile:
    path: Path = field(repr=False)
    manifest: Mapping[str, Any]
    probe: Mapping[str, Any] = field(repr=False)
    snapshot: FileSnapshot

    def assert_unchanged(self):
        if FileSnapshot.read(self.path) != self.snapshot:
            raise SourceManifestError("source_file_changed")


@dataclass(frozen=True)
class FetchSourceResult:
    audio: VerifiedSourceFile | ExistingSourceAudio
    video: VerifiedSourceFile


class SourceRuntime(Protocol):
    async def resolve(self, source: YouTubeSource, session: BoundProxySession | None, work: Path) -> ResolvedSource: ...
    async def download_audio(self, selected: ResolvedSource, session: BoundProxySession | None, work: Path) -> DownloadedSource: ...
    async def download_video(self, selected: ResolvedSource, session: BoundProxySession | None, work: Path) -> DownloadedSource: ...
    async def probe(self, path: Path) -> Mapping[str, Any]: ...
    async def end_session(self, work: Path) -> None: ...


class SourceSink(Protocol):
    async def audio_ready(self, artifact: VerifiedSourceFile) -> None: ...
    async def video_ready(self, artifact: VerifiedSourceFile, audio: SourceAudioEvidence) -> None: ...


def _file_hash(path: Path):
    before = FileSnapshot.read(path)
    if not 0 < before.size <= MAX_SOURCE_BYTES:
        raise SourceManifestError("source_size_exceeded")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    if FileSnapshot.read(path) != before:
        raise SourceManifestError("source_file_changed")
    return before, digest.hexdigest()


async def _verified(download: DownloadedSource, selected: ResolvedSource, source: YouTubeSource,
                    revision: int, runtime: SourceRuntime, fingerprint: str) -> VerifiedSourceFile:
    if download.media_id != source.media_id or download.audio_format_id != selected.audio_format_id:
        raise SourceFetchFailure("source_audio_video_mismatch")
    before_probe = FileSnapshot.read(download.path)
    probe = await runtime.probe(download.path)
    snapshot, digest = await asyncio.to_thread(_file_hash, download.path)
    if snapshot != before_probe:
        raise SourceManifestError("source_file_changed")
    manifest = build_audio_manifest(source=source, source_revision=revision,
                                    audio_format_id=selected.audio_format_id, language=selected.language,
                                    probe=probe, byte_length=snapshot.size, sha256=digest,
                                    toolchain_fingerprint=fingerprint)
    artifact = VerifiedSourceFile(download.path, manifest, probe, snapshot)
    artifact.assert_unchanged()
    return artifact


def _same_audio_binding(audio: SourceAudioEvidence, video: VerifiedSourceFile):
    frames_per_second = video.probe.get("fps")
    frame_tolerance = 2 / frames_per_second if type(frames_per_second) in {int, float} and math.isfinite(frames_per_second) and frames_per_second > 0 else 0
    tolerance = max(1, frame_tolerance)
    if (audio.manifest["mediaIdentity"] != video.manifest["mediaIdentity"] or
            audio.manifest["sourceRevision"] != video.manifest["sourceRevision"] or
            audio.manifest["audioTrack"] != video.manifest["audioTrack"] or
            abs(audio.manifest["durationSeconds"] - video.manifest["durationSeconds"]) > tolerance or
            abs(audio.manifest["audioStartTimeSec"] - video.manifest["audioStartTimeSec"]) > tolerance):
        raise SourceFetchFailure("source_audio_video_mismatch")
    # The server also compares plan caps and whole-credit debit before accepting
    # the video. The executor never rounds away a usage difference.


async def fetch_source(source: str | YouTubeSource, *, source_revision: int, mode: str, development: bool,
                       work_directory: Path, runtime: SourceRuntime, sink: SourceSink,
                       toolchain_fingerprint: str, proxy_template: str | None = None,
                       deadline_seconds: float = 45 * 60, existing_audio: ExistingSourceAudio | None = None,
                       project_id: str | None = None) -> FetchSourceResult:
    if mode not in {"local", "proxy"} or (mode == "local" and not development):
        raise SourceFetchFailure("source_fetch_mode_forbidden")
    if type(source_revision) is not int or not 0 < source_revision <= 2 ** 53 - 1 or not re.fullmatch(r"[a-f0-9]{64}", toolchain_fingerprint):
        raise SourceManifestError()
    if not 0 < deadline_seconds <= 45 * 60:
        raise SourceFetchFailure("source_fetch_deadline_invalid")
    identity = normalize_youtube_source(source) if isinstance(source, str) else source
    if existing_audio is not None:
        if not isinstance(existing_audio, ExistingSourceAudio):
            raise SourceManifestError("source_audio_seed_invalid")
        binding = existing_audio.binding
        if (binding["projectId"] != project_id or binding["sourceRevision"] != source_revision
                or binding["mediaIdentity"] != {"provider": "youtube", "mediaId": identity.media_id}):
            raise SourceFetchFailure("source_audio_video_mismatch")
    sessions = ProxySessionSequence(proxy_template or "") if mode == "proxy" else None
    work_directory.mkdir(parents=True, exist_ok=True)
    audio: VerifiedSourceFile | ExistingSourceAudio | None = existing_audio
    async with asyncio.timeout(deadline_seconds):
        for _attempt in range(3 if sessions is not None else 1):
            session = sessions.next() if sessions is not None else None
            directory = Path(tempfile.mkdtemp(prefix="source-session-", dir=work_directory))
            audio_directory = Path(tempfile.mkdtemp(prefix="source-audio-", dir=work_directory)) if audio is None else None
            tasks: list[asyncio.Task] = []
            retry = False
            try:
                selected = await runtime.resolve(identity, session, directory)
                if selected.media_id != identity.media_id:
                    raise SourceFetchFailure("source_identity_mismatch")
                if audio is not None and (selected.audio_format_id != audio.manifest["audioTrack"]["id"] or selected.language != audio.manifest["audioTrack"]["language"]):
                    raise SourceFetchFailure("source_audio_video_mismatch")
                async def prepare_audio():
                    assert audio_directory is not None
                    downloaded = await runtime.download_audio(selected, session, audio_directory)
                    return await _verified(downloaded, selected, identity, source_revision, runtime, toolchain_fingerprint)
                async def prepare_video():
                    downloaded = await runtime.download_video(selected, session, directory)
                    return await _verified(downloaded, selected, identity, source_revision, runtime, toolchain_fingerprint)
                audio_task = asyncio.create_task(prepare_audio()) if audio is None else None
                video_task = asyncio.create_task(prepare_video())
                tasks = [task for task in [audio_task, video_task] if task is not None]
                if audio_task is not None:
                    candidate = await audio_task
                    candidate.assert_unchanged()
                    await sink.audio_ready(candidate)
                    audio = candidate
                video = await video_task
                assert audio is not None
                _same_audio_binding(audio, video)
                video.assert_unchanged()
                await sink.video_ready(video, audio)
                return FetchSourceResult(audio, video)
            except ProviderAccessBlocked:
                if sessions is None:
                    raise
                retry = True
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)
                await runtime.end_session(directory)
                if retry:
                    # Resolved URLs from this exit are never reused on a new
                    # session. A committed audio file is kept and never uploaded
                    # again; only the pending full video is retried.
                    await asyncio.to_thread(shutil.rmtree, directory, True)
                    if audio_directory is not None and audio is None:
                        await asyncio.to_thread(shutil.rmtree, audio_directory, True)
    raise ProviderAccessBlocked()
