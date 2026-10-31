"""Publish audio first, prepare its optional probe, then publish full video."""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from .artifacts import AssignedArtifacts
from .control import ExecutionControlError, ExecutorSession
from .fetch import ExistingSourceAudio, VerifiedSourceFile
from .process import MediaProcessError, run_owned_process_async
from .transfer import WorkPackage, load_work_package


def _environment():
    allowed = ("PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP",
               "FFMPEG_PATH", "FFPROBE_PATH", "SSL_CERT_FILE", "SSL_CERT_DIR",
               "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS")
    return {**{key: os.environ[key] for key in allowed if key in os.environ}, "PYTHONNOUSERSITE": "1"}


def _content_type(path: Path, video: bool):
    audio_types = {".m4a": "audio/mp4", ".mp4": "audio/mp4", ".webm": "audio/webm", ".mp3": "audio/mpeg",
                   ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".aac": "audio/aac"}
    video_types = {".mp4": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska", ".mov": "video/quicktime"}
    value = (video_types if video else audio_types).get(path.suffix.lower())
    if value is None:
        raise ExecutionControlError("execution_artifact_invalid")
    return value


class ScopedSourceSink:
    def __init__(self, session: ExecutorSession, package: WorkPackage, work: Path, *,
                 artifacts_factory=AssignedArtifacts, package_loader=load_work_package,
                 run_process=run_owned_process_async, bun_executable="bun"):
        package.assert_session(session)
        command = package.command
        if command.get("kind") not in {"youtube_source","direct_source","extractor_source","upload_source"} or package.function_name != ("pin_source" if command.get("kind")=="upload_source" else "fetch_source"):
            raise ExecutionControlError("execution_work_package_mismatch")
        self._function_name=package.function_name
        self.session, self.work, self._factory, self._loader = session, work, artifacts_factory, package_loader
        self._run, self._bun, self._published = run_process, bun_executable, set()
        self._replace(package)

    def _replace(self, package):
        package.assert_session(self.session)
        if package.function_name != self._function_name:
            raise ExecutionControlError("execution_work_package_mismatch")
        if hasattr(self, "command") and any(package.command.get(key) != self.command.get(key) for key in
                ("kind", "audioPolicy", "projectId", "sourceRevision", "mediaId", "mediaIdentity", "sourceAudioId", "toolchainFingerprint", "probeVersion")):
            raise ExecutionControlError("execution_work_package_mismatch")
        self.package, self.command = package, package.command
        self.artifacts = self._factory(self.session, package)

    def _output(self, role):
        values = [value for value in self.package.outputs if value["role"] == role]
        if len(values) != 1:
            raise ExecutionControlError("execution_artifact_invalid")
        return values[0]

    def _check(self, artifact):
        self.session.assert_live()
        artifact.assert_unchanged()
        manifest, command = artifact.manifest, self.command
        identity={"provider":"youtube","mediaId":command["mediaId"]} if command["kind"]=="youtube_source" else command["mediaIdentity"]
        if (manifest["sourceRevision"] != command["sourceRevision"] or manifest["mediaIdentity"] != identity
                or manifest["toolchainFingerprint"] != command["toolchainFingerprint"] or manifest["probeVersion"] != command["probeVersion"]
                or manifest["wholeSource"] is not True):
            raise ExecutionControlError("execution_artifact_invalid")

    async def audio_ready(self, artifact: VerifiedSourceFile):
        self._check(artifact)
        if "source_audio" in self._published or self.command["existingSourceAudio"] is not None or self.command["audioPolicy"]=="none":
            raise ExecutionControlError("execution_artifact_already_claimed")
        output = self._output("source_audio")
        manifest = artifact.manifest
        def facts(completed):
            binding = {key: manifest[key] for key in ("sourceRevision", "mediaIdentity", "audioTrack", "durationSeconds",
                "wholeSource", "audioStartTimeSec", "probeVersion", "toolchainFingerprint")}
            binding.update(sourceAudioId=self.command["sourceAudioId"], projectId=self.command["projectId"],
                object={"key": completed.key, "etag": completed.etag, "byteLength": completed.byte_length, "sha256": completed.sha256})
            return {"sourceAudio": binding}
        await self.artifacts.upload(output["artifactId"], artifact.path, content_type=artifact.content_type or _content_type(artifact.path, False),
            byte_length=manifest["byteLength"], sha256=manifest["sha256"], facts_builder=facts)
        self._published.add("source_audio")
        await self.refresh_optional_probe()

    async def refresh_optional_probe(self):
        self._replace(await self._loader(self.session))
        await self.prepare_optional_probe()

    async def prepare_optional_probe(self):
        """Also called once for a package seeded with already committed audio."""
        self.session.assert_live()
        probe = self.command.get("languageProbe")
        audio = self.command.get("existingSourceAudio")
        if not probe or not audio or "probe" in self._published:
            return
        existing = ExistingSourceAudio(audio)
        if probe["sourceAudioId"] != existing.binding["sourceAudioId"] or probe["toolchainFingerprint"] != existing.binding["toolchainFingerprint"]:
            raise ExecutionControlError("execution_work_package_mismatch")
        seconds = (datetime.fromisoformat(probe["deadlineAt"].replace("Z", "+00:00")) - datetime.now(timezone.utc)).total_seconds()
        if seconds <= 0:
            return
        grants = [grant for grant in self.package.sources if grant["name"] == "source_audio"]
        if len(grants) != 1 or grants[0]["storageKey"] != audio["object"]["key"] or grants[0]["etag"] != audio["object"]["etag"]:
            raise ExecutionControlError("execution_work_package_mismatch")
        output, grant = self._output("probe"), grants[0]
        path = (self.work / "language-probe.wav").resolve()
        command = {"sourceAudio": existing.binding, "source": {"url": grant["url"], "expiresAt": grant["expiresAt"]},
            "windows": probe["windows"], "outputPath": str(path), "artifactId": output["artifactId"], "bindingHash": output["bindingHash"]}
        try:
            result = await self._run([self._bun, str(Path(__file__).resolve().parents[2] / "src/language-probe-cli.ts")],
                input_bytes=json.dumps(command, separators=(",", ":")).encode(), env=_environment(),
                timeout_seconds=min(90, seconds, self.session.remaining_seconds), on_start=self.session.on_process_start,
                cancel_event=self.session.cancel_event, max_file_bytes=2_000_000)
            self.session.assert_live()
            if result.returncode:
                return  # Optional detection degrades to the existing Auto policy.
            facts = json.loads(result.stdout)
            if facts["artifactId"] != output["artifactId"] or facts["bindingHash"] != output["bindingHash"] or facts["path"] != str(path) or facts["sourceAudioId"] != audio["sourceAudioId"]:
                raise ValueError()
        except (MediaProcessError, ValueError, KeyError, UnicodeError):
            self.session.assert_live()
            return
        await self.artifacts.upload(output["artifactId"], path, content_type="audio/wav", byte_length=facts["byteLength"], sha256=facts["sha256"])
        self._published.add("probe")

    async def video_ready(self, artifact: VerifiedSourceFile, audio, *, completed=None):
        self._check(artifact)
        if "source_video" in self._published:
            raise ExecutionControlError("execution_artifact_already_claimed")
        output, manifest = self._output("source_video"), artifact.manifest
        normalized=artifact.probe.get("sourceProbe")
        if not isinstance(normalized,dict) or not isinstance(artifact.probe.get("facts"),dict):
            raise ExecutionControlError("execution_artifact_facts_invalid")
        normalized={**normalized,"facts":dict(artifact.probe["facts"])}
        def facts(_completed):
            videos = artifact.probe["facts"]["videos"]
            return {"sourceVideo": {"projectId": self.command["projectId"], "sourceRevision": self.command["sourceRevision"],
                "mediaIdentity": manifest["mediaIdentity"], "audioTrack": manifest["audioTrack"], "probe": normalized, "wholeSource": True,
                "audioStartTimeSec": manifest["audioStartTimeSec"], "videoStartTimeSec": (videos[0]["startTimeSec"] or 0) if videos else None,
                "probeVersion": manifest["probeVersion"], "toolchainFingerprint": manifest["toolchainFingerprint"]}}
        content_type=artifact.content_type or _content_type(artifact.path,True)
        if completed is not None:
            if completed.byte_length!=manifest["byteLength"] or completed.sha256!=manifest["sha256"]:
                raise ExecutionControlError("execution_artifact_invalid")
            await self.artifacts.commit_completed(output["artifactId"],completed,content_type=content_type,facts_builder=facts)
        else:
            await self.artifacts.upload(output["artifactId"], artifact.path, content_type=content_type,
                byte_length=manifest["byteLength"], sha256=manifest["sha256"], facts_builder=facts)
        self._published.add("source_video")
