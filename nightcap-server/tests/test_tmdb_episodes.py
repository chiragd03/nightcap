"""A daily show's newer episodes from TMDB when Cinemeta's list lags (http.with_tmdb_episodes).

Run from nightcap-server/:  env -u DATABASE_URL TMDB_API_KEY=x .venv/bin/python -m unittest tests.test_tmdb_episodes
"""

import os
import time
import unittest
from unittest import mock

os.environ.setdefault("TMDB_API_KEY", "test")

from nightcap import http  # noqa: E402


def meta(*eps):
    return {"id": "tt1", "type": "series", "moviedb_id": 9,
            "videos": [{"id": f"tt1:{s}:{e}", "season": s, "episode": e, "released": f"2026-11-{e:02d}T00:00:00.000Z"} for s, e in eps]}


def season(*numbers):
    return {"episodes": [{"episode_number": n, "air_date": f"2026-11-{n:02d}", "name": f"Day {n}"} for n in numbers]}


class TmdbEpisodes(unittest.TestCase):
    def setUp(self):
        # (No cache here: the lookup itself.)
        patcher = mock.patch.object(http, "cached", side_effect=lambda key, fn, ttl=None: fn())
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_later_episodes_added(self):
        with mock.patch.object(http, "tmdb", return_value=season(1, 2, 3, 4)):
            out = http.with_tmdb_episodes(meta((1, 1), (1, 2)))
        self.assertEqual([v["id"] for v in out["videos"]], ["tt1:1:1", "tt1:1:2", "tt1:1:3", "tt1:1:4"])
        self.assertEqual(out["videos"][2]["released"], "2026-11-03T00:00:00.000Z")

    def test_other_numbering_left_alone(self):
        # TMDB doesn't have an episode Cinemeta has: they number it differently.
        with mock.patch.object(http, "tmdb", return_value=season(1, 2, 3)):
            out = http.with_tmdb_episodes(meta((1, 1), (1, 7)))
        self.assertEqual(len(out["videos"]), 2)

    def test_only_the_latest_season(self):
        with mock.patch.object(http, "tmdb", return_value=season(1, 2, 3)) as t:
            out = http.with_tmdb_episodes(meta((1, 1), (2, 1)))
        t.assert_called_once_with("/tv/9/season/2")
        self.assertEqual([v["id"] for v in out["videos"]][-2:], ["tt1:2:2", "tt1:2:3"])

    def test_tmdb_failing_keeps_cinemeta(self):
        with mock.patch.object(http, "tmdb", side_effect=OSError("down")):
            out = http.with_tmdb_episodes(meta((1, 1)))
        self.assertEqual(len(out["videos"]), 1)

    def test_split_finale_left_alone(self):
        # TMDB dates Cinemeta's last episode days away: the season is cut differently.
        with mock.patch.object(http, "tmdb", return_value={"episodes": [
                {"episode_number": 1, "air_date": "2026-11-01"}, {"episode_number": 2, "air_date": "2026-11-20"},
                {"episode_number": 3, "air_date": "2026-11-21"}]}):
            out = http.with_tmdb_episodes(meta((1, 1), (1, 2)))
        self.assertEqual(len(out["videos"]), 2)

    def test_stops_at_an_undated_episode(self):
        with mock.patch.object(http, "tmdb", return_value={"episodes": [
                {"episode_number": 1, "air_date": "2026-11-01"}, {"episode_number": 2},
                {"episode_number": 3, "air_date": "2026-11-03"}]}):
            out = http.with_tmdb_episodes(meta((1, 1)))
        self.assertEqual(len(out["videos"]), 1)

    def test_films_untouched(self):
        with mock.patch.object(http, "tmdb") as t:
            http.with_tmdb_episodes({"id": "tt2", "type": "movie", "moviedb_id": 3})
        t.assert_not_called()


