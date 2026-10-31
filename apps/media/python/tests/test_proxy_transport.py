"""Native tools must use one bound HTTP proxy, with no public network fixture."""
from __future__ import annotations

import io
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import sys
import threading
import unittest
import wave
from urllib.parse import urlsplit

from narriflow_media.process import run_owned_process
from narriflow_media.proxy import bind_proxy_session


class ControlledProxyTests(unittest.TestCase):
    def test_ytdlp_ffmpeg_and_deno_use_the_same_bound_proxy(self):
        audio = io.BytesIO()
        with wave.open(audio, "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(16000)
            writer.writeframes(bytes(32000))
        payload = audio.getvalue()
        requests = []

        class Proxy(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_HEAD(self):
                self.respond(False)

            def do_GET(self):
                self.respond(True)

            def respond(self, body):
                requests.append((self.command, self.path, self.headers.get("Proxy-Authorization")))
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
            session = bind_proxy_session(
                f"http://sticky-{{session}}:test-only@127.0.0.1:{server.server_port}",
                "11111111111111111111111111111111",
            )
            target = "http://source.invalid/sample.wav"
            environment = dict(os.environ, **session.environment())
            commands = [
                [sys.executable, "-m", "yt_dlp", "--ignore-config", "--no-playlist", "--proxy", session.url,
                 "--skip-download", "--dump-single-json", target],
                ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-http_proxy", session.url,
                 "-i", target, "-t", "0.1", "-f", "null", "-"],
                ["deno", "eval", "--no-config", f"const r=await fetch({json.dumps(target)});if(!r.ok)Deno.exit(1);await r.arrayBuffer();"],
            ]
            for command in commands:
                before = len(requests)
                result = run_owned_process(command, timeout_seconds=15, kill_grace_seconds=0.1, env=environment)
                self.assertEqual(result.returncode, 0, f"{command[0]} failed through the controlled proxy")
                self.assertGreater(len(requests), before)
                for _method, path, _auth in requests[before:]:
                    parsed = urlsplit(path)
                    self.assertEqual((parsed.scheme, parsed.hostname, parsed.port or 80, parsed.path), ("http", "source.invalid", 80, "/sample.wav"))
            self.assertNotIn("test-only", repr(session))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
