"""This server's own AIOStreams comes from the database (own_aiostreams): none, households give their
own; one put in is used within a few minutes, without a restart; an unusable one isn't used.

Run from nightcap-server/ with a throwaway database in DATABASE_URL and SECRETS_KEY (never a real one:
it replaces the own_aiostreams row):  .venv/bin/python -m unittest tests.test_ownaiostreams
"""

import os
import unittest
from unittest import mock

os.environ.setdefault("TMDB_API_KEY", "test")


@unittest.skipUnless(os.environ.get("DATABASE_URL") and os.environ.get("SECRETS_KEY"), "needs a throwaway database")
class FromTheDatabase(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        from nightcap import aiostreams, http, own_aiostreams, schema, store
        schema.apply()
        cls.store, cls.own, cls.aiostreams, cls.http = store, own_aiostreams, aiostreams, http

    def setUp(self):
        self.store.q("DELETE FROM own_aiostreams")
        self.own._kept = (None, None)
        self.addCleanup(lambda: self.store.q("DELETE FROM own_aiostreams"))

    def put(self, url, template, services=None, need=None):
        from psycopg.types.json import Jsonb
        self.store.q("INSERT INTO own_aiostreams (url, template, services, need_a_service) VALUES (%s, %s, %s, %s)",
                     (url, Jsonb(template), Jsonb(services if services is not None else {"servicea": "ServiceA"}),
                      Jsonb(need if need is not None else ["kinda"])))

    def test_none_households_give_their_own(self):
        self.assertIsNone(self.own.get())
        self.assertEqual(self.own.services(), {})
        self.assertFalse(self.aiostreams.available())
        with self.assertRaises(self.aiostreams.Unavailable):
            self.aiostreams.template_hash()

    def test_one_put_in_is_used_after_a_while_without_a_restart(self):
        self.assertIsNone(self.own.get())
        self.put("http://localhost:3000/", {"services": []})
        self.assertIsNone(self.own.get())   # (kept in memory for a few minutes)
        with mock.patch.object(self.own.time, "monotonic", return_value=self.own._kept[0] + self.own.READ_EVERY_S):
            self.assertEqual(self.own.get(), {"url": "http://localhost:3000", "template": {"services": []},
                                              "services": {"servicea": "ServiceA"}, "need_a_service": {"kinda"}})
            self.assertEqual(self.own.services(), {"servicea": "ServiceA"})
            self.assertTrue(self.aiostreams.available())
            self.assertEqual(self.own.address(), ("localhost", 3000))
            self.assertEqual(self.aiostreams.manifest_url({"uuid": "u", "encryptedPassword": "p"}),
                             "http://localhost:3000/stremio/u/p/manifest.json")

    def test_an_unusable_one_isnt_used(self):
        for url, template, services, need in (
                ("localhost:3000", {"services": []}, None, None), ("http://localhost:3000", [1], None, None),
                ("http://localhost:3000", {}, None, None), ("http://localhost:3000", {"services": []}, ["servicea"], None),
                ("http://localhost:3000", {"services": []}, None, {"kinda": True})):
            self.store.q("DELETE FROM own_aiostreams")
            self.own._kept = (None, None)
            self.put(url, template, services, need)
            self.assertIsNone(self.own.get(), (url, template, services, need))

    def test_the_setup_turns_off_what_needs_a_service_without_a_key(self):
        template = {"services": [{"id": "servicea"}],
                    "presets": [{"type": "kinda", "enabled": True}, {"type": "kindb", "enabled": True}]}
        self.put("http://localhost:3000", template)
        cfg = self.aiostreams.config({})
        self.assertEqual([p["enabled"] for p in cfg["presets"]], [False, True])
        cfg = self.aiostreams.config({"servicea": "k" * 10})
        self.assertEqual([p["enabled"] for p in cfg["presets"]], [True, True])
        self.assertEqual(cfg["services"][0]["credentials"], {"apiKey": "k" * 10})

    def test_only_its_own_address_is_let_through(self):
        self.put("http://localhost:3000", {"services": []})
        self.assertEqual(self.own.address(), ("localhost", 3000))
        with self.assertRaises(self.http.Blocked):
            self.http._connect("localhost", 3001, 1)


if __name__ == "__main__":
    unittest.main()
