"""A watched title's saved details are looked up again a week after they were saved (TMDB's get fixed:
a show saved with a wrong name, "Telugu", would otherwise keep it), without losing them when TMDB then has nothing.

Run from nightcap-server/ with a throwaway database in DATABASE_URL and SECRETS_KEY (never a real
one: it adds and removes a household and some titles):  .venv/bin/python -m unittest tests.test_titlerecheck
(This test's titles are saved years ago, so they're looked at before any other the database has.)
"""

import contextlib
import os
import unittest
import uuid
from unittest import mock

os.environ.setdefault("TMDB_API_KEY", "test")

IDS = ("tt0000901", "tt0000902", "tt0000903", "tt0000904", "tt0000905")
LONG_AGO = 5000   # days


class Inline:
    """A thread that runs at once."""
    def __init__(self, target, **kwargs):
        self.target = target

    def start(self):
        self.target()


@unittest.skipUnless(os.environ.get("DATABASE_URL") and os.environ.get("SECRETS_KEY"), "needs a throwaway database")
class Recheck(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        from nightcap import schema, store, titles
        schema.apply()
        cls.store, cls.titles = store, titles
        cls.account = store.create_household(f"Recheck test {uuid.uuid4().hex[:6]}", "Tester", None)
        cls.profile = str(store.profiles(cls.account)[0]["id"])

    @classmethod
    def tearDownClass(cls):
        cls.store.delete_household(cls.account)
        cls.store.q("DELETE FROM episodes WHERE imdb_id = ANY(%s)", (list(IDS),))
        cls.store.q("DELETE FROM titles WHERE imdb_id = ANY(%s)", (list(IDS),))

    def setUp(self):
        self.store.q("DELETE FROM library WHERE profile_id = %s", (self.profile,))
        self.store.q("DELETE FROM episodes WHERE imdb_id = ANY(%s)", (list(IDS),))
        self.store.q("DELETE FROM titles WHERE imdb_id = ANY(%s)", (list(IDS),))

    def title(self, imdb_id, name, saved_days_ago=LONG_AGO, tmdb_id=None):
        self.store.q("""INSERT INTO titles (imdb_id, type, tmdb_id, name, updated_at)
                        VALUES (%s, 'series', %s, %s, now() - make_interval(days => %s))""",
                     (imdb_id, tmdb_id, name, saved_days_ago))

    def watched(self, imdb_id, days_ago=1):
        self.store.q("""INSERT INTO library (profile_id, imdb_id, type, last_watched_at)
                        VALUES (%s, %s, 'series', now() - make_interval(days => %s))""", (self.profile, imdb_id, days_ago))

    def episode(self, **fields):
        return {"video_id": f"{IDS[4]}:1:1", "imdb_id": IDS[4], "season": 1, "episode": 1, "name": "One",
                "overview": "story", "still": "pic", "released": "2025-10-10", "rating": 7.5, **fields}

    def saved_episode(self):
        return self.store.q("SELECT overview, still, released::date::text, rating::float FROM episodes WHERE video_id = %s",
                            (f"{IDS[4]}:1:1",), one=True)

    def due(self):
        """This test's titles that are missing or due to be looked at again (without claiming them)."""
        return sorted(r["imdb_id"] for r in self.store.q(
            """SELECT l.imdb_id FROM library l LEFT JOIN titles t USING (imdb_id)
               WHERE l.imdb_id = ANY(%s) AND (t.imdb_id IS NULL OR (t.updated_at < now() - interval '7 days'
                                                                     AND l.last_watched_at > t.updated_at))""",
            (list(IDS),)))

    def found(self, **fields):
        return {**self.store.blank_title(IDS[4], "series"), "tmdb_id": 300894, **fields}

    def fill(self, found, episodes=lambda imdb_id, tmdb_id: []):
        """Brings the titles up to date (looking again here, not in the background) with TMDB answering
        [found] for IDS[4] and nothing for any other ([found] may also be a function)."""
        row = found if callable(found) else (lambda imdb_id, ctype, tmdb_id=None: found if imdb_id == IDS[4] else None)
        with mock.patch.object(self.titles, "title_row", row), mock.patch.object(self.titles, "episode_rows", episodes), \
                mock.patch.object(self.titles, "fresh_match", lambda imdb_id, ctype: 300894), self.ours():
            self.titles.fill_missing_titles()

    def ours(self):
        """Looking again in the foreground, and filling only this test's missing titles."""
        stack = contextlib.ExitStack()
        missing = self.store.missing_titles
        stack.enter_context(mock.patch.object(self.titles.threading, "Thread", Inline))
        stack.enter_context(mock.patch.object(self.store, "missing_titles",
                                              lambda: [x for x in missing() if x[0] in IDS]))
        return stack

    # ---- Which are looked at

    def test_which_are_looked_at(self):
        self.watched(IDS[0])                                       # never saved
        self.title(IDS[1], "Old"); self.watched(IDS[1])            # saved long ago, watched since
        self.title(IDS[2], "Old"); self.watched(IDS[2], LONG_AGO + 10)   # not watched since it was saved
        self.title(IDS[3], "New", 2); self.watched(IDS[3])         # saved this week
        self.assertEqual(self.due(), [IDS[0], IDS[1]])

    def test_a_few_at_once_oldest_first_and_claimed(self):
        for i, extra in zip(IDS[1:4], (0, 20, 10)):
            self.title(i, "Old", LONG_AGO + extra); self.watched(i)
        self.assertEqual(sorted(i for i, _ in self.store.claim_rechecks(7, 2)), [IDS[2], IDS[3]])
        self.assertEqual(self.due(), [IDS[1]])   # (the claimed ones wait their week, on every server)

    # ---- Looking again

    def test_a_fixed_name_replaces_the_saved_one(self):
        self.title(IDS[4], "Telugu", tmdb_id=300894); self.watched(IDS[4])
        self.fill(self.found(name="Kurukshetra"))
        self.assertEqual(self.store.title(IDS[4])["name"], "Kurukshetra")
        self.assertEqual(self.due(), [])

    def test_one_tmdb_no_longer_knows_keeps_what_was_saved(self):
        self.title(IDS[4], "Kurukshetra"); self.watched(IDS[4])
        self.fill(None)
        self.assertEqual(self.store.title(IDS[4])["name"], "Kurukshetra")
        self.assertEqual(self.due(), [])

    def test_tmdb_details_gone_keeps_what_was_saved(self):
        # (The real title_row: TMDB's match answers 404.)
        self.title(IDS[4], "Kurukshetra"); self.watched(IDS[4])
        with mock.patch.object(self.titles, "fresh_match", lambda imdb_id, ctype: 300894), \
                mock.patch.object(self.titles, "tmdb", lambda path, **params: None), self.ours():
            self.titles.fill_missing_titles()
        self.assertEqual(self.store.title(IDS[4])["name"], "Kurukshetra")
        self.assertEqual(self.due(), [])

    def test_a_new_one_tmdb_doesnt_know_is_saved_blank(self):
        self.watched(IDS[4])
        self.fill(None)
        self.assertIsNone(self.store.title(IDS[4])["name"])
        self.assertEqual(self.due(), [])

    def test_a_failed_lookup_ends_the_round_and_waits_its_week(self):
        for i, extra in zip(IDS[1:4], (30, 20, 10)):
            self.title(i, "Old", LONG_AGO + extra); self.watched(i)
        asked = []

        def fails(path, **params):
            asked.append(path)
            raise OSError("TMDB is down")
        dropped = []
        with mock.patch.object(self.titles, "tmdb", fails), self.ours(), \
                mock.patch.object(self.titles.cache, "drop", dropped.append):
            self.titles.fill_missing_titles()
        self.assertEqual(len(asked), 1)
        self.assertEqual(dropped, [])   # (TMDB's kept match stays for everything else)
        self.assertEqual([self.store.title(i)["name"] for i in IDS[1:4]], ["Old"] * 3)
        self.assertEqual(self.due(), [])   # (all three were claimed: they wait their week)

    def test_a_save_that_fails_doesnt_stop_the_others(self):
        self.title(IDS[3], "Old", LONG_AGO + 10, tmdb_id=1); self.watched(IDS[3])
        self.title(IDS[4], "Telugu", tmdb_id=300894); self.watched(IDS[4])
        rows = {IDS[3]: {**self.found(name="Bad", tmdb_id=1), "imdb_id": IDS[3], "release_date": "not a date"},
                IDS[4]: self.found(name="Kurukshetra")}
        self.fill(lambda imdb_id, ctype, tmdb_id=None: rows.get(imdb_id),
                  episodes=lambda imdb_id, tmdb_id: [self.episode(video_id=f"{imdb_id}:1:1", imdb_id=imdb_id)])
        self.assertEqual((self.store.title(IDS[3])["name"], self.store.title(IDS[4])["name"]), ("Old", "Kurukshetra"))
        self.assertEqual(self.due(), [])

    def test_another_tmdb_title_without_its_episodes_isnt_saved(self):
        self.store.save_title(self.found(name="Wrong show"), [self.episode()])
        self.store.q("UPDATE titles SET updated_at = now() - make_interval(days => %s) WHERE imdb_id = %s",
                     (LONG_AGO, IDS[4]))
        self.watched(IDS[4])
        self.fill(self.found(tmdb_id=1, name="Kurukshetra"))   # (Cinemeta gave no episodes)
        self.assertEqual(self.due(), [])                       # (it was looked at)
        self.assertEqual(self.store.title(IDS[4])["name"], "Wrong show")
        self.assertEqual(self.saved_episode()["still"], "pic")

    def test_a_blank_one_tmdb_now_knows_is_filled_even_without_episodes(self):
        self.title(IDS[4], None); self.watched(IDS[4])
        self.fill(self.found(name="Kurukshetra"))
        self.assertEqual(self.store.title(IDS[4])["name"], "Kurukshetra")

    # ---- Saving again

    def test_a_name_without_pictures_keeps_the_saved_ones(self):
        row = self.found(name="Kurukshetra", poster="p", backdrop="b", overview="o")
        self.store.save_title(row, [])
        self.store.save_title({**row, "name": "Kurukshetra 2", "poster": None, "backdrop": None, "overview": None}, [])
        got = self.store.title(IDS[4])
        self.assertEqual((got["name"], got["poster"], got["backdrop"], got["overview"]), ("Kurukshetra 2", "p", "b", "o"))

    def test_another_tmdb_title_takes_none_of_the_old_ones_pictures(self):
        self.store.save_title(self.found(name="Wrong show", poster="p", backdrop="b", overview="o"), [])
        self.store.save_title(self.found(tmdb_id=1, name="Kurukshetra"), [])
        got = self.store.title(IDS[4])
        self.assertEqual((got["name"], got["poster"], got["backdrop"], got["overview"]), ("Kurukshetra", None, None, None))

    def test_an_episode_tmdb_leaves_out_keeps_what_was_saved(self):
        self.store.save_title(self.found(name="Kurukshetra"), [self.episode()])
        self.store.save_title(self.found(name="Kurukshetra"),
                              [self.episode(overview=None, still=None, released=None, rating=None)])
        got = self.saved_episode()
        self.assertEqual((got["overview"], got["still"], got["released"], got["rating"]),
                         ("story", "pic", "2025-10-10", 7.5))

    def test_another_tmdb_title_takes_none_of_the_old_episode_pictures(self):
        self.store.save_title(self.found(name="Wrong show"), [self.episode()])
        self.store.save_title(self.found(tmdb_id=1, name="Kurukshetra"), [])   # (not even for episodes not given)
        got = self.saved_episode()
        self.assertEqual((got["still"], got["rating"]), (None, None))


if __name__ == "__main__":
    unittest.main()
