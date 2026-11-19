"""The plugins the owner runs next to the server (the setting plugin_urls): their exact host:port is let
through the address check, where a private or loopback address otherwise isn't; nothing else on that
host is, and never for an AI address.

Run from nightcap-server/:  .venv/bin/python -m unittest tests.test_pluginurls
"""

import os
import socket
import unittest
from unittest import mock

os.environ.setdefault("TMDB_API_KEY", "test")

from nightcap import http  # noqa: E402


class TheSetting(unittest.TestCase):

    def test_read(self):
        self.assertEqual(http.plugin_addresses(" my-addon:8080, [::1]:8081 ,Addon.Example:443,,"),
                         {("my-addon", 8080), ("::1", 8081), ("addon.example", 443)})

    def test_empty(self):
        self.assertEqual(http.plugin_addresses(""), set())
        self.assertEqual(http.plugin_addresses(None), set())

    def test_what_isnt_host_port_is_left_out(self):
        with self.assertLogs("nightcap.http", "WARNING") as said:
            found = http.plugin_addresses("my-addon,http://my-addon:8080,my-addon:0,my-addon:70000,"
                                          "user@my-addon:8080,my-addon:8080/x,::1:8080,my-addon:80a,ok:1")
        self.assertEqual(found, {("ok", 1)})
        self.assertEqual(len(said.output), 8)

    def test_an_entry_isnt_said_as_written(self):
        # (A whole address pasted in by mistake may hold a token.)
        with self.assertLogs("nightcap.http", "WARNING") as said:
            http.plugin_addresses("https://plugin.example/secret-token/manifest.json")
        self.assertNotIn("secret-token", "".join(said.output))

    def test_is_plugin(self):
        with mock.patch.object(http, "PLUGINS", {("127.0.0.1", 8081), ("my-addon", 80)}):
            self.assertTrue(http.is_plugin("http://127.0.0.1:8081/token"))
            self.assertTrue(http.is_plugin("http://My-Addon/token"))
            self.assertFalse(http.is_plugin("http://127.0.0.1:8082/token"))
            self.assertFalse(http.is_plugin("https://my-addon/token"))
            self.assertFalse(http.is_plugin("http://127.0.0.1:bad/token"))


class TheCheck(unittest.TestCase):

    def setUp(self):
        self.listening = socket.socket()
        self.listening.bind(("127.0.0.1", 0))
        self.listening.listen(4)
        self.addCleanup(self.listening.close)
        self.port = self.listening.getsockname()[1]
        for p in (mock.patch.object(http.own_aiostreams, "address", return_value=None),
                  mock.patch.object(http, "PLUGINS", {("127.0.0.1", self.port)})):
            p.start()
            self.addCleanup(p.stop)

    def test_a_plugin_is_let_through(self):
        http._connect("127.0.0.1", self.port, 2).close()

    def test_nothing_else_on_its_host(self):
        with self.assertRaises(http.Blocked):
            http._connect("127.0.0.1", self.port + 1 if self.port < 65535 else self.port - 1, 2)

    def test_by_its_name_as_set(self):
        # (Set as 127.0.0.1: "localhost" is another name, not let through.)
        with self.assertRaises(http.Blocked):
            http._connect("localhost", self.port, 2)

    def test_not_for_an_ai_address(self):
        with self.assertRaises(http.Blocked):
            http._connect("127.0.0.1", self.port, 2, own_ok=False)

    def test_through_the_opener(self):
        # (The whole way a fetch goes: refused by the listener, not blocked.)
        self.listening.close()
        with self.assertRaises(Exception) as e:
            http.get_json(f"http://127.0.0.1:{self.port}/manifest.json", retries=0, timeout=2)
        self.assertNotIsInstance(getattr(e.exception, "reason", e.exception), http.Blocked)
        with mock.patch.object(http, "PLUGINS", set()), self.assertRaises(Exception) as e:
            http.get_json(f"http://127.0.0.1:{self.port}/manifest.json", retries=0, timeout=2)
        self.assertIsInstance(getattr(e.exception, "reason", e.exception), http.Blocked)


if __name__ == "__main__":
    unittest.main()
