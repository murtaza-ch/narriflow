from __future__ import annotations

import io
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest
import wave

from narriflow_media.fetch import ResolvedSource, SourceFetchFailure
from narriflow_media.fetch_runtime import YtDlpSourceRuntime
from narriflow_media.manifest import YouTubeSource
from narriflow_media.proxy import bind_proxy_session


class NativeSourceRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def resolved(self, facts, *, max_source_seconds=3600, failure=None):
        class Runtime(YtDlpSourceRuntime):
            async def _yt_dlp(self, args, session):
                if failure is not None:
                    raise failure
                (work / "metadata.info.json").write_text(json.dumps({"id": source.media_id, "format_id": "18", "acodec": "aac", "vcodec": "h264", **facts}))
                return json.dumps(source.media_id).encode()
        source = YouTubeSource("_123456789-")
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            runtime = Runtime(token_provider_url="http://127.0.0.1:4416", on_process_start=lambda pid: None, max_source_seconds=max_source_seconds)
            return await runtime.resolve(source, None, work)

    async def test_metadata_refuses_a_live_or_overlong_video_before_any_download(self):
        for facts in ({"is_live": True}, {"live_status": "is_live"}, {"live_status": "is_upcoming"}):
            with self.assertRaises(SourceFetchFailure) as failure:
                await self.resolved(facts)
            self.assertEqual((failure.exception.code, failure.exception.retryable), ("source_live_unsupported", False))
        with self.assertRaises(SourceFetchFailure) as failure:
            await self.resolved({"duration": 3601})
        self.assertEqual((failure.exception.code, failure.exception.retryable), ("ingest_max_duration_exceeded", False))

    async def test_a_finished_stream_or_a_video_at_the_limit_resolves(self):
        selected = await self.resolved({"duration": 3600, "live_status": "was_live", "is_live": False})
        self.assertEqual(selected.media_id, "_123456789-")

    async def test_frozen_info_download_uses_the_bound_proxy_and_normalized_probe(self):
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(16000)
            writer.writeframes(bytes(32000))
        payload, requests, starts = buffer.getvalue(), [], []
        class Proxy(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_HEAD(self):
                self.respond(False)
            def do_GET(self):
                self.respond(True)
            def respond(self, body):
                requests.append(self.path)
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                if body:
                    self.wfile.write(payload)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            session = bind_proxy_session(f"http://sticky-{{session}}:test-only@127.0.0.1:{server.server_port}", "1" * 32)
            with tempfile.TemporaryDirectory() as directory:
                work = Path(directory)
                metadata = work / "source.info.json"
                metadata.write_text(json.dumps({
                    "id": "_123456789-", "title": "Frozen source fixture", "extractor": "generic", "extractor_key": "Generic",
                    "webpage_url": "https://www.youtube.com/watch?v=_123456789-", "duration": 1.0,
                    "formats": [{"format_id": "140", "url": "http://source.invalid/audio.wav", "ext": "wav",
                                 "vcodec": "none", "acodec": "pcm_s16le", "protocol": "http"}],
                }))
                runtime = YtDlpSourceRuntime(token_provider_url="http://127.0.0.1:4416", on_process_start=starts.append)
                selected = ResolvedSource("_123456789-", "140", "140", None, metadata)
                downloaded = await runtime.download_audio(selected, session, work / "audio")
                facts = await runtime.probe(downloaded.path)
                self.assertEqual(facts["durationSec"], 1.0)
                self.assertEqual(facts["probeVersion"], "normalized-probe-v1")
                self.assertTrue(facts["hasAudio"])
                self.assertFalse(facts["hasVideo"])
                self.assertGreater(len(requests), 0)
                self.assertTrue(all("source.invalid" in path for path in requests))
                self.assertEqual(len(starts), 2)
                self.assertEqual(downloaded.path.stat().st_mode & 0o222, 0)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
