from __future__ import annotations

import os
import base64
import asyncio
import http.client
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from pathlib import Path
import tempfile
import threading
import unittest

from narriflow_media.token_helper import OwnedTokenHelper
from narriflow_media.proxy import bind_proxy_session


class OwnedTokenHelperTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_helper_is_owned_and_its_ready_file_disappears_on_close(self):
        # The existing local runtime was installed from the pinned provider
        # source. Source parity with the Docker digest is a separate image gate.
        configured = os.environ.get('MEDIA_TEST_TOKEN_SERVER_HOME') or os.environ.get('YTDLP_POT_SERVER_HOME')
        if not configured or not Path(configured).is_dir():
            self.skipTest('pinned local token server is not installed')
        home = Path(configured)
        with tempfile.TemporaryDirectory() as directory:
            owner_checks = []
            helper = OwnedTokenHelper(server_home=home, work_directory=Path(directory), session=None,
                                      assert_owned=lambda: owner_checks.append(True), cancel_event=threading.Event())
            async with helper:
                self.assertTrue(helper.url.startswith('http://127.0.0.1:'))
                port = urlsplit(helper.url).port
                helper.assert_live()
                self.assertGreater(len(owner_checks), 0)
            self.assertEqual(list(Path(directory).iterdir()), [])
            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=0.5)
            try:
                with self.assertRaises(OSError):
                    connection.request('GET', '/ping')
                    connection.getresponse()
            finally:
                connection.close()
            with self.assertRaisesRegex(RuntimeError, 'source_token_helper_unavailable'):
                helper.assert_live()

    async def test_actual_token_helper_https_requests_use_the_bound_http_proxy(self):
        configured = os.environ.get('MEDIA_TEST_TOKEN_SERVER_HOME') or os.environ.get('YTDLP_POT_SERVER_HOME')
        if not configured or not Path(configured).is_dir():
            self.skipTest('pinned local token server is not installed')
        connects, seen = [], threading.Event()
        class Proxy(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_CONNECT(self):
                connects.append((self.path, self.headers.get('Proxy-Authorization')))
                seen.set()
                self.send_response(502)
                self.send_header('Content-Length', '0')
                self.send_header('Connection', 'close')
                self.end_headers()
        server = ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            session = bind_proxy_session(f'http://sticky-{{session}}:test-only@127.0.0.1:{server.server_port}', '1' * 32)
            with tempfile.TemporaryDirectory() as directory:
                async with OwnedTokenHelper(server_home=Path(configured), work_directory=Path(directory), session=session,
                                            assert_owned=lambda: None, cancel_event=threading.Event()) as helper:
                    port = urlsplit(helper.url).port
                    def request_token():
                        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=8)
                        try:
                            connection.request('POST', '/get_pot', body=json.dumps({'content_binding': '_123456789-'}), headers={'Content-Type': 'application/json'})
                            response = connection.getresponse()
                            response.read(8192)
                            return response.status
                        finally:
                            connection.close()
                    request = asyncio.create_task(asyncio.to_thread(request_token))
                    try:
                        self.assertTrue(await asyncio.to_thread(seen.wait, 4), 'token helper bypassed the bound proxy')
                        self.assertTrue(all(target.endswith(':443') for target, _auth in connects))
                        expected_auth = 'Basic ' + base64.b64encode(b'sticky-11111111111111111111111111111111:test-only').decode()
                        self.assertTrue(all(auth == expected_auth for _target, auth in connects))
                    finally:
                        # The controlled proxy rejects CONNECT and never reaches
                        # a public upstream. Stop the helper and its pending
                        # request rather than waiting on upstream retry policy.
                        await helper.close()
                        await asyncio.gather(request, return_exceptions=True)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
