from __future__ import annotations

import json
import unittest

from narriflow_media.manifest import SourceManifestError, YouTubeSource, build_audio_manifest, normalize_youtube_source, toolchain_versions


class SourceManifestTests(unittest.TestCase):
    def test_frozen_source_identity_and_whole_audio_facts_are_location_independent(self):
        source = normalize_youtube_source("https://youtu.be/_123456789-")
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
        self.assertEqual(versions["bun"], "1.3.6")
        self.assertEqual(versions["yt-dlp"], "2026.8.19")
        self.assertEqual(versions["ffmpeg"], "7.1.5-0+deb13u1")

    def test_foreign_or_ambiguous_identity_cannot_enter_a_manifest(self):
        for value in [
            "https://youtube.com.evil.example/watch?v=abcdefghijk",
            "https://hidden:secret@youtube.com/watch?v=abcdefghijk",
            "https://www.youtube.com/watch?v=abcdefghijk&v=lmnopqrstuv",
            "https://youtu.be/too-short",
        ]:
            with self.assertRaises(SourceManifestError):
                normalize_youtube_source(value)
        with self.assertRaises(SourceManifestError):
            YouTubeSource("https://private.example/secret")


if __name__ == "__main__":
    unittest.main()
