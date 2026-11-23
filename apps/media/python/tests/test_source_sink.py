from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
from threading import Event
from types import SimpleNamespace
from datetime import datetime, timezone
import unittest
import asyncio
from unittest.mock import patch
from uuid import uuid4

from narriflow_media.control import ExecutionControlError
from narriflow_media.fetch import FileSnapshot, VerifiedSourceFile
from narriflow_media.multipart import CompletedObject
from narriflow_media.process import MediaProcessError
from narriflow_media.source_sink import ScopedSourceSink
from narriflow_media.transfer import WorkPackage, _wire


class SourceSinkTests(unittest.IsolatedAsyncioTestCase):
    async def thumbnail_fixture(self, directory, *, fail=False):
        sink, audio, video, trace, state = self.fixture(directory, provider="upload")
        extra = [{"artifactId": str(uuid4()), "role": role, "bindingHash": "b"*64, "contentType": "image/webp",
            "contentTypes": ["image/webp"], "maxBytes": 256*1024} for role in ["source_thumbnail_small", "source_thumbnail_large"]]
        package = sink.package
        sink._replace(WorkPackage(package.function_name, package.input_hash, _wire(package.command), _wire(package.sources),
            _wire([*package.outputs, *extra]), _wire(sink.session.fence)))
        original = sink._run
        async def run(argv, **options):
            if not argv[1].endswith("source-thumbnails-cli.ts"):
                return await original(argv, **options)
            trace.append("thumbnail_process")
            self.assertLessEqual(options["timeout_seconds"], 20)
            self.assertNotIn("DATABASE_URL", options["env"])
            if fail: return SimpleNamespace(returncode=1, stdout=b"")
            variants = []
            for output in extra:
                path = Path(directory) / (output['role'] + '.webp')
                path.write_bytes(b"image")
                variants.append({"role": output["role"], "path": str(path.resolve()), "byteLength": 5, "sha256": hashlib.sha256(b"image").hexdigest()})
            return SimpleNamespace(returncode=0, stdout=json.dumps({"variants": variants}).encode())
        sink._run = run
        return sink, audio, video, trace, state

    async def test_upload_images_commit_before_the_source_closes_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            sink, audio, video, trace, state = await self.thumbnail_fixture(directory)
            await sink.video_ready(video, audio)
            self.assertEqual(trace, ["thumbnail_process", "source_thumbnail_small", "source_thumbnail_large", "source_video"])
            self.assertEqual(state["video"]["mediaIdentity"]["provider"], "upload")

    async def test_thumbnail_failure_still_publishes_the_verified_source(self):
        with tempfile.TemporaryDirectory() as directory:
            sink, audio, video, trace, state = await self.thumbnail_fixture(directory, fail=True)
            await sink.video_ready(video, audio)
            self.assertEqual(trace, ["thumbnail_process", "source_video"])
            self.assertIn("video", state)

    async def test_optional_thumbnail_timeout_cannot_cancel_source_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            sink, audio, video, trace, state = await self.thumbnail_fixture(directory)
            async def stalled(_argv, **options):
                try:
                    await asyncio.Future()
                except asyncio.CancelledError:
                    # The process owner sets its child event while reaping.
                    options['cancel_event'].set()
                    raise
            sink._run = stalled
            with patch('narriflow_media.source_sink.SOURCE_THUMBNAIL_TIMEOUT_SECONDS', 0.01):
                await sink.video_ready(video, audio)
            self.assertFalse(sink.session.cancel_event.is_set())
            self.assertEqual(trace, ['source_video'])
            self.assertIn('video', state)

    def fixture(self, directory, *, seeded=False, probe_fails=False, provider="youtube", quiet="ok"):
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
        video_artifact = VerifiedSourceFile(video, manifest, {"sourceProbe":{"durationSec":120,"audio":{"sampleRate":48000,"channels":2},"video":{"width":1920,"height":1080,"frameRate":{"numerator":30,"denominator":1},"startTimecode":None}},"facts": {"videos": [{"startTimeSec": 0}]}}, FileSnapshot.read(video))
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
                    if role == "source_audio": state["audio"] = facts["sourceAudio"]; state["audioFacts"] = facts
                    else: state["video"] = facts["sourceVideo"]
            async def commit_completed(self,artifact_id,completed,**options):
                trace.append('pin_commit');state['video']=options['facts_builder'](completed)['sourceVideo']
        async def loader(_session): trace.append("refresh"); return package(True)
        async def run(argv, **options):
            if argv[1].endswith("quiet-ranges-cli.ts"):
                trace.append("quiet_process")
                request = json.loads(options["input_bytes"])
                self.assertEqual(set(request), {"audioPath", "deadlineMs"})
                self.assertEqual(request["audioPath"], str(audio.resolve()))
                self.assertNotIn("DATABASE_URL", options["env"])
                if quiet == "fail": return SimpleNamespace(returncode=1, stdout=b"")
                if quiet == "bad_json": return SimpleNamespace(returncode=0, stdout=b"not json")
                if quiet == "malformed": return SimpleNamespace(returncode=0, stdout=b'{"quietRanges":[150,200,7]}')
                if quiet == "null": return SimpleNamespace(returncode=0, stdout=b'{"quietRanges":null}')
                if quiet == "raises": raise MediaProcessError("media_process_timeout")
                return SimpleNamespace(returncode=0, stdout=b'{"quietRanges":[150,200,0,40]}')
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
            self.assertEqual(trace,["quiet_process","source_audio","refresh","probe_process","probe","source_video"])
            self.assertEqual(state['video']['mediaIdentity'],{'provider':'rss','mediaId':'episode1'})
            self.assertEqual(state['video']['probe']['audio'],{'sampleRate':48000,'channels':2})
            self.assertNotIn('sourceProbe',state['video']['probe'])

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
            self.assertEqual(trace, ["quiet_process", "source_audio", "refresh", "probe_process", "probe", "source_video"])
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
            self.assertEqual(trace, ["quiet_process", "source_audio", "refresh", "probe_process", "source_video"])

    async def test_measured_quiet_ranges_ride_beside_the_unchanged_audio_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            sink, audio, video, trace, state = self.fixture(directory)
            await sink.audio_ready(audio)
            self.assertEqual(set(state["audioFacts"]), {"sourceAudio", "quietRanges"})
            self.assertEqual(state["audioFacts"]["quietRanges"], [150, 200, 0, 40])
            self.assertNotIn("quietRanges", state["audio"])

    async def test_quiet_range_measurement_failures_publish_the_audio_without_ranges(self):
        for quiet in ("fail", "bad_json", "malformed", "null", "raises"):
            with self.subTest(quiet=quiet), tempfile.TemporaryDirectory() as directory:
                sink, audio, video, trace, state = self.fixture(directory, quiet=quiet)
                await sink.audio_ready(audio)
                self.assertEqual(trace[:3], ["quiet_process", "source_audio", "refresh"])
                self.assertEqual(set(state["audioFacts"]), {"sourceAudio"})

    async def test_quiet_range_measurement_is_skipped_when_the_session_has_no_time_for_it(self):
        with tempfile.TemporaryDirectory() as directory:
            sink, audio, video, trace, state = self.fixture(directory)
            sink.session.remaining_seconds = 9
            await sink.audio_ready(audio)
            self.assertEqual(trace[0], "source_audio")
            self.assertEqual(set(state["audioFacts"]), {"sourceAudio"})

    async def test_session_loss_during_measurement_still_stops_the_source(self):
        with tempfile.TemporaryDirectory() as directory:
            sink, audio, video, trace, state = self.fixture(directory, quiet="fail")
            def lost():
                if "quiet_process" in trace: raise ExecutionControlError("execution_authority_lost")
            sink.session.assert_live = lost
            with self.assertRaisesRegex(ExecutionControlError, "execution_authority_lost"):
                await sink.audio_ready(audio)
            self.assertNotIn("source_audio", trace)

    async def test_wrong_upstream_identity_is_refused_before_any_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            sink, audio, video, trace, state = self.fixture(directory)
            invalid = VerifiedSourceFile(audio.path, {**audio.manifest, "mediaIdentity": {"provider":"youtube","mediaId":"abcdefghijk"}}, audio.probe, audio.snapshot)
            with self.assertRaisesRegex(ExecutionControlError,"execution_artifact_invalid"):
                await sink.audio_ready(invalid)
            self.assertEqual(trace, [])
