"""My List: its Home row (home.launcher_feed), without a database or the network; and, given a
throwaway database in DATABASE_URL, a film leaving it once finished and its rows moving with a
household (store, moving).

Run from nightcap-server/:  env -u DATABASE_URL TMDB_API_KEY=x .venv/bin/python -m unittest tests.test_mylist
(The database part runs only with DATABASE_URL and SECRETS_KEY set: never point it at a real one,
it adds and removes a household.)
"""

import os
import unittest
import uuid
from unittest import mock

os.environ.setdefault("TMDB_API_KEY", "test")

from nightcap import home  # noqa: E402
from nightcap.context import as_profile  # noqa: E402

PROFILE = "00000000-0000-0000-0000-000000000001"


def picks(prefix, n):
    return [{"id": f"tt{prefix}{i:03d}", "type": "movie"} for i in range(n)]


class HomeRow(unittest.TestCase):
    """Home built from made-up rows: what My List keeps and where it goes."""

    def feed(self, my_list, continue_ids=(), watched=(), top10=(), foryou=None, again=()):
        foryou = picks(9, 10) if foryou is None else foryou
        patches = {
            "home_settings": lambda: {"languages": ["en"], "top10_countries": ["US"], "featured": 0},
            "recs": lambda: {"catalogs": {"foryou": foryou}, "seeds": [], "themes": [], "watched": list(watched)},
            "row_stats": lambda: {},
            "fetch_library": lambda: [],
            "taste": lambda library: ({}, {}, {}),
            "THEMES": [],
            "continue_watching": lambda: [(i, "series", {}) for i in continue_ids],
            "my_list_titles": lambda profile: list(my_list),
            "top10": lambda country, category=None: [(i, "movie") for i in top10] if category == "Films" else [],
            "top10_anime": lambda: [],
            "watch_again_titles": lambda profile: [(i, "movie") for i in again],
            "coming_soon": lambda languages: [],
            "tmdb_languages": lambda languages: languages,
            "feed_item": lambda imdb_id, ctype, **fields: {"id": imdb_id, "type": ctype},
            "note_rows_shown": lambda keys, page=None: None,
            "widgets": lambda: {},
        }
        with as_profile(PROFILE), mock.patch.object(home.store, "not_interested", lambda profile: set()), \
                mock.patch.multiple(home, **patches):
            return {r["id"]: [i["id"] for i in r["items"]] for r in home.launcher_feed()["rows"]}

    def test_right_after_continue_watching(self):
        rows = list(self.feed([("tt1", "movie")], continue_ids=["tt2"]))
        self.assertEqual(rows[:3], ["continue", "mylist", "foryou"])

    def test_one_title_is_enough(self):
        # (Other rows need several titles to show.)
        self.assertEqual(self.feed([("tt1", "movie")])["mylist"], ["tt1"])

    def test_empty_list_no_row(self):
        self.assertNotIn("mylist", self.feed([]))

    def test_started_show_stays_unless_in_continue_watching(self):
        # A show already in the library (watched some) stays; one in Continue watching shows there only.
        rows = self.feed([("tt1", "series"), ("tt2", "series")], continue_ids=["tt2"], watched=["tt1", "tt2"])
        self.assertEqual(rows["mylist"], ["tt1"])
        self.assertEqual(rows["continue"], ["tt2"])

    def test_its_titles_stay_in_the_other_rows(self):
        rows = self.feed([("tt9000", "movie"), ("tt7", "movie")], top10=["tt7", "tt8"])
        self.assertEqual(rows["mylist"], ["tt9000", "tt7"])
        self.assertIn("tt9000", rows["foryou"])
        self.assertIn("tt7", rows["top10:movie"])

    def test_a_watched_film_on_the_list_stays_in_watch_again(self):
        others = [f"tt8{i:03d}" for i in range(8)]
        rows = self.feed([("tt1", "movie")], watched=["tt1"], again=["tt1", *others])
        self.assertEqual(rows["mylist"], ["tt1"])
        self.assertEqual(rows["again"], ["tt1", *others])

    def test_cut_to_a_row(self):
        listed = [(f"tt{i}", "movie") for i in range(1, 40)]
        self.assertEqual(len(self.feed(listed)["mylist"]), home.P.list_size)

    def test_not_dropped_when_too_many_rows(self):
        with mock.patch.object(home.S.home, "rows", 1):
            self.assertIn("mylist", self.feed([("tt1", "movie")]))


@unittest.skipUnless(os.environ.get("DATABASE_URL") and os.environ.get("SECRETS_KEY"), "needs a throwaway database")
class Stored(unittest.TestCase):
    """Against a real (throwaway) database."""

    @classmethod
    def setUpClass(cls):
        from nightcap import schema, store
        schema.apply()
        cls.store = store
        cls.account = store.create_household(f"My List test {uuid.uuid4().hex[:6]}", "Tester", None)
        cls.profile = str(store.profiles(cls.account)[0]["id"])

    @classmethod
    def tearDownClass(cls):
        cls.store.delete_household(cls.account)

    def ids(self):
        return [r["imdb_id"] for r in self.store.my_list(self.profile)]

    def test_add_remove_newest_first(self):
        s, p = self.store, self.profile
        s.set_my_list(p, "tt0000101", "movie", True)
        s.set_my_list(p, "tt0000102", "series", True)
        s.set_my_list(p, "tt0000101", "movie", True)   # again: harmless, keeps its place
        self.assertEqual(self.ids()[:2], ["tt0000102", "tt0000101"])
        self.assertTrue(s.in_my_list(p, "tt0000101"))
        s.set_my_list(p, "tt0000101", "movie", False)
        s.set_my_list(p, "tt0000102", "series", False)
        self.assertFalse(s.in_my_list(p, "tt0000101"))

    def test_finished_film_leaves_show_stays(self):
        s, p = self.store, self.profile
        s.set_my_list(p, "tt0000201", "movie", True)
        s.set_my_list(p, "tt0000202", "series", True)
        s.save_progress(p, "movie", "tt0000201", 10_000, 100_000)          # started: stays
        self.assertIn("tt0000201", self.ids())
        s.save_progress(p, "movie", "tt0000201", 95_000, 100_000)          # finished: leaves
        s.save_progress(p, "series", "tt0000202:1:1", 95_000, 100_000)     # an episode finished: stays
        self.assertNotIn("tt0000201", self.ids())
        self.assertIn("tt0000202", self.ids())
        s.set_my_list(p, "tt0000203", "movie", True)
        s.mark_watched(p, "movie", "tt0000203")
        s.mark_watched(p, "series", "tt0000202:1:2")
        self.assertNotIn("tt0000203", self.ids())
        self.assertIn("tt0000202", self.ids())
        s.set_my_list(p, "tt0000202", "series", False)

    def test_moves_with_the_household(self):
        from nightcap import moving
        s, p = self.store, self.profile
        s.save_title({**s.blank_title("tt0000301", "movie"), "name": "Listed Only"}, [])
        s.set_my_list(p, "tt0000301", "movie", True)
        locked, _ = moving.export([self.account], "a long enough password")
        s.q("DELETE FROM titles WHERE imdb_id = 'tt0000301'")
        out = moving.import_file(locked, "a long enough password", replace=True)
        self.assertEqual(out[0]["status"], "replaced")
        self.assertIn("tt0000301", self.ids())
        # Its card came too (only on the list: not in the library or history).
        self.assertEqual(s.title("tt0000301")["name"], "Listed Only")


if __name__ == "__main__":
    unittest.main()