class OutOnItsDay(unittest.TestCase):
    """An episode with only an air date counts as out once its day has ended (UTC), or earlier once
    a look found sources for it (episodes.is_out, playback.waiting_for_sources)."""

    TODAY = {"id": "tt1281973:20:71", "season": 20, "episode": 71, "released": "2026-11-15T00:00:00.000Z"}
    TOMORROW = {"id": "tt1281973:20:72", "season": 20, "episode": 72, "released": "2026-11-16T00:00:00.000Z"}
    NOW = "2026-11-15T22:00:00"
    MORNING = "2026-11-15T08:00:00"

    def out(self, v, found, now=NOW, times=None):
        from nightcap import episodes
        with mock.patch.object(episodes, "sources_known", return_value=found), \
                mock.patch.object(episodes, "airtimes_cached", return_value=times):
            return episodes.is_out(v, now)

    def test_on_its_day_out_only_once_sources_were_found(self):
        self.assertFalse(self.out(self.TODAY, None))
        self.assertFalse(self.out(self.TODAY, False))
        self.assertFalse(self.out(self.TODAY, "some"))
        self.assertTrue(self.out(self.TODAY, "verified"))

    def test_not_before_its_day_whatever_was_found(self):
        self.assertFalse(self.out(self.TOMORROW, "verified"))
        # Nor in the first hours of its day (UTC).
        self.assertFalse(self.out(self.TODAY, "verified", now=self.MORNING))

    def test_a_known_broadcast_time_is_kept_to(self):
        # TVmaze's time for it (ends 2026-11-16 02:00 UTC): not out before, whatever was found.
        times = {"20:71": ["2026-11-15", "2026-11-16T02:00:00"]}
        self.assertFalse(self.out(self.TODAY, "verified", times=times))
        self.assertTrue(self.out(self.TODAY, None, now="2026-11-16T02:00:00", times=times))

    def test_out_by_the_clock_without_a_look(self):
        from nightcap import episodes
        with mock.patch.object(episodes, "sources_known") as known, \
                mock.patch.object(episodes, "airtimes_cached", return_value=None):
            self.assertTrue(episodes.is_out(self.TODAY, "2026-11-16T00:00:00"))
        known.assert_not_called()

    def test_without_a_profile_nothing_is_found(self):
        from nightcap import episodes
        self.assertIsNone(episodes.sources_known(self.TODAY["id"]))

    def waiting(self, v, known):
        # (Out later today, by the clock: it's on its air day, looked for early.)
        def in_two_hours():
            return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() + 7200))
        from nightcap import playback
        due = set()
        with mock.patch.object(playback, "sources_known", return_value=known), \
                mock.patch.object(playback, "early", side_effect=lambda x: x is self.TODAY), \
                mock.patch.object(playback, "is_out", return_value=False), \
                mock.patch.object(playback, "out_at", return_value=in_two_hours()):
            token = playback._due.set(due)
            try:
                return playback.waiting_for_sources(v), due
            finally:
                playback._due.reset(token)

    def test_on_its_day_its_sources_are_looked_for(self):
        self.assertEqual(self.waiting(self.TODAY, None), (True, {self.TODAY["id"]}))
        self.assertEqual(self.waiting(self.TODAY, False), (True, set()))
        self.assertEqual(self.waiting(self.TODAY, "some"), (False, set()))
        self.assertEqual(self.waiting(self.TODAY, "verified"), (False, set()))
        self.assertEqual(self.waiting(self.TOMORROW, None), (False, set()))


class OutEarlyInContinueWatching(unittest.TestCase):
    """A followed show's episode found playable early: in Continue watching with "+1", although the
    count runs on other threads (home.continue_watching)."""

    def test_the_card_shows_with_its_new_episode(self):
        from datetime import datetime, timezone
        from nightcap import context, episodes, home
        ep70 = {"id": "tt1281973:20:70", "season": 20, "episode": 70, "released": "2026-11-14T00:00:00.000Z"}
        ep71 = {"id": "tt1281973:20:71", "season": 20, "episode": 71, "released": "2026-11-15T00:00:00.000Z"}
        meta = {"name": "Bigg Boss", "videos": [ep70, ep71]}
        row = {"imdb_id": "tt1281973", "type": "series", "current_video_id": ep70["id"], "position_ms": 0,
               "duration_ms": 0, "watched": False, "notify": True, "continue_hidden_at": None, "name": "Bigg Boss",
               "poster": None, "last_watched_at": datetime(2026, 11, 15, 2, tzinfo=timezone.utc)}
        found = {}

        def known(vid):
            # (Found for this profile only: none without one, as on a thread that lost it.)
            return found.get((context.me(), vid))
        # (22:00 UTC on episode 71's day: early, not out by the clock.)
        clock = mock.Mock(strftime=lambda f, t=None: "2026-11-15T22:00:00", gmtime=lambda *a: None)
        with mock.patch.object(home, "me", return_value="p1"), \
                mock.patch.object(home.store, "library", return_value=[row]), \
                mock.patch.object(home.store, "ticks", return_value={ep70["id"]}), \
                mock.patch.object(episodes, "cinemeta", return_value=meta), \
                mock.patch.object(home, "next_unwatched", side_effect=lambda i, c, w: ep71), \
                mock.patch.object(home, "next_episode", side_effect=lambda vid: ep71 if vid == ep70["id"] else None), \
                mock.patch.object(home, "due_now", return_value=False), \
                mock.patch.object(home, "episode_out", return_value=True), \
                mock.patch.object(home, "waiting_for_sources", return_value=False), \
                mock.patch.object(episodes, "airtimes_cached", return_value=None), \
                mock.patch.object(episodes, "sources_known", side_effect=known), \
                mock.patch.object(episodes, "time", clock):
            token = context._profile.set("p1")
            try:
                self.assertEqual(home.continue_watching(), [])
                found[("p1", ep71["id"])] = "verified"
                rows = home.continue_watching()
            finally:
                context._profile.reset(token)
        self.assertEqual([(r[0], r[2]["videoId"], r[2]["newEpisodes"]) for r in rows], [("tt1281973", ep71["id"], 1)])


