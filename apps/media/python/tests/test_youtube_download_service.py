from __future__ import annotations

import json
from pathlib import Path
import tempfile
from threading import Event
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from narriflow_media.control import ExecutionControlError
from narriflow_media.fetch import SourceFetchFailure
from narriflow_media.process import ChildCancellation, MediaProcessError
from narriflow_media.youtube_download_service import curl_request, resolve_service_download

TOKEN = "apify_api_" + "T" * 36
VIDEO = "hWe-j78vNpc"


def responding(status, items=None, raw=None):
    calls = []
    async def request(token, media_id, timeout):
        calls.append((token, media_id, timeout))
        return status, raw if raw is not None else json.dumps(items).encode()
    return request, calls


class DownloadServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_resolved_video_returns_its_one_shot_link_and_never_logs_it_or_the_token(self):
        request, calls = responding(201, [{"ok": True, "video_id": VIDEO, "duration": 577,
                                           "download_url": "https://api.fastsaver.io/v1/tunnel?id=secret-link"}])
        with self.assertLogs("narriflow_media.youtube_download_service", "WARNING") as logs:
            resolved = await resolve_service_download(TOKEN, VIDEO, timeout=180, request=request)
        self.assertEqual((resolved.url, resolved.duration_seconds), ("https://api.fastsaver.io/v1/tunnel?id=secret-link", 577))
        self.assertEqual(calls[0][:2], (TOKEN, VIDEO))
        self.assertNotIn("secret-link", repr(resolved))
        self.assertFalse(any("secret-link" in line or TOKEN in line for line in logs.output))
        self.assertIn('"outcome": "resolved", "host": "api.fastsaver.io"', logs.output[0])

    async def test_a_video_the_service_cannot_fetch_sends_the_user_to_upload(self):
        request, _ = responding(201, [{"ok": False, "video_id": VIDEO, "error": "Video unavailable"}])
        with self.assertLogs("narriflow_media.youtube_download_service", "WARNING"):
            with self.assertRaises(SourceFetchFailure) as failure:
                await resolve_service_download(TOKEN, VIDEO, timeout=180, request=request)
        self.assertEqual((failure.exception.code, failure.exception.retryable), ("source_provider_access_denied", False))

    async def test_account_refusals_are_permanent_and_outages_are_retryable(self):
        for status, retryable in [(401, False), (402, False), (403, False), (429, True), (502, True), (408, True), (0, True)]:
            with self.subTest(status=status):
                request, _ = responding(status, raw=b"")
                with self.assertLogs("narriflow_media.youtube_download_service", "WARNING") as logs:
                    with self.assertRaises(SourceFetchFailure) as failure:
                        await resolve_service_download(TOKEN, VIDEO, timeout=180, request=request)
                self.assertEqual((failure.exception.code, failure.exception.retryable), ("source_download_failed", retryable))
                self.assertIn(f'"status": {status}', logs.output[0])

    async def test_a_malformed_or_mismatched_answer_is_never_downloaded(self):
        for items in [[], [{"ok": True, "video_id": "other_video", "download_url": "https://x.example/f"}],
                      [{"ok": True, "video_id": VIDEO, "download_url": "http://x.example/f"}],
                      [{"ok": True, "video_id": VIDEO, "download_url": "https://user:pw@x.example/f"}],
                      {"ok": True}]:
            with self.subTest(items=str(items)[:50]):
                request, _ = responding(201, items)
                with self.assertLogs("narriflow_media.youtube_download_service", "WARNING"):
                    with self.assertRaisesRegex(SourceFetchFailure, "source_download_failed"):
                        await resolve_service_download(TOKEN, VIDEO, timeout=180, request=request)

    async def test_a_malformed_token_or_unreachable_service_fails_before_or_without_a_response(self):
        with self.assertRaisesRegex(SourceFetchFailure, "youtube_download_service_invalid"):
            await resolve_service_download("not a token", VIDEO, timeout=180, request=responding(201, [])[0])
        async def unreachable(*_args):
            raise OSError("connection refused")
        with self.assertLogs("narriflow_media.youtube_download_service", "WARNING"):
            with self.assertRaises(SourceFetchFailure) as failure:
                await resolve_service_download(TOKEN, VIDEO, timeout=180, request=unreachable)
        self.assertEqual((failure.exception.code, failure.exception.retryable), ("source_download_failed", True))


class CurlRequestTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_call_is_an_owned_process_with_the_token_only_on_stdin(self):
        seen = {}
        async def run(argv, **options):
            seen.update(argv=argv, **options)
            output = Path(argv[argv.index("-o") + 1])
            output.write_text(json.dumps([{"ok": True}]))
            return SimpleNamespace(returncode=0, stdout=b"201", stderr=b"")
        owner, starts = Event(), []
        with tempfile.TemporaryDirectory() as directory, patch("narriflow_media.youtube_download_service.run_owned_process_async", run):
            request = curl_request(work=Path(directory), on_start=starts.append, cancel_event=owner)
            status, payload = await request(TOKEN, VIDEO, 120)
            self.assertEqual(list(Path(directory).iterdir()), [])
        self.assertEqual((status, json.loads(payload)), (201, [{"ok": True}]))
        self.assertFalse(any(TOKEN in part for part in seen["argv"]))
        self.assertNotIn(TOKEN, json.dumps(seen["env"]))
        self.assertEqual(seen["input_bytes"], f"Authorization: Bearer {TOKEN}\n".encode())
        self.assertIn("=https", seen["argv"])
        seen["on_start"](4242)
        self.assertEqual(starts, [4242])
        self.assertIsInstance(seen["cancel_event"], ChildCancellation)
        owner.set()
        self.assertTrue(seen["cancel_event"].is_set())

    async def test_a_curl_failure_or_lost_ownership_maps_to_retryable_or_authority_loss(self):
        async def failed(argv, **options):
            return SimpleNamespace(returncode=28, stdout=b"000", stderr=b"timeout")
        async def cancelled(argv, **options):
            raise MediaProcessError("media_execution_cancelled")
        with tempfile.TemporaryDirectory() as directory:
            with patch("narriflow_media.youtube_download_service.run_owned_process_async", failed):
                with self.assertLogs("narriflow_media.youtube_download_service", "WARNING"):
                    with self.assertRaises(SourceFetchFailure) as failure:
                        await resolve_service_download(TOKEN, VIDEO, timeout=60, request=curl_request(work=Path(directory), on_start=lambda pid: None, cancel_event=Event()))
                self.assertEqual((failure.exception.code, failure.exception.retryable), ("source_download_failed", True))
            with patch("narriflow_media.youtube_download_service.run_owned_process_async", cancelled):
                with self.assertRaisesRegex(ExecutionControlError, "execution_authority_lost"):
                    await resolve_service_download(TOKEN, VIDEO, timeout=60, request=curl_request(work=Path(directory), on_start=lambda pid: None, cancel_event=Event()))


if __name__ == "__main__":
    unittest.main()
