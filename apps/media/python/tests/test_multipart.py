from __future__ import annotations

import asyncio
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import tracemalloc
from pathlib import Path
import tempfile
import threading
import time
import unittest

from narriflow_media.multipart import CompletedObject, MultipartDestination, MultipartTransferError, SignedGrant, SignedHttpTransport, TransferResponse, pin_source, upload_file


class NativeMultipartTests(unittest.IsolatedAsyncioTestCase):
    async def test_signed_headers_merge_case_insensitively_on_the_actual_http_request(self):
        received = []
        class Storage(BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def do_GET(self):
                received.append((self.headers.get_all('If-Match'), self.headers.get_all('Range')))
                self.send_response(206); self.send_header('Content-Length', '3'); self.end_headers()
                self.wfile.write(b'abc')
        server = ThreadingHTTPServer(('127.0.0.1', 0), Storage)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            grant = SignedGrant(f'http://127.0.0.1:{server.server_port}/assigned',
                {'If-Match': '"source"', 'Range': 'bytes=0-2'})
            result = await SignedHttpTransport(allow_loopback_http=True).request(grant, 'GET', None,
                {'if-match': '"source"', 'range': 'bytes=0-2'}, 3, lambda: False)
            self.assertEqual(result.status, 206)
            self.assertEqual(received, [(['"source"'], ['bytes=0-2'])])
            with self.assertRaisesRegex(MultipartTransferError, 'multipart_grant_invalid'):
                await SignedHttpTransport(allow_loopback_http=True).request(grant, 'GET', None,
                    {'IF-MATCH': '"different"'}, 3, lambda: False)
            self.assertEqual(len(received), 1)
        finally:
            server.shutdown(); server.server_close(); thread.join(2)

    async def test_cancellation_interrupts_a_stalled_response_when_the_server_closes_connections(self):
        requested, release, cancelled = threading.Event(), threading.Event(), threading.Event()
        class Storage(BaseHTTPRequestHandler):
            def log_message(self,*args):
                pass
            def do_GET(self):
                self.send_response(200)
                self.send_header('Connection','close')
                self.send_header('Content-Length','3')
                self.end_headers()
                requested.set()
                release.wait(4)
        server=ThreadingHTTPServer(('127.0.0.1',0),Storage)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        def cancel_read():
            if requested.wait(3):
                time.sleep(.1)
                cancelled.set()
        timer=threading.Thread(target=cancel_read,daemon=True);timer.start()
        began=time.monotonic()
        try:
            with self.assertRaises(MultipartTransferError):
                await SignedHttpTransport(allow_loopback_http=True).request(SignedGrant(f'http://127.0.0.1:{server.server_port}/stalled'),
                    'GET',None,{},3,cancelled.is_set)
            self.assertLess(time.monotonic()-began,2)
        finally:
            release.set();server.shutdown();server.server_close();thread.join(2);timer.join(1)

    async def test_even_a_small_file_uses_only_an_upload_part_grant(self):
        calls, uploads = [], []
        class Control:
            async def authorize_part(self, part_number, byte_length, checksum_sha256, checksum_md5):
                calls.append(('part', part_number, byte_length, checksum_sha256, checksum_md5))
                return SignedGrant('https://storage.invalid/assigned?partNumber=1')
            async def complete(self, parts, sha256):
                calls.append(('complete', [part.part_number for part in parts], sha256))
                return CompletedObject('execution/assigned', 'final-etag', 3, sha256)
            async def abort(self, reason):
                calls.append(('abort', reason))
        class Transport:
            async def request(self, grant, method, body, headers, max_response_bytes, is_cancelled):
                uploads.append((method, body, headers))
                return TransferResponse(200, {'ETag': base64.b64decode(headers['Content-MD5']).hex()}, b'')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'audio.m4a'
            path.write_bytes(b'abc')
            result = await upload_file(path, MultipartDestination('assigned', 'upload', 3), control=Control(),
                                      transport=Transport(), assert_owned=lambda: None, cancel_event=threading.Event())
        self.assertEqual(result.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
        self.assertEqual([call[0] for call in calls], ['part', 'complete'])
        self.assertEqual(uploads[0][0:2], ('PUT', b'abc'))
        self.assertEqual(uploads[0][2]['Content-Length'], '3')
        self.assertEqual(uploads[0][2]['Content-MD5'], 'kAFQmDzST7DWlj99KOF/cg==')

    async def test_pin_uses_real_conditional_ranges_and_only_multipart_puts(self):
        received = []
        class Storage(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_GET(self):
                received.append(('GET', self.headers.get('If-Match'), self.headers.get('Range')))
                self.send_response(206)
                self.send_header('ETag', '"source-etag"')
                self.send_header('Content-Range', 'bytes 0-2/3')
                self.send_header('Content-Length', '3')
                self.end_headers()
                self.wfile.write(b'abc')
            def do_PUT(self):
                received.append(('PUT', self.rfile.read(int(self.headers['Content-Length'])), self.headers.get('Content-MD5')))
                self.send_response(200)
                self.send_header('ETag', '900150983cd24fb0d6963f7d28e17f72')
                self.send_header('Content-Length', '0')
                self.end_headers()
        server = ThreadingHTTPServer(('127.0.0.1', 0), Storage)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f'http://127.0.0.1:{server.server_port}/assigned'
            class Control:
                async def authorize_source_range(self, start, end, etag):
                    self_range = start, end, etag
                    if self_range != (0, 3, '"source-etag"'):
                        raise AssertionError('range crossed the frozen source')
                    return SignedGrant(url)
                async def authorize_part(self, *args):
                    return SignedGrant(url + '?partNumber=1')
                async def complete(self, parts, sha256):
                    return CompletedObject('execution/assigned', 'final-etag', 3, sha256)
                async def abort(self, reason):
                    raise AssertionError('successful conditional pin aborted')
            result = await pin_source(MultipartDestination('assigned', 'upload', 3), source_etag='"source-etag"',
                                      control=Control(), transport=SignedHttpTransport(allow_loopback_http=True),
                                      assert_owned=lambda: None, cancel_event=threading.Event())
            self.assertEqual(result.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
            self.assertEqual(received[0], ('GET', '"source-etag"', 'bytes=0-2'))
            self.assertEqual(received[1][0:2], ('PUT', b'abc'))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    async def test_a_failed_condition_cancels_a_stalled_sibling_and_aborts_before_completion(self):
        events = []
        part_size = 5 * 1024 * 1024
        class Control:
            async def authorize_source_range(self, start, end, etag):
                events.append(('read', start, end, etag))
                return SignedGrant('https://storage.invalid/' + str(start))
            async def authorize_part(self, *args):
                raise AssertionError('conditional failure uploaded a part')
            async def complete(self, *args):
                raise AssertionError('conditional failure completed')
            async def abort(self, reason):
                events.append(('abort', reason))
        class Transport:
            async def request(self, grant, method, body, headers, max_response_bytes, is_cancelled):
                if headers['Range'] == f'bytes=0-{part_size - 1}':
                    await asyncio.Event().wait()
                return TransferResponse(412, {}, b'')
        with self.assertRaises(MultipartTransferError) as changed:
            await asyncio.wait_for(pin_source(MultipartDestination('assigned', 'upload', part_size * 2, part_size),
                                  source_etag='"original"', control=Control(), transport=Transport(),
                                  assert_owned=lambda: None, cancel_event=threading.Event()), 1)
        self.assertEqual(changed.exception.code, 'multipart_source_changed')
        self.assertEqual(events[-1][0], 'abort')
        self.assertTrue(all(event[3] == '"original"' for event in events if event[0] == 'read'))

    async def test_lost_complete_ack_never_aborts_or_deletes_the_object(self):
        calls = []
        class Control:
            async def authorize_part(self, *args):
                return SignedGrant('https://storage.invalid/assigned')
            async def complete(self, *args):
                calls.append('complete')
                raise TimeoutError('acknowledgement lost after publication')
            async def abort(self, reason):
                calls.append('abort')
        class Transport:
            async def request(self, grant, method, body, headers, max_response_bytes, is_cancelled):
                return TransferResponse(200, {'ETag': base64.b64decode(headers['Content-MD5']).hex()}, b'')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'audio.m4a'
            path.write_bytes(b'abc')
            with self.assertRaises(TimeoutError):
                await upload_file(path, MultipartDestination('assigned', 'upload', 3), control=Control(),
                                  transport=Transport(), assert_owned=lambda: None, cancel_event=threading.Event())
        self.assertEqual(calls, ['complete'])

    async def test_virtual_ten_gib_pin_keeps_at_most_four_part_buffers(self):
        size, part_size, active, maximum, completed = 10 * 1024 ** 3, 16 * 1024 ** 2, 0, 0, []
        class Control:
            async def authorize_source_range(self, start, end, etag):
                if etag != '"original"':
                    raise AssertionError('pin lost its source condition')
                return SignedGrant('https://storage.invalid/' + str(start))
            async def authorize_part(self, number, byte_length, checksum, checksum_md5):
                return SignedGrant('https://storage.invalid/part/' + str(number))
            async def complete(self, parts, sha256):
                completed.extend(parts)
                return CompletedObject('execution/pin', 'final-etag', size, sha256)
            async def abort(self, reason):
                raise AssertionError('bounded pin aborted')
        class Transport:
            async def request(self, grant, method, body, headers, max_response_bytes, is_cancelled):
                nonlocal active, maximum
                if method == 'GET':
                    active += 1
                    maximum = max(maximum, active)
                    start = int(grant.url.rsplit('/', 1)[1])
                    await asyncio.sleep(0)
                    return TransferResponse(206, {'ETag': '"original"', 'Content-Range': f'bytes {start}-{start + part_size - 1}/{size}',
                                                  'Content-Length': str(part_size)}, b'x' * part_size)
                active -= 1
                return TransferResponse(200, {'ETag': base64.b64decode(headers['Content-MD5']).hex()}, b'')
        tracemalloc.start()
        try:
            result = await pin_source(MultipartDestination('assigned', 'upload', size), source_etag='"original"',
                                      control=Control(), transport=Transport(), assert_owned=lambda: None, cancel_event=threading.Event())
            _current, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual(result.byte_length, size)
        self.assertEqual(len(completed), 640)
        self.assertEqual([part.part_number for part in completed], list(range(1, 641)))
        self.assertLessEqual(maximum, 4)
        self.assertLess(peak, 80 * 1024 * 1024)

    async def test_stale_owner_stops_before_a_new_part_or_completion(self):
        calls, cancelled = [], threading.Event()
        class Control:
            async def authorize_part(self, number, *args):
                calls.append(('part', number))
                return SignedGrant('https://storage.invalid/part')
            async def complete(self, *args):
                calls.append(('complete',))
                raise AssertionError('stale owner completed')
            async def abort(self, reason):
                calls.append(('abort',))
        class Transport:
            async def request(self, grant, method, body, headers, max_response_bytes, is_cancelled):
                cancelled.set()
                return TransferResponse(200, {'ETag': base64.b64decode(headers['Content-MD5']).hex()}, b'')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'source.mp4'
            with path.open('wb') as output:
                output.truncate(10 * 1024 * 1024)
            with self.assertRaises(MultipartTransferError) as stopped:
                await upload_file(path, MultipartDestination('assigned', 'upload', 10 * 1024 * 1024, 5 * 1024 * 1024),
                                  control=Control(), transport=Transport(), assert_owned=lambda: None,
                                  cancel_event=cancelled, concurrency=1)
        self.assertEqual(stopped.exception.code, 'multipart_cancelled')
        self.assertEqual(calls, [('part', 1), ('abort',)])

    async def test_changed_file_never_completes_and_over_cap_input_never_gets_a_grant(self):
        calls = []
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'source.mp4'
            path.write_bytes(b'abc')
            class Control:
                async def authorize_part(self, *args):
                    calls.append('part')
                    return SignedGrant('https://storage.invalid/part')
                async def complete(self, *args):
                    calls.append('complete')
                    raise AssertionError('mutated file completed')
                async def abort(self, reason):
                    calls.append('abort')
            class Transport:
                async def request(self, grant, method, body, headers, max_response_bytes, is_cancelled):
                    path.write_bytes(b'changed')
                    return TransferResponse(200, {'ETag': base64.b64decode(headers['Content-MD5']).hex()}, b'')
            with self.assertRaises(MultipartTransferError) as changed:
                await upload_file(path, MultipartDestination('assigned', 'upload', 3), control=Control(), transport=Transport(),
                                  assert_owned=lambda: None, cancel_event=threading.Event())
            self.assertEqual(changed.exception.code, 'multipart_source_changed')
            self.assertEqual(calls, ['part', 'abort'])
            calls.clear()
            with self.assertRaises(MultipartTransferError):
                await upload_file(path, MultipartDestination('assigned', 'upload', 10 * 1024 ** 3 + 1), control=Control(),
                                  transport=Transport(), assert_owned=lambda: None, cancel_event=threading.Event())
            self.assertEqual(calls, [])

    async def test_mismatched_part_md5_etag_aborts_before_completion(self):
        calls = []
        class Control:
            async def authorize_part(self, *args):
                return SignedGrant('https://storage.invalid/part')
            async def complete(self, *args):
                calls.append('complete')
                raise AssertionError('corrupt part completed')
            async def abort(self, reason):
                calls.append('abort')
        class Transport:
            async def request(self, *args):
                return TransferResponse(200, {'ETag': '00000000000000000000000000000000'}, b'')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'source.m4a'
            path.write_bytes(b'abc')
            with self.assertRaises(MultipartTransferError) as corrupt:
                await upload_file(path, MultipartDestination('assigned', 'upload', 3), control=Control(), transport=Transport(),
                                  assert_owned=lambda: None, cancel_event=threading.Event())
            self.assertEqual(corrupt.exception.code, 'multipart_part_checksum_mismatch')
        self.assertEqual(calls, ['abort'])


if __name__ == '__main__':
    unittest.main()