class UnverifiedAskedAgain(unittest.TestCase):
    """A list with no source known to be the episode is kept 2 minutes, not 20 (playback.ask_again);
    what a new episode's look found is kept as "verified" or "some" (playback.look_for_sources)."""

    VID = "tt1281973:20:71"
    HD = {"filename": "HD Server 1", "direct": True, "url": "https://a/1"}
    UNNAMED = {"filename": "", "url": "https://b/2"}
    EP71 = {"filename": "Bigg Boss S20E71 1080p", "url": "https://c/3"}

    def again(self, streams, age):
        import time as t
        from nightcap import playback
        return playback.ask_again([t.time() - age, (streams, [], True)], self.VID, ["Bigg Boss"])

    def test_none_verified_is_asked_again_after_two_minutes(self):
        self.assertFalse(self.again([self.HD, self.UNNAMED], 60))
        self.assertTrue(self.again([self.HD, self.UNNAMED], 180))

    def test_a_verified_list_is_kept(self):
        self.assertFalse(self.again([self.HD, self.UNNAMED, self.EP71], 600))

    def test_only_extras_is_asked_again_as_before(self):
        self.assertTrue(self.again([dict(self.EP71, direct=True)], 180))

    def look(self, streams):
        from nightcap import playback
        put = {}
        with mock.patch.object(playback, "cached", return_value=(streams, [], True)), \
                mock.patch.object(playback, "title_names", return_value=["Bigg Boss"]), \
                mock.patch.object(playback, "ready_key", side_effect=lambda v: "ready:" + v), \
                mock.patch.object(playback, "play_key", side_effect=lambda v: "play:" + v), \
                mock.patch.object(playback.cache, "drop"), \
                mock.patch.object(playback.cache, "put", side_effect=lambda k, v, at=None: put.update({k: v})):
            return playback.look_for_sources(self.VID), put["ready:" + self.VID]

    def test_what_a_look_found_is_kept(self):
        # Out by the clock any sources will do (files named by date); early only a verified one.
        self.assertEqual(self.look([self.HD, self.UNNAMED]), (True, "some"))
        self.assertEqual(self.look([self.HD, self.EP71]), (True, "verified"))
        self.assertEqual(self.look([]), (False, False))


class EarlySomeLookedForAgain(unittest.TestCase):
    """Early on its air day, unnamed links ("some") don't settle an episode: it's looked for again
    after half an hour, until a verified source turns up; once it's out by the clock they do."""

    def known(self, ready, age, early):
        import time as t
        from nightcap import episodes
        with mock.patch.object(episodes, "ready_key", return_value="k"), \
                mock.patch.object(episodes.cache, "get", return_value=[t.time() - age, ready]):
            return episodes.sources_known("tt1281973:20:71", early=early)

    def test_early_some_expires_verified_stays(self):
        self.assertEqual(self.known("some", 60, True), "some")
        self.assertIsNone(self.known("some", 3600, True))
        self.assertEqual(self.known("verified", 3600, True), "verified")

    def test_out_by_the_clock_some_stays(self):
        self.assertEqual(self.known("some", 86400, False), "some")
        self.assertIsNone(self.known(False, 3600, False))


if __name__ == "__main__":
    unittest.main()
