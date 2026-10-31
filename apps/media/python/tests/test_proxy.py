from __future__ import annotations

import unittest

from narriflow_media.proxy import ProxyConfigurationError, ProxySessionLimitError, ProxySessionSequence, bind_proxy_session


class ProxyPolicyTests(unittest.TestCase):
    def test_invalid_proxy_configuration_never_exposes_credentials(self):
        for template in [
            "socks5://private-{session}:hidden@proxy.example:1080",
            "https://private-{session}:hidden@proxy.example:443",
            "http://private-{session}:hidden@proxy.example/path",
            "http://private-{session}:hidden@proxy.example:70000",
            "http://private-{session}:hidden@proxy.example?query=secret",
            "http://private: hidden@proxy.example",
            "http://fixed:hidden@proxy.example:8080",
        ]:
            with self.subTest(scheme=template.split(":", 1)[0]):
                with self.assertRaises(ProxyConfigurationError) as failure:
                    bind_proxy_session(template, "a" * 32)
                self.assertEqual(str(failure.exception), "youtube_proxy_invalid")
                self.assertIsNone(failure.exception.__cause__)

    def test_a_block_can_rotate_only_three_fresh_sessions(self):
        sessions = ProxySessionSequence("http://sticky-{session}:test-only@proxy.example:8080")
        bound = [sessions.next(), sessions.next(), sessions.next()]
        self.assertEqual(len({session.session_id for session in bound}), 3)
        self.assertEqual(len({session.url for session in bound}), 3)
        with self.assertRaises(ProxySessionLimitError) as failure:
            sessions.next()
        self.assertEqual(str(failure.exception), "source_provider_access_denied")
        self.assertNotIn("test-only", repr(sessions))


if __name__ == "__main__":
    unittest.main()
