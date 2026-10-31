from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
from threading import Event
from types import SimpleNamespace
from datetime import datetime, timezone
import unittest
from uuid import uuid4

from narriflow_media.control import ExecutionControlError
from narriflow_media.fetch import FileSnapshot, VerifiedSourceFile
from narriflow_media.multipart import CompletedObject
from narriflow_media.source_sink import ScopedSourceSink
from narriflow_media.transfer import WorkPackage, _wire


class SourceSinkTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self, directory, *, seeded=False, probe_fails=False, provider="youtube"):
        trace, state = [], {}
        session = SimpleNamespace(fence={"reference": {"inputHash": "a"*64}, "attemptToken": str(uuid4()), "owner": str(uuid4())},
            assert_live=lambda: None, cancel_event=Event(), remaining_seconds=120, on_process_start=lambda pid: trace.append("start"))
        command = {"kind": "youtube_source", "audioPolicy":"pending_pack", "projectId": str(uuid4()), "sourceRevision": 1, "mediaId": "dQw4w9WgXcQ",
            "sourceAudioId": session.fence["attemptToken"], "toolchainFingerprint": "d"*64, "probeVersion": "normalized-probe-v1",
            "existingSourceAudio": None, "languageProbe": None}
        if provider!="youtube":
            command.pop("mediaId");command.update(kind="upload_source" if provider=="upload" else "direct_source",mediaIdentity={"provider":provider,"mediaId":"60000000-0000-4000-8000-000000000003" if provider=="upload" else "episode1"},source={"provider":provider,"url":"https://source.example/media","authorization":None})
        if provider=="upload":command["source"]={"storageKey":"uploads/frozen","etag":'"frozen"',"byteLength":5,"contentType":"video/mp4"}
        identity={"provider":"youtube","mediaId":command["mediaId"]} if provider=="youtube" else command["mediaIdentity"]
        manifest = {"sourceRevision": 1, "mediaIdentity": identity,
            "audioTrack": {"id": "140", "language": "en", "codec": "aac", "sampleRate": 48000, "channels": 2},
            "durationSeconds": 120, "wholeSource": True, "audioStartTimeSec": 0, "probeVersion": command["probeVersion"],
            "toolchainFingerprint": command["toolchainFingerprint"], "byteLength": 5, "sha256": hashlib.sha256(b"hello").hexdigest()}
        audio = Path(directory)/"audio.m4a"; audio.write_bytes(b"hello")
        video = Path(directory)/"video.mp4"; video.write_bytes(b"hello")
        audio_artifact = VerifiedSourceFile(audio, manifest, {}, FileSnapshot.read(audio))
        video_artifact = VerifiedSourceFile(video, manifest, {"facts": {"videos": [{"startTimeSec": 0}]}}, FileSnapshot.read(video))
        outputs = {role: {"artifactId": str(uuid4()), "role": role, "bindingHash": "b"*64, "contentType": mime,
            "contentTypes": [mime], "maxBytes": 2_000_000} for role,mime in [("source_audio","audio/mp4"),("source_video","video/mp4"),("probe","audio/wav")]}
        def package(refreshed=False):
            value = dict(command)
            if refreshed:
                value["existingSourceAudio"] = state["audio"]
                value["languageProbe"] = {"sourceAudioId": command["sourceAudioId"], "toolchainFingerprint": "d"*64,
                    "deadlineAt": datetime.fromtimestamp(datetime.now(timezone.utc).timestamp()+80, timezone.utc).isoformat().replace("+00:00","Z"),
                    "windows": [{"startSec": start, "durationSec": 20} for start in [14,50,86]]}
            sources = [{"name": "source_audio", "storageKey": state["audio"]["object"]["key"], "etag": '"sealed"',
                "url": "https://r2.example/assigned", "expiresAt": value["languageProbe"]["deadlineAt"]}] if refreshed else []
            return WorkPackage("pin_source" if provider=="upload" else "fetch_source", "a"*64, _wire(value), _wire(sources),
                _wire([outputs[role] for role in (["source_video","probe"] if refreshed else ["source_video","source_audio"])]), _wire(session.fence))
        class Artifacts:
            def __init__(self, session, package): self.roles = {value["artifactId"]: value["role"] for value in package.outputs}
            async def upload(self, artifact_id, path, **options):
                role = self.roles[artifact_id]; trace.append(role)
                if role in {"source_audio", "source_video"}:
                    facts = options["facts_builder"](CompletedObject(f"assigned/{role}", '"sealed"', 5, manifest["sha256"]))
                    if role == "source_audio": state["audio"] = facts["sourceAudio"]
                    else: state["video"] = facts["sourceVideo"]
            async def commit_completed(self,artifact_id,completed,**options):
                trace.append('pin_commit');state['video']=options['facts_builder'](completed)['sourceVideo']
        async def loader(_session): trace.append("refresh"); return package(True)
        async def run(argv, **options):
            trace.append("probe_process")
            self.assertNotIn("DATABASE_URL", options["env"])
            self.assertNotIn("EXECUTOR_CONTROL_KEYS_JSON", options["env"])
            input = json.loads(options["input_bytes"])
            if probe_fails: return SimpleNamespace(returncode=1, stdout=b"")
            path = Path(input["outputPath"]); path.write_bytes(b"0"*44)
            return SimpleNamespace(returncode=0, stdout=json.dumps({"artifactId": input["artifactId"], "bindingHash": input["bindingHash"],
                "path": str(path), "sourceAudioId": command["sourceAudioId"], "byteLength": 44, "sha256": hashlib.sha256(b"0"*44).hexdigest()}).encode())
        if seeded:
            state["audio"] = {key: manifest[key] for key in ["sourceRevision","mediaIdentity","audioTrack","durationSeconds","wholeSource","audioStartTimeSec","probeVersion","toolchainFingerprint"]}
            state["audio"].update(sourceAudioId=command["sourceAudioId"], projectId=command["projectId"],
                object={"key":"assigned/source_audio", "etag":'"sealed"', "byteLength":5, "sha256":manifest["sha256"]})
        sink = ScopedSourceSink(session, package(seeded), Path(directory), artifacts_factory=Artifacts, package_loader=loader, run_process=run)
        return sink, audio_artifact, video_artifact, trace, state

    async def test_non_youtube_source_identity_uses_the_same_audio_probe_and_original_publication_path(self):
        with tempfile.TemporaryDirectory() as directory:
            sink,audio,video,trace,state=self.fixture(directory,provider="rss")
            await sink.audio_ready(audio);await sink.video_ready(video,audio)
            self.assertEqual(trace,["source_audio","refresh","probe_process","probe","source_video"])
            self.assertEqual(state['video']['mediaIdentity'],{'provider':'rss','mediaId':'episode1'})

    async def test_an_already_completed_pin_uses_its_assigned_commit_without_a_second_video_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            sink,audio,video,trace,state=self.fixture(directory,provider="upload")
            await sink.video_ready(video,audio,completed=CompletedObject('assigned/source_video','"sealed"',5,video.manifest['sha256']))
            self.assertEqual(trace,['pin_commit'])
            self.assertEqual(state['video']['mediaIdentity']['provider'],'upload')

    async def test_audio_commit_and_probe_handoff_precede_video_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            sink, audio, video, trace, state = self.fixture(directory)
            await sink.audio_ready(audio)
            await sink.video_ready(video, audio)
            self.assertEqual(trace, ["source_audio", "refresh", "probe_process", "probe", "source_video"])
            self.assertEqual(state["audio"]["object"]["key"], "assigned/source_audio")
            self.assertEqual(state["video"]["audioTrack"], state["audio"]["audioTrack"])

    async def test_seeded_audio_prepares_the_initial_probe_without_an_audio_file_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            sink, audio, video, trace, state = self.fixture(directory, seeded=True)
            await sink.prepare_optional_probe()
            await sink.video_ready(video, audio)
            self.assertEqual(trace, ["probe_process", "probe", "source_video"])

    async def test_optional_probe_failure_keeps_the_video_path_and_does_not_publish_a_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            sink, audio, video, trace, state = self.fixture(directory, probe_fails=True)
            await sink.audio_ready(audio)
            await sink.video_ready(video, audio)
            self.assertEqual(trace, ["source_audio", "refresh", "probe_process", "source_video"])

    async def test_wrong_upstream_identity_is_refused_before_any_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            sink, audio, video, trace, state = self.fixture(directory)
            invalid = VerifiedSourceFile(audio.path, {**audio.manifest, "mediaIdentity": {"provider":"youtube","mediaId":"abcdefghijk"}}, audio.probe, audio.snapshot)
            with self.assertRaisesRegex(ExecutionControlError,"execution_artifact_invalid"):
                await sink.audio_ready(invalid)
            self.assertEqual(trace, [])
