"""The AI's answers kept for the recommendations (ai_picks): saved as given, deleted after a while
and with their profile; and More like this as where a play or an opening came from.

Run from nightcap-server/ with a throwaway database in DATABASE_URL and SECRETS_KEY (never a real one):
.venv/bin/python -m unittest tests.test_aipicks
"""

import os
import unittest
import uuid
from unittest import mock

os.environ.setdefault("TMDB_API_KEY", "test")


class Origins(unittest.TestCase):

    def test_similar_is_kept(self):
        from nightcap import watching
        self.assertEqual(watching.source_of({"origin": "similar", "row": "similar", "slot": 3, "requestId": "abc"}),
                         {"origin": "similar", "row_key": "similar", "slot": 3, "request_id": "abc"})
        self.assertNotIn("origin", watching.source_of({"origin": "elsewhere"}))


@unittest.skipUnless(os.environ.get("DATABASE_URL") and os.environ.get("SECRETS_KEY"), "needs a throwaway database")
class Saved(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        from nightcap import ai, schema, store
        schema.apply()
        cls.ai, cls.store = ai, store

    def setUp(self):
        s = self.store
        self.account = s.q("INSERT INTO accounts (name) VALUES ('test') RETURNING id", one=True)["id"]
        self.addCleanup(lambda: s.q("DELETE FROM accounts WHERE id = %s", (self.account,)))
        self.profile = s.q("INSERT INTO profiles (account_id, name) VALUES (%s, 'p') RETURNING id",
                           (self.account,), one=True)["id"]
        p = mock.patch.object(self.ai, "me", return_value=self.profile)
        p.start()
        self.addCleanup(p.stop)

    def rows(self):
        return self.store.q("SELECT * FROM ai_picks WHERE profile_id = %s ORDER BY id", (self.profile,))

    def test_saved_as_given(self):
        self.ai._answered_by.set("model-a")
        rid = self.ai.save_picks("similar", ["m1", "t2", "m3"], ["t2", "m9", "t2"], seed="m5")
        self.assertTrue(rid)
        [r] = self.rows()
        self.assertEqual((r["request_id"], r["feature"], r["model"], r["seed"], r["query"], r["sent"], r["picks"]),
                         (rid, "similar", "model-a", "m5", None, ["m1", "t2", "m3"], ["t2", "m9", "t2"]))

    def test_search_keeps_what_was_asked(self):
        self.ai.save_picks("search", ["m1"], ["m1"], query="sad films to cry to")
        self.assertEqual(self.rows()[0]["query"], "sad films to cry to")

    def test_not_saved_is_no_id_and_no_error(self):
        with mock.patch.object(self.store, "save_ai_picks", side_effect=RuntimeError("down")), \
                self.assertLogs("nightcap.ai", "ERROR"):
            self.assertIsNone(self.ai.save_picks("home", [], {}))

    def test_old_ones_go(self):
        self.ai.save_picks("home", ["m1"], {"for_you": ["m1"]})
        self.ai.save_picks("home", ["m2"], {"for_you": ["m2"]})
        self.store.q("UPDATE ai_picks SET at = now() - interval '91 days' WHERE id = %s", (self.rows()[0]["id"],))
        self.assertGreaterEqual(self.store.sweep_ai_picks(90), 1)
        self.assertEqual([r["sent"] for r in self.rows()], [["m2"]])

    def test_gone_with_the_profile(self):
        self.ai.save_picks("home", ["m1"], {"for_you": ["m1"]})
        self.store.q("DELETE FROM profiles WHERE id = %s", (self.profile,))
        self.assertEqual(self.rows(), [])

    def test_similar_origin_is_allowed(self):
        rid = uuid.uuid4().hex
        self.store.interaction(self.profile, "tt0000001", "opened", "similar", "similar", 2, rid)
        r = self.store.q("SELECT origin, slot, request_id FROM interactions WHERE profile_id = %s", (self.profile,), one=True)
        self.assertEqual((r["origin"], r["slot"], r["request_id"]), ("similar", 2, rid))


if __name__ == "__main__":
    unittest.main()
