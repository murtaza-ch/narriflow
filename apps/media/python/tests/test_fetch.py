from __future__ import annotations

import asyncio
from pathlib import Path
import tempfile
import unittest

from narriflow_media.fetch import DownloadedSource, ExistingSourceAudio, ProviderAccessBlocked, ResolvedSource, SourceFetchFailure, fetch_source


def probe(video=False):
    return {"probeVersion": "probe-fixture-v1", "durationSec": 10.0, "hasAudio": True, "hasVideo": video,
            "width": 1920 if video else 0, "height": 1080 if video else 0, "fps": 30,
            "facts": {"audios": [{"codec": "aac", "sampleRate": 48000, "channels": 2, "startTimeSec": 0.0}]}}


class SharedFetchTests(unittest.IsolatedAsyncioTestCase):
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
                "_123456789-", source_revision=2, mode="local", development=True,
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
            await fetch_source("_123456789-", source_revision=2, mode="proxy", development=False,
                               proxy_template="http://sticky-{session}:test-only@proxy.example:8080",
                               work_directory=root, runtime=Runtime(), sink=Sink(), toolchain_fingerprint="b" * 64)
            self.assertEqual(len(set(resolved)), 3)
            self.assertEqual(video_downloads, resolved)
            self.assertEqual(audio_downloads, [resolved[0]])
            self.assertEqual(commits, ["audio", "video"])
            self.assertEqual(closed, resolved)

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
                await fetch_source("_123456789-", source_revision=2, mode="local", development=True,
                                   work_directory=root, runtime=Runtime(), sink=Sink(), toolchain_fingerprint="b" * 64)
            self.assertEqual(failure.exception.code, "source_audio_video_mismatch")
            self.assertEqual(commits, ["audio"])
            self.assertEqual(len(closed), 1)
            self.assertEqual(audio_file.read_bytes(), b"a")

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
                    return probe(True)
                async def end_session(self, work):
                    calls.append("closed")
            class Sink:
                async def audio_ready(self, artifact):
                    raise AssertionError("sealed audio was committed twice")
                async def video_ready(self, artifact, audio):
                    if audio is not seed:
                        raise AssertionError("video lost its sealed audio binding")
                    calls.append("video_commit")
            result = await fetch_source("_123456789-", source_revision=2, project_id=binding["projectId"],
                                        existing_audio=seed, mode="local", development=True, work_directory=root,
                                        runtime=Runtime(), sink=Sink(), toolchain_fingerprint="b" * 64)
            self.assertIs(result.audio, seed)
            self.assertEqual(calls, ["resolve", "video", "video_commit", "closed"])
            view = seed.binding
            view["audioTrack"]["id"] = "different"
            self.assertEqual(seed.binding["audioTrack"]["id"], "140")
            for project_id, revision in [("00000000-0000-4000-8000-000000000003", 2), (binding["projectId"], 3)]:
                with self.assertRaises(SourceFetchFailure) as changed:
                    await fetch_source("_123456789-", source_revision=revision, project_id=project_id,
                                       existing_audio=seed, mode="local", development=True, work_directory=root,
                                       runtime=Runtime(), sink=Sink(), toolchain_fingerprint="b" * 64)
                self.assertEqual(changed.exception.code, "source_audio_video_mismatch")
            self.assertEqual(calls, ["resolve", "video", "video_commit", "closed"])
            binding["wholeSource"] = False
            with self.assertRaisesRegex(ValueError, "source_audio_seed_invalid"):
                ExistingSourceAudio(binding)


if __name__ == "__main__":
    unittest.main()
