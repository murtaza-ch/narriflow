from __future__ import annotations

import json
import unittest

from narriflow_media.fetch import SourceFetchFailure
from narriflow_media.youtube_download_service import resolve_service_download

TOKEN = "apify_api_" + "T" * 36
VIDEO = "hWe-j78vNpc"


def responding(status, items=None, raw=None):
    calls = []
    def request(token, media_id, timeout):
        calls.append((token, media_id, timeout))
        return status, raw if raw is not None else json.dumps(items).encode()
    return request, calls


class DownloadServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_resolved_video_returns_its_one_shot_link_and_never_logs_it_or_the_token(self):
        request, calls = responding(201, [{"ok": True, "video_id": VIDEO, "duration": 577,
                                           "download_url": "https://api.fastsaver.io/v1/tunnel?id=secret-link"}])
        with self.assertLogs("narriflow_media.youtube_download_service", "WARNING") as logs:
            resolved = await resolve_service_download(TOKEN, VIDEO, request=request)
        self.assertEqual((resolved.url, resolved.duration_seconds), ("https://api.fastsaver.io/v1/tunnel?id=secret-link", 577))
        self.assertEqual(calls[0][:2], (TOKEN, VIDEO))
        self.assertNotIn("secret-link", repr(resolved))
        self.assertFalse(any("secret-link" in line or TOKEN in line for line in logs.output))
        self.assertIn('"outcome": "resolved", "host": "api.fastsaver.io"', logs.output[0])

    async def test_a_video_the_service_cannot_fetch_sends_the_user_to_upload(self):
        request, _ = responding(201, [{"ok": False, "video_id": VIDEO, "error": "Video unavailable"}])
        with self.assertLogs("narriflow_media.youtube_download_service", "WARNING"):
            with self.assertRaises(SourceFetchFailure) as failure:
                await resolve_service_download(TOKEN, VIDEO, request=request)
        self.assertEqual((failure.exception.code, failure.exception.retryable), ("source_provider_access_denied", False))

    async def test_account_refusals_are_permanent_and_outages_are_retryable(self):
        for status, retryable in [(401, False), (402, False), (403, False), (429, True), (502, True), (408, True)]:
            with self.subTest(status=status):
                request, _ = responding(status, raw=b"")
                with self.assertLogs("narriflow_media.youtube_download_service", "WARNING") as logs:
                    with self.assertRaises(SourceFetchFailure) as failure:
                        await resolve_service_download(TOKEN, VIDEO, request=request)
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
                        await resolve_service_download(TOKEN, VIDEO, request=request)

    async def test_a_malformed_token_or_unreachable_service_fails_before_or_without_a_response(self):
        with self.assertRaisesRegex(SourceFetchFailure, "youtube_download_service_invalid"):
            await resolve_service_download("not a token", VIDEO, request=responding(201, [])[0])
        def unreachable(*_args):
            raise OSError("connection refused")
        with self.assertLogs("narriflow_media.youtube_download_service", "WARNING"):
            with self.assertRaises(SourceFetchFailure) as failure:
                await resolve_service_download(TOKEN, VIDEO, request=unreachable)
        self.assertEqual((failure.exception.code, failure.exception.retryable), ("source_download_failed", True))


if __name__ == "__main__":
    unittest.main()
