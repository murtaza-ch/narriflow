from __future__ import annotations

import asyncio
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from narriflow_media.manifest import SourceManifestError, YouTubeSource
from narriflow_media.process import MediaProcessError
from narriflow_media.fetch import DownloadedSource, ExistingSourceAudio, ProviderAccessBlocked, ResolvedSource, SourceFetchFailure, fetch_source


def probe(video=False):
    return {"probeVersion": "probe-fixture-v1", "durationSec": 10.0, "hasAudio": True, "hasVideo": video,
            "width": 1920 if video else 0, "height": 1080 if video else 0, "fps": 30,
            "facts": {"audios": [{"codec": "aac", "sampleRate": 48000, "channels": 2, "startTimeSec": 0.0}]}}


class SharedFetchTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_frozen_no_speech_plan_downloads_the_original_without_creating_audio(self):
        calls=[]
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);video=root/'source.mp4';video.write_bytes(b'original')
            class Runtime:
                async def resolve(self,source,session,work):return ResolvedSource(source.media_id,'140','137',None,work/'metadata.json')
                async def download_audio(self,*args):raise AssertionError('No speech plan started audio')
                async def download_video(self,selected,session,work):return DownloadedSource(video,selected.media_id,selected.audio_format_id)
                async def probe(self,path):return probe(True)
                async def end_session(self,work):calls.append('closed')
            class Sink:
                async def audio_ready(self,*args):raise AssertionError('No speech plan published audio')
                async def video_ready(self,artifact,audio):
                    if audio is not None:raise AssertionError('SourceAudio was fabricated')
                    calls.append('original')
            result=await fetch_source(YouTubeSource('_123456789-'),source_revision=2,mode='local',development=True,work_directory=root,
                runtime=Runtime(),sink=Sink(),toolchain_fingerprint='b'*64,acquire_audio=False)
            self.assertIsNone(result.audio);self.assertEqual(calls,['original','closed'])

    async def test_an_original_without_an_audio_stream_never_fabricates_a_source_audio(self):
        calls=[]
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);video=root/'silent.mp4';video.write_bytes(b'silent')
            class Runtime:
                async def resolve(self,source,session,work):return ResolvedSource(source.media_id,None,'137',None,work/'metadata.json')
                async def download_audio(self,*args):raise AssertionError('No-audio source started extraction')
                async def download_video(self,selected,session,work):return DownloadedSource(video,selected.media_id,None)
                async def probe(self,path):return {**probe(True),'hasAudio':False,'facts':{'audios':[]}}
                async def end_session(self,work):calls.append('closed')
            class Sink:
                async def audio_ready(self,*args):raise AssertionError('No-audio source published audio')
                async def video_ready(self,artifact,audio):
                    if audio is not None or artifact.manifest['audioTrack'] is not None:raise AssertionError('Fabricated audio')
                    calls.append('original')
            result=await fetch_source(YouTubeSource('_123456789-'),source_revision=2,mode='local',development=True,work_directory=root,
                runtime=Runtime(),sink=Sink(),toolchain_fingerprint='b'*64)
            self.assertIsNone(result.audio);self.assertEqual(calls,['original','closed'])

    async def test_verified_audio_commits_while_full_video_is_still_downloading(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            audio_file, video_file = root / "audio.m4a", root / "video.mp4"
            audio_file.write_bytes(b"a")
            video_file.write_bytes(b"v")
            audio_ready, video_started, finish_video = asyncio.Event(), asyncio.Event(), asyncio.Event()
            events, closed = [], []

            class Runtime:
                async def resolve(self, source, session, work):
                    return ResolvedSource(source.media_id, "140", "137", "en", work / "source.info.json")

                async def download_audio(self, selected, session, work):
                    return DownloadedSource(audio_file, selected.media_id, selected.audio_format_id)

                async def download_video(self, selected, session, work):
                    video_started.set()
                    await finish_video.wait()
                    return DownloadedSource(video_file, selected.media_id, selected.audio_format_id)

                async def end_session(self, work):
                    closed.append(work)

                async def probe(self, path):
                    return probe(path == video_file)

            class Sink:
                async def audio_ready(self, artifact):
                    self_audio = artifact.manifest
                    events.append(("audio", self_audio["durationSeconds"]))
                    audio_ready.set()

                async def video_ready(self, artifact, audio):
                    events.append(("video", audio.manifest["sha256"]))

            task = asyncio.create_task(fetch_source(
                YouTubeSource("_123456789-"), source_revision=2, mode="local", development=True,
                work_directory=root, runtime=Runtime(), sink=Sink(), toolchain_fingerprint="b" * 64,
            ))
            await asyncio.wait_for(video_started.wait(), 1)
            await asyncio.wait_for(audio_ready.wait(), 1)
            self.assertFalse(task.done())
            self.assertEqual(events, [("audio", 10.0)])
            finish_video.set()
            result = await task
            self.assertEqual([event[0] for event in events], ["audio", "video"])
            self.assertEqual(len(closed), 1)
            self.assertEqual(result.audio.manifest["sha256"], "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb")
            result.audio.assert_unchanged()
            audio_file.write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "source_file_changed"):
                result.audio.assert_unchanged()

    async def test_proxy_rotation_reextracts_and_never_reuploads_committed_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            audio_file, video_file = root / "audio.m4a", root / "video.mp4"
            audio_file.write_bytes(b"a")
            video_file.write_bytes(b"v")
            resolved, audio_downloads, video_downloads, commits, closed = [], [], [], [], []
            class Runtime:
                async def resolve(self, source, session, work):
                    resolved.append(session.session_id)
                    metadata = work / "source.info.json"
                    metadata.write_text(session.session_id)
                    return ResolvedSource(source.media_id, "140", "137", "en", metadata)
                async def download_audio(self, selected, session, work):
                    audio_downloads.append(session.session_id)
                    return DownloadedSource(audio_file, selected.media_id, selected.audio_format_id)
                async def download_video(self, selected, session, work):
                    self_id = selected.metadata_path.read_text()
                    if self_id != session.session_id:
                        raise AssertionError("resolved media URLs crossed proxy exits")
                    video_downloads.append(session.session_id)
                    if len(video_downloads) < 3:
                        raise ProviderAccessBlocked()
                    return DownloadedSource(video_file, selected.media_id, selected.audio_format_id)
                async def end_session(self, work):
                    closed.append((work / "source.info.json").read_text())
                async def probe(self, path):
                    return probe(path == video_file)
            class Sink:
                async def audio_ready(self, artifact):
                    commits.append("audio")
                async def video_ready(self, artifact, audio):
                    commits.append("video")
            await fetch_source(YouTubeSource("_123456789-"), source_revision=2, mode="proxy", development=False,
                               proxy_template="http://sticky-{session}:test-only@proxy.example:8080",
                               work_directory=root, runtime=Runtime(), sink=Sink(), toolchain_fingerprint="b" * 64)
            self.assertEqual(len(set(resolved)), 3)
            self.assertEqual(video_downloads, resolved)
            self.assertEqual(audio_downloads, [resolved[0]])
            self.assertEqual(commits, ["audio", "video"])
            self.assertEqual(closed, resolved)

    def fixed_route_runtime(self, root: Path, blocked: set[str], resolved: list[str]):
        audio_file, video_file = root / "audio.m4a", root / "video.mp4"
        audio_file.write_bytes(b"a")
        video_file.write_bytes(b"v")
        class Runtime:
            async def resolve(self, source, session, work):
                resolved.append(session.session_id)
                if session.session_id in blocked:
                    raise ProviderAccessBlocked()
                metadata = work / "source.info.json"
                metadata.write_text(session.session_id)
                return ResolvedSource(source.media_id, "140", "137", "en", metadata)
            async def download_audio(self, selected, session, work):
                return DownloadedSource(audio_file, selected.media_id, selected.audio_format_id)
            async def download_video(self, selected, session, work):
                return DownloadedSource(video_file, selected.media_id, selected.audio_format_id)
            async def end_session(self, work):
                pass
            async def probe(self, path):
                return probe(path == video_file)
        return Runtime()

    async def test_a_blocked_fixed_address_falls_through_to_the_next_before_any_rotating_session(self):
        with tempfile.TemporaryDirectory() as directory:
            root, resolved, commits = Path(directory), [], []
            class Sink:
                async def audio_ready(self, artifact):
                    commits.append("audio")
                async def video_ready(self, artifact, audio):
                    commits.append("video")
            with self.assertLogs("narriflow_media.fetch", "WARNING") as logs, patch("narriflow_media.proxy.random.randrange", return_value=0):
                await fetch_source(YouTubeSource("_123456789-"), source_revision=2, mode="proxy", development=False,
                                   static_proxy_urls="http://isp:hidden@one.example:3128,http://isp:hidden@two.example:3128",
                                   proxy_template="http://sticky-{session}:hidden@proxy.example:8080",
                                   work_directory=root, runtime=self.fixed_route_runtime(root, {"static-1"}, resolved),
                                   sink=Sink(), toolchain_fingerprint="b" * 64)
            self.assertEqual(resolved, ["static-1", "static-2"])
            self.assertEqual(commits, ["audio", "video"])
            self.assertEqual(len(logs.output), 2)
            self.assertIn('"route": "static-1", "outcome": "blocked"', logs.output[0])
            self.assertIn('"route": "static-2", "outcome": "downloaded"', logs.output[1])
            self.assertFalse(any("hidden" in line or "example" in line for line in logs.output))

    async def test_a_non_block_failure_ends_the_import_on_that_exit_and_logs_only_its_code(self):
        with tempfile.TemporaryDirectory() as directory:
            root, resolved = Path(directory), []
            runtime = self.fixed_route_runtime(root, set(), resolved)
            async def dead_proxy(source, session, work):
                resolved.append(session.route)
                raise SourceFetchFailure("source_fetch_failed", True)
            runtime.resolve = dead_proxy
            class Sink:
                async def audio_ready(self, artifact):
                    raise AssertionError("nothing may commit")
                video_ready = audio_ready
            with self.assertLogs("narriflow_media.fetch", "WARNING") as logs, patch("narriflow_media.proxy.random.randrange", return_value=0):
                with self.assertRaisesRegex(SourceFetchFailure, "source_fetch_failed"):
                    await fetch_source(YouTubeSource("_123456789-"), source_revision=2, mode="proxy", development=False,
                                       static_proxy_urls="http://isp:hidden@one.example:3128,http://isp:hidden@two.example:3128",
                                       work_directory=root, runtime=runtime, sink=Sink(), toolchain_fingerprint="b" * 64)
            self.assertEqual(resolved, ["static-1"])
            self.assertEqual(len(logs.output), 1)
            self.assertIn('"outcome": "failed", "code": "source_fetch_failed"', logs.output[0])

    async def test_untyped_and_cancelled_failures_log_a_fixed_code_or_interrupted(self):
        cases = [(SourceManifestError("source_file_changed"), '"outcome": "failed", "code": "source_file_changed"'),
                 (RuntimeError("http://isp:hidden@one.example:3128 refused"), '"outcome": "failed", "code": "unclassified"'),
                 (MediaProcessError("media_execution_cancelled"), '"outcome": "interrupted"')]
        for error, expected in cases:
            with self.subTest(error=type(error).__name__), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                runtime = self.fixed_route_runtime(root, set(), [])
                async def failing(source, session, work, error=error):
                    raise error
                runtime.resolve = failing
                with self.assertLogs("narriflow_media.fetch", "WARNING") as logs:
                    with self.assertRaises(type(error)):
                        await fetch_source(YouTubeSource("_123456789-"), source_revision=2, mode="proxy", development=False,
                                           static_proxy_urls="http://isp:hidden@one.example:3128",
                                           work_directory=root, runtime=runtime, sink=None, toolchain_fingerprint="b" * 64)
                self.assertEqual(len(logs.output), 1)
                self.assertIn(expected, logs.output[0])
                self.assertNotIn("hidden", logs.output[0])

    async def test_a_malformed_proxy_secret_is_a_permanent_typed_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(SourceFetchFailure) as failure:
                await fetch_source(YouTubeSource("_123456789-"), source_revision=2, mode="proxy", development=False,
                                   static_proxy_urls="http://isp-{session}:hidden@one.example:3128",
                                   work_directory=Path(directory), runtime=None, sink=None, toolchain_fingerprint="b" * 64)
            self.assertEqual((failure.exception.code, failure.exception.retryable), ("youtube_proxy_invalid", False))
            self.assertIsNone(failure.exception.__cause__)
            self.assertNotIn("hidden", str(failure.exception))

    async def test_every_blocked_fixed_address_without_a_rotating_proxy_refuses_the_import(self):
        with tempfile.TemporaryDirectory() as directory:
            root, resolved = Path(directory), []
            class Sink:
                async def audio_ready(self, artifact):
                    raise AssertionError("nothing may commit")
                video_ready = audio_ready
            with self.assertLogs("narriflow_media.fetch", "WARNING"):
                with self.assertRaises(ProviderAccessBlocked):
                    await fetch_source(YouTubeSource("_123456789-"), source_revision=2, mode="proxy", development=False,
                                       static_proxy_urls="http://one.example:3128,http://two.example:3128",
                                       work_directory=root, runtime=self.fixed_route_runtime(root, {"static-1", "static-2"}, resolved),
                                       sink=Sink(), toolchain_fingerprint="b" * 64)
            self.assertEqual(sorted(resolved), ["static-1", "static-2"])
            with self.assertRaisesRegex(SourceFetchFailure, "source_fetch_mode_forbidden"):
                await fetch_source(YouTubeSource("_123456789-"), source_revision=2, mode="proxy", development=False,
                                   work_directory=root, runtime=self.fixed_route_runtime(root, set(), []),
                                   sink=Sink(), toolchain_fingerprint="b" * 64)

    async def test_video_mismatch_keeps_the_committed_audio_and_never_publishes_video(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            audio_file, video_file = root / "audio.m4a", root / "video.mp4"
            audio_file.write_bytes(b"a")
            video_file.write_bytes(b"v")
            commits, closed = [], []
            class Runtime:
                async def resolve(self, source, session, work):
                    return ResolvedSource(source.media_id, "140", "137", "en", work / "source.info.json")
                async def download_audio(self, selected, session, work):
                    return DownloadedSource(audio_file, selected.media_id, selected.audio_format_id)
                async def download_video(self, selected, session, work):
                    return DownloadedSource(video_file, selected.media_id, selected.audio_format_id)
                async def end_session(self, work):
                    closed.append(work)
                async def probe(self, path):
                    result = probe(path == video_file)
                    if path == video_file:
                        result["durationSec"] = 14.0
                    return result
            class Sink:
                async def audio_ready(self, artifact):
                    commits.append("audio")
                async def video_ready(self, artifact, audio):
                    commits.append("video")
            with self.assertRaises(SourceFetchFailure) as failure:
                await fetch_source(YouTubeSource("_123456789-"), source_revision=2, mode="local", development=True,
                                   work_directory=root, runtime=Runtime(), sink=Sink(), toolchain_fingerprint="b" * 64)
            self.assertEqual(failure.exception.code, "source_audio_video_mismatch")
            self.assertEqual(commits, ["audio"])
            self.assertEqual(len(closed), 1)
            self.assertEqual(audio_file.read_bytes(), b"a")

    async def test_audio_extracted_past_a_minute_boundary_still_publishes_its_video(self):
        events=[]
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);audio=root/'audio.m4a';video=root/'video.mp4';audio.write_bytes(b'a');video.write_bytes(b'v')
            class Runtime:
                async def resolve(self,source,session,work):return ResolvedSource(source.media_id,'140','137',None,work/'metadata')
                async def download_audio(self,selected,session,work):return DownloadedSource(audio,selected.media_id,'140')
                async def download_video(self,selected,session,work):return DownloadedSource(video,selected.media_id,'140')
                async def probe(self,path):return {**probe(path==video),'durationSec':60.0 if path==video else 60.011}
                async def end_session(self,work):pass
            class Sink:
                async def audio_ready(self,artifact):events.append('audio')
                async def video_ready(self,*args):events.append('video')
            await fetch_source(YouTubeSource('_123456789-'),source_revision=1,mode='local',development=True,work_directory=root,runtime=Runtime(),sink=Sink(),toolchain_fingerprint='b'*64)
            self.assertEqual(events,['audio','video'])

    async def test_a_sealed_existing_audio_binding_is_reused_without_a_second_download_or_commit(self):
        binding = {
            "sourceAudioId": "00000000-0000-4000-8000-000000000001", "projectId": "00000000-0000-4000-8000-000000000002",
            "sourceRevision": 2, "mediaIdentity": {"provider": "youtube", "mediaId": "_123456789-"},
            "audioTrack": {"id": "140", "language": "en", "codec": "aac", "sampleRate": 48000, "channels": 2},
            "object": {"key": "execution/sealed/audio.m4a", "etag": "sealed-etag", "byteLength": 1, "sha256": "a" * 64},
            "durationSeconds": 10.0, "wholeSource": True, "audioStartTimeSec": 0.0,
            "probeVersion": "probe-fixture-v1", "toolchainFingerprint": "b" * 64,
        }
        seed, calls = ExistingSourceAudio(binding), []
        video_available = True
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video_file = root / "video.mp4"
            video_file.write_bytes(b"v")
            class Runtime:
                async def resolve(self, source, session, work):
                    calls.append("resolve")
                    return ResolvedSource(source.media_id, "140", "137", "en", work / "metadata.json")
                async def download_audio(self, *args):
                    raise AssertionError("sealed audio was downloaded twice")
                async def download_video(self, selected, session, work):
                    calls.append("video")
                    return DownloadedSource(video_file, selected.media_id, selected.audio_format_id)
                async def probe(self, path):
                    return probe(video_available)
                async def end_session(self, work):
                    calls.append("closed")
            class Sink:
                async def audio_ready(self, artifact):
                    raise AssertionError("sealed audio was committed twice")
                async def video_ready(self, artifact, audio):
                    if audio is not seed:
                        raise AssertionError("video lost its sealed audio binding")
                    calls.append("video_commit")
            result = await fetch_source(YouTubeSource("_123456789-"), source_revision=2, project_id=binding["projectId"],
                                        existing_audio=seed, mode="local", development=True, work_directory=root,
                                        runtime=Runtime(), sink=Sink(), toolchain_fingerprint="b" * 64)
            self.assertIs(result.audio, seed)
            self.assertEqual(seed.manifest["byteLength"], 1)
            self.assertEqual(seed.manifest["sha256"], "a" * 64)
            self.assertEqual(calls, ["resolve", "video", "video_commit", "closed"])
            view = seed.binding
            view["audioTrack"]["id"] = "different"
            self.assertEqual(seed.binding["audioTrack"]["id"], "140")
            for project_id, revision in [("00000000-0000-4000-8000-000000000003", 2), (binding["projectId"], 3)]:
                with self.assertRaises(SourceFetchFailure) as changed:
                    await fetch_source(YouTubeSource("_123456789-"), source_revision=revision, project_id=project_id,
                                       existing_audio=seed, mode="local", development=True, work_directory=root,
                                       runtime=Runtime(), sink=Sink(), toolchain_fingerprint="b" * 64)
                self.assertEqual(changed.exception.code, "source_audio_video_mismatch")
            self.assertEqual(calls, ["resolve", "video", "video_commit", "closed"])
            video_available = False
            with self.assertRaises(SourceFetchFailure) as missing_video:
                await fetch_source(YouTubeSource("_123456789-"), source_revision=2, project_id=binding["projectId"],
                                   existing_audio=seed, mode="local", development=True, work_directory=root,
                                   runtime=Runtime(), sink=Sink(), toolchain_fingerprint="b" * 64)
            self.assertEqual(missing_video.exception.code, "source_audio_video_mismatch")
            self.assertEqual(calls[-3:], ["resolve", "video", "closed"])
            binding["wholeSource"] = False
            with self.assertRaisesRegex(ValueError, "source_audio_seed_invalid"):
                ExistingSourceAudio(binding)


if __name__ == "__main__":
    unittest.main()
