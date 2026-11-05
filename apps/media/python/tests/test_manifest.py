from __future__ import annotations

import json
import unittest

from narriflow_media.manifest import SourceManifestError, MediaSource,YouTubeSource, build_audio_manifest, toolchain_versions


class SourceManifestTests(unittest.TestCase):
    def test_a_direct_audio_binding_keeps_its_upstream_identity_without_a_download_url(self):
        from narriflow_media.fetch import ExistingSourceAudio
        source=MediaSource('rss','episode_1')
        manifest=build_audio_manifest(source=source,source_revision=1,audio_format_id='stream:0',language=None,
            probe={'probeVersion':'normalized-probe-v1','durationSec':60,'hasAudio':True,'facts':{'audios':[{'codec':'mp3','sampleRate':44100,'channels':2,'startTimeSec':0}]}},
            byte_length=10,sha256='a'*64,toolchain_fingerprint='b'*64)
        binding={key:value for key,value in manifest.items() if key not in {'byteLength','sha256'}}
        binding.update(sourceAudioId='60000000-0000-4000-8000-000000000001',projectId='60000000-0000-4000-8000-000000000002',object={'key':'execution/audio','etag':'"sealed"','byteLength':10,'sha256':'a'*64})
        seed=ExistingSourceAudio(binding)
        self.assertEqual(seed.binding['mediaIdentity'],{'provider':'rss','mediaId':'episode_1'})
        self.assertEqual(seed.binding['audioTrack']['id'],'stream:0');self.assertNotIn('http',json.dumps(seed.binding))

    def test_frozen_source_identity_and_whole_audio_facts_are_location_independent(self):
        source = YouTubeSource("_123456789-")
        self.assertEqual(source.media_id, "_123456789-")
        self.assertEqual(source.url, "https://www.youtube.com/watch?v=_123456789-")
        probe = {"probeVersion": "probe-fixture-v1", "durationSec": 3600.125, "hasAudio": True, "facts": {"audios": [
            {"codec": "aac", "sampleRate": 48000, "channels": 2, "startTimeSec": 0.025},
        ]}}
        manifest = build_audio_manifest(
            source=source, source_revision=2, audio_format_id="140", language="en",
            probe=probe, byte_length=1000000, sha256="a" * 64,
            toolchain_fingerprint="b" * 64,
        )
        self.assertEqual(manifest, {
            "sourceRevision": 2,
            "mediaIdentity": {"provider": "youtube", "mediaId": "_123456789-"},
            "audioTrack": {"id": "140", "language": "en", "codec": "aac", "sampleRate": 48000, "channels": 2},
            "byteLength": 1000000, "sha256": "a" * 64,
            "durationSeconds": 3600.125, "wholeSource": True, "audioStartTimeSec": 0.025,
            "probeVersion": "probe-fixture-v1", "toolchainFingerprint": "b" * 64,
        })
        self.assertNotIn("http", json.dumps(manifest))
        versions = toolchain_versions()
        self.assertEqual(versions["python"], "3.13.5")
        self.assertEqual(versions["bun"], "1.4.4")
        self.assertEqual(versions["yt-dlp"], "2026.8.19")
        self.assertEqual(versions["ffmpeg"], "7.1.5-0+deb13u1")

    def test_foreign_or_ambiguous_identity_cannot_enter_a_manifest(self):
        with self.assertRaises(SourceManifestError):
            YouTubeSource("https://private.example/secret")


if __name__ == "__main__":
    unittest.main()
