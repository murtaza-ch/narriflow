from __future__ import annotations

import unittest

from narriflow_media.proxy import ProxyConfigurationError, bind_proxy_session, bind_static_proxy, proxy_routes

ROTATING = "http://sticky-{session}:test-only@proxy.example:8080"


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

    def test_a_fixed_address_is_normalized_and_refuses_a_rotating_template(self):
        bound = bind_static_proxy("http://isp%40user:p%2Fss@203.0.113.7:3128", "static-1")
        self.assertEqual(bound.session_id, "static-1")
        self.assertEqual(bound.url, "http://isp%40user:p%2Fss@203.0.113.7:3128")
        self.assertEqual(bind_static_proxy("http://203.0.113.7:3128", "static-2").url, "http://203.0.113.7:3128")
        for url in ["http://private-{session}:hidden@isp.example:3128", "https://private:hidden@isp.example:3128",
                    "socks5://private:hidden@isp.example:1080", "http://private:hidden@isp.example:3128/path"]:
            with self.subTest(url=url.split(":", 1)[0]):
                with self.assertRaises(ProxyConfigurationError) as failure:
                    bind_static_proxy(url, "static-1")
                self.assertNotIn("hidden", str(failure.exception))
                self.assertIsNone(failure.exception.__cause__)

    def test_fixed_addresses_come_first_from_the_given_start_then_three_rotating_sessions(self):
        statics = "http://a:hidden@isp-one.example:3128, http://b:hidden@isp-two.example:3128"
        routes = proxy_routes(static_urls=statics, rotating_template=ROTATING, start=1)
        self.assertEqual([route.route for route in routes], ["static-2", "static-1", "rotating-1", "rotating-2", "rotating-3"])
        self.assertIn("isp-two.example", routes[0].url)
        rotating = routes[2:]
        self.assertEqual(len({route.session_id for route in rotating}), 3)
        self.assertTrue(all("sticky-" + route.session_id in route.url for route in rotating))
        self.assertNotIn("hidden", repr(routes))

    def test_either_kind_alone_is_a_complete_configuration(self):
        self.assertEqual([route.session_id for route in proxy_routes(static_urls="http://isp.example:3128", rotating_template=None)],
                         ["static-1"])
        self.assertEqual(len(proxy_routes(static_urls=None, rotating_template=ROTATING)), 3)
        self.assertEqual(len(proxy_routes(static_urls="  ", rotating_template=ROTATING)), 3)
        self.assertEqual(proxy_routes(static_urls=None, rotating_template=None), [])

    def test_a_malformed_pool_is_refused_before_any_route_is_issued(self):
        six = ",".join(f"http://isp-{index}.example:3128" for index in range(6))
        for value in ["http://isp.example:3128,", "http://isp.example:3128,,http://isp2.example:3128", six,
                      "http://a:b@isp.example:3128,http://a:b@isp.example:3128/",
                      "http://isp.example,http://ISP.example:80",
                      "http://[2001:db8::1]:3128,http://[2001:0db8:0:0:0:0:0:1]:3128"]:
            with self.subTest(value=value[:40]):
                with self.assertRaises(ProxyConfigurationError):
                    proxy_routes(static_urls=value, rotating_template=ROTATING)
        with self.assertRaises(ProxyConfigurationError):
            proxy_routes(static_urls="http://isp.example:3128", rotating_template="http://fixed:hidden@proxy.example:8080")


if __name__ == "__main__":
    unittest.main()
