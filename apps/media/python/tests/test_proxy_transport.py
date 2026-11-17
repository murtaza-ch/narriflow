"""Native tools must use one bound HTTP proxy, with no public network fixture."""
from __future__ import annotations

import io
import base64
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import sys
import threading
import unittest
import wave
from urllib.parse import urlsplit

from narriflow_media.process import run_owned_process
from narriflow_media.proxy import bind_proxy_session, bind_static_proxy


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
        expected = {"auth": None}

        class Proxy(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_HEAD(self):
                self.respond(False)

            def do_GET(self):
                self.respond(True)

            def respond(self, body):
                authorization = self.headers.get("Proxy-Authorization")
                if authorization != expected["auth"]:
                    self.send_response(407)
                    self.send_header("Proxy-Authenticate", 'Basic realm="narriflow-controlled-proxy"')
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                requests.append((self.command, self.path, authorization))
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
            port = server.server_port
            routes = [
                (bind_proxy_session(f"http://sticky-{{session}}:test-only@127.0.0.1:{port}", "1" * 32),
                 "Basic " + base64.b64encode(b"sticky-" + b"1" * 32 + b":test-only").decode()),
                # A fixed ISP address with credentials, and one allowlisted by IP.
                (bind_static_proxy(f"http://isp-user:test-only@127.0.0.1:{port}", "static-1"),
                 "Basic " + base64.b64encode(b"isp-user:test-only").decode()),
                (bind_static_proxy(f"http://127.0.0.1:{port}", "static-2"), None),
            ]
            target = "http://source.invalid/sample.wav"
            for session, auth in routes:
                expected["auth"] = auth
                environment = dict(os.environ, **session.environment())
                commands = [
                    [sys.executable, "-m", "yt_dlp", "--ignore-config", "--no-playlist", "--proxy", session.url,
                     "--skip-download", "--dump-single-json", target],
                    ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-http_proxy", session.url,
                     "-i", target, "-t", "0.1", "-f", "null", "-"],
                    ["deno", "eval", "--no-config", f"const r=await fetch({json.dumps(target)});if(!r.ok)Deno.exit(1);await r.arrayBuffer();"],
                ]
                for command in commands:
                    with self.subTest(route=session.route, tool=command[0]):
                        before = len(requests)
                        result = run_owned_process(command, timeout_seconds=15, kill_grace_seconds=0.1, env=environment)
                        self.assertEqual(result.returncode, 0, f"{command[0]} failed through the controlled proxy")
                        self.assertGreater(len(requests), before)
                        for _method, path, _auth in requests[before:]:
                            parsed = urlsplit(path)
                            self.assertEqual((parsed.scheme, parsed.hostname, parsed.port or 80, parsed.path), ("http", "source.invalid", 80, "/sample.wav"))
                            self.assertEqual(_auth, auth)
                self.assertNotIn("test-only", repr(session))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
