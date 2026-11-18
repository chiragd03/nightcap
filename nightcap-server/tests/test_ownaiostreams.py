"""This server's own AIOStreams: its address is a setting, its template the owner's (own_aiostreams)
or the built-in one; the built-in files are optional; one put in is used within a few minutes, without
a restart; an unusable one isn't used.

Run from nightcap-server/ with a throwaway database in DATABASE_URL and SECRETS_KEY (never a real one:
it replaces the own_aiostreams row):  .venv/bin/python -m unittest tests.test_ownaiostreams
"""

import json
import os
import tempfile
import unittest
from unittest import mock

os.environ.setdefault("TMDB_API_KEY", "test")

URL = "http://localhost:3000"
BUILT_IN = {"services": [{"id": "service-a"}], "presets": []}


@unittest.skipUnless(os.environ.get("DATABASE_URL") and os.environ.get("SECRETS_KEY"), "needs a throwaway database")
class OwnAIOStreams(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        from nightcap import aiostreams, http, own_aiostreams, schema, store
        schema.apply()
        cls.store, cls.own, cls.aiostreams, cls.http = store, own_aiostreams, aiostreams, http

    def setUp(self):
        self.store.q("DELETE FROM own_aiostreams")
        self.addCleanup(lambda: self.store.q("DELETE FROM own_aiostreams"))
        self.private = tempfile.mkdtemp()
        for p in (mock.patch.object(self.own, "PRIVATE", self.private),
                  mock.patch.object(self.own, "_kept", (None, None))):
            p.start()
            self.addCleanup(p.stop)
        self.set_url(URL)

    def set_url(self, url):
        p = mock.patch.object(self.own.S.server, "own_aiostreams_url", url)
        p.start()
        self.addCleanup(p.stop)

    def built_in(self, template=BUILT_IN, services=None, need=None):
        for name, value in (("template.json", template),
                            ("services.json", services if services is not None else {"service-a": "Service A",
                                                                                     "service-b": "Service B"}),
                            ("need_a_service.json", need if need is not None else ["kind-a"])):
            with open(os.path.join(self.private, name), "w") as f:
                json.dump(value, f)

    def owners(self, template):
        from psycopg.types.json import Jsonb
        self.store.q("INSERT INTO own_aiostreams (template) VALUES (%s)", (Jsonb(template),))

    def read(self):
        self.own._kept = (None, None)
        return self.own.get()

    def test_the_built_in_one(self):
        self.built_in()
        self.assertEqual(self.read(), {"url": URL, "template": BUILT_IN,
                                       "services": {"service-a": "Service A"}, "need_a_service": {"kind-a"}})
        self.assertTrue(self.aiostreams.available())
        self.assertEqual(self.own.address(), ("localhost", 3000))
        self.assertEqual(self.aiostreams.manifest_url({"uuid": "u", "encryptedPassword": "p"}),
                         "http://localhost:3000/stremio/u/p/manifest.json")

    def test_the_owners_template_wins(self):
        self.built_in()
        mine = {"services": [{"id": "service-b"}], "presets": [{"type": "kind-b"}]}
        self.owners(mine)
        self.assertEqual(self.read(), {"url": URL, "template": mine,
                                       "services": {"service-b": "Service B"}, "need_a_service": {"kind-a"}})

    def test_without_the_built_in_files_only_the_owners(self):
        self.assertIsNone(self.read())
        self.assertFalse(self.aiostreams.available())
        with self.assertRaises(self.aiostreams.Unavailable):
            self.aiostreams.template_hash()
        mine = {"services": [{"id": "service-a"}]}
        self.owners(mine)
        self.assertEqual(self.read(), {"url": URL, "template": mine, "services": {}, "need_a_service": set()})
        self.assertEqual(self.own.services(), {})

    def test_no_address_none(self):
        self.built_in()
        self.owners({"services": []})
        self.set_url("")
        self.assertIsNone(self.read())
        self.assertEqual(self.own.services(), {})
        self.assertIsNone(self.own.address())

    def test_one_put_in_is_used_after_a_while_without_a_restart(self):
        self.assertIsNone(self.own.get())
        self.owners({"services": []})
        self.assertIsNone(self.own.get())   # (kept in memory for a few minutes)
        with mock.patch.object(self.own.time, "monotonic", return_value=self.own._kept[0] + self.own.READ_EVERY_S):
            self.assertEqual(self.own.get()["template"], {"services": []})

    def test_an_unusable_one_isnt_used(self):
        for url, template, services, need in (
                ("localhost:3000", BUILT_IN, None, None), (URL, {}, None, None),
                (URL, BUILT_IN, {"service-a": 1}, None), (URL, BUILT_IN, None, ["kind-a", ""])):
            self.set_url(url)
            self.built_in(template, services, need)
            self.assertIsNone(self.read(), (url, template, services, need))
        self.set_url(URL)
        with open(os.path.join(self.private, "services.json"), "w") as f:
            f.write('["service-a"]')
        self.assertIsNone(self.read())

    def test_the_setup_turns_off_what_needs_a_service_without_a_key(self):
        self.built_in({"services": [{"id": "service-a"}],
                       "presets": [{"type": "kind-a", "enabled": True}, {"type": "kind-b", "enabled": True}]})
        self.read()
        cfg = self.aiostreams.config({})
        self.assertEqual([p["enabled"] for p in cfg["presets"]], [False, True])
        cfg = self.aiostreams.config({"service-a": "k" * 10})
        self.assertEqual([p["enabled"] for p in cfg["presets"]], [True, True])
        self.assertEqual(cfg["services"][0]["credentials"], {"apiKey": "k" * 10})

    def test_only_its_own_address_is_let_through(self):
        self.built_in()
        self.read()
        self.assertEqual(self.own.address(), ("localhost", 3000))
        with self.assertRaises(self.http.Blocked):
            self.http._connect("localhost", 3001, 1)


@unittest.skipUnless(os.environ.get("DATABASE_URL") and os.environ.get("SECRETS_KEY"), "needs a throwaway database")
class OldRow(unittest.TestCase):
    """A server whose row still has the address in it: the row is taken out once, so the built-in
    template is used, and an owner's template put in afterwards stays through later schema changes."""

    def test_taken_out_once(self):
        from nightcap import schema, store
        schema.apply()
        store.q("DROP TABLE own_aiostreams")
        store.q("""CREATE TABLE own_aiostreams (one boolean PRIMARY KEY DEFAULT true CHECK (one), url text NOT NULL,
                   template jsonb NOT NULL, services jsonb NOT NULL DEFAULT '{}',
                   need_a_service jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now())""")
        store.q("""INSERT INTO own_aiostreams (url, template) VALUES ('http://old', '{"services": []}')""")
        store.q("DELETE FROM schema_applied")
        schema.apply()
        self.assertIsNone(store.q("SELECT 1 FROM own_aiostreams", one=True))
        store.q("""INSERT INTO own_aiostreams (template) VALUES ('{"services": []}')""")
        store.q("DELETE FROM schema_applied")
        schema.apply()
        self.assertIsNotNone(store.q("SELECT 1 FROM own_aiostreams", one=True))
        store.q("DELETE FROM own_aiostreams")


if __name__ == "__main__":
    unittest.main()
