"""What the server remembers about following a household's links (linkstate.py) and how AIOStreams'
error videos are read (playlinks._from_clip), without the network.

Run from nightcap-server/:  env -u DATABASE_URL TMDB_API_KEY=x .venv/bin/python -m unittest tests.test_linkstate
"""

import os
import unittest
from unittest import mock

os.environ.setdefault("TMDB_API_KEY", "test")
os.environ.setdefault("SECRETS_KEY", "test-secret")

from nightcap import linkstate, playlinks  # noqa: E402


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


class Windows(unittest.TestCase):
    def setUp(self):
        linkstate.clear()
        self.clock = Clock()
        self.patch = mock.patch.object(linkstate, "_now", self.clock)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()

    def test_a_429_window_steps_up_once_per_window_and_resets_on_success(self):
        t0 = self.clock.t
        self.assertEqual(linkstate.saw_429("a", "servicea", "debrid", t0), t0 + 10)
        # Four at once (begun before the window opened): one step only.
        for _ in range(3):
            self.assertEqual(linkstate.saw_429("a", "servicea", "debrid", t0 - 1), t0 + 10)
        self.clock.t += 11
        self.assertEqual(linkstate.saw_429("a", "servicea", "debrid", self.clock.t), self.clock.t + 60)
        self.clock.t += 61
        self.assertEqual(linkstate.saw_429("a", "servicea", "debrid", self.clock.t), self.clock.t + 120)
        linkstate.worked("a", "servicea", "debrid")
        self.assertEqual(linkstate.busy_until("a", "servicea", "debrid"), 0)
        self.assertEqual(linkstate.saw_429("a", "servicea", "debrid", self.clock.t), self.clock.t + 10)

    def test_windows_are_per_household_service_and_type(self):
        linkstate.saw_429("a", "servicea", "usenet", self.clock.t)
        self.assertGreater(linkstate.busy_until("a", "servicea", "usenet"), 0)
        self.assertEqual(linkstate.busy_until("a", "servicea", "debrid"), 0)
        self.assertEqual(linkstate.busy_until("a", "serviceb", "usenet"), 0)
        self.assertEqual(linkstate.busy_until("b", "servicea", "usenet"), 0)

    def test_the_window_is_capped_at_ten_minutes(self):
        for _ in range(10):
            until = linkstate.saw_429("a", "servicea", "debrid", self.clock.t)
            self.clock.t = until + 0.5
        self.assertLessEqual(until - (self.clock.t - 0.5), 600)

    def test_usenet_counts_keep_a_share_for_opens(self):
        for _ in range(linkstate.USENET_GUESSES):
            self.assertEqual(linkstate.count("a", "servicea", "usenet", guess=True), 0)
        self.assertGreater(linkstate.count("a", "servicea", "usenet", guess=True), 0)
        for _ in range(linkstate.USENET_PER_HOUR - linkstate.USENET_GUESSES):
            self.assertEqual(linkstate.count("a", "servicea", "usenet"), 0)
        self.assertGreater(linkstate.count("a", "servicea", "usenet"), 0)
        # Torrents of the same service, and another household, aren't held back.
        self.assertEqual(linkstate.count("a", "servicea", "debrid"), 0)
        self.assertEqual(linkstate.count("b", "servicea", "usenet"), 0)

    def test_three_files_failing_at_once_is_the_service(self):
        self.assertFalse(linkstate.failed_download("a", "servicea", "k1"))
        self.assertFalse(linkstate.failed_download("a", "servicea", "k2"))
        self.assertTrue(linkstate.failed_download("a", "servicea", "k3"))
        self.clock.t += 200
        self.assertFalse(linkstate.failed_download("a", "servicea", "k4"))


class Clips(unittest.TestCase):
    def setUp(self):
        linkstate.clear()

    def follow(self, kind="debrid"):
        return playlinks.Follow("acc", "servicea", kind, "key", "AIOStreams")

    def test_how_each_clip_is_read(self):
        f = self.follow()
        self.assertIsInstance(playlinks._from_clip("no_matching_file", f), playlinks.Gone)
        self.assertIsInstance(playlinks._from_clip("downloading", f), playlinks.Preparing)
        r = playlinks._from_clip("payment_required", self.follow("usenet"))
        self.assertIsInstance(r, playlinks.Refused)
        self.assertEqual((r.service, r.kind, r.why), ("servicea", "usenet", "plan"))
        self.assertTrue(linkstate.refused("acc", "servicea", "usenet"))
        self.assertFalse(linkstate.refused("acc", "servicea", "debrid"))
        self.assertEqual(playlinks._from_clip("401", f).why, "key")
        b = playlinks._from_clip("429", f)
        self.assertIsInstance(b, playlinks.Busy)
        self.assertGreater(b.until, 0)
        # Not the file's: "500" and clips this version doesn't know.
        for clip in ("500", "something_new"):
            r = playlinks._from_clip(clip, f)
            self.assertIs(type(r), playlinks.Unavailable)

    def test_the_same_file_twice_is_still_the_files(self):
        f = self.follow()
        self.assertIs(type(playlinks._from_clip("403", f)), playlinks.Unavailable)
        self.assertIs(type(playlinks._from_clip("403", f)), playlinks.Unavailable)
        other = playlinks.Follow("acc", "servicea", "debrid", "another", "AIOStreams")
        self.assertIsInstance(playlinks._from_clip("403", other), playlinks.Refused)

    def test_the_first_403_or_store_limit_is_the_files_the_second_the_accounts(self):
        f = self.follow()
        g = playlinks.Follow("acc", "servicea", "debrid", "key2", "AIOStreams")
        self.assertIs(type(playlinks._from_clip("403", f)), playlinks.Unavailable)
        self.assertEqual(playlinks._from_clip("403", g).why, "limit")
        self.assertIs(type(playlinks._from_clip("store_limit_exceeded", f)), playlinks.Unavailable)
        self.assertIsInstance(playlinks._from_clip("store_limit_exceeded", g), playlinks.Refused)
        u = self.follow("usenet")
        playlinks._from_clip("store_limit_exceeded", u)
        b = playlinks._from_clip("store_limit_exceeded", playlinks.Follow("acc", "servicea", "usenet", "key3", "AIOStreams"))
        self.assertIsInstance(b, playlinks.Busy)
        self.assertEqual(b.kind, "usenet")

    def test_download_failed_from_many_files_is_not_the_files(self):
        for k in ("k1", "k2"):
            self.assertIsInstance(playlinks._from_clip("download_failed", playlinks.Follow("acc", "servicea", "debrid", k)), playlinks.Gone)
        r = playlinks._from_clip("download_failed", playlinks.Follow("acc", "servicea", "debrid", "k3"))
        self.assertIs(type(r), playlinks.Unavailable)

    def test_without_a_household_a_clip_is_never_the_accounts(self):
        self.assertIs(type(playlinks._from_clip("401", None)), playlinks.Unavailable)
        self.assertIsInstance(playlinks._from_clip("no_matching_file", None), playlinks.Gone)


class Memory(unittest.TestCase):
    """Answers given from memory, and households kept apart."""
    row = '{"v": "tt1", "l": [{"u": "https://aio/x", "k": "K", "s": "servicea", "t": "debrid", "a": "AIOStreams"}]}'

    def setUp(self):
        linkstate.clear()
        playlinks._resolved.clear()

    def test_a_busy_window_is_said_from_memory_only_to_a_newer_player(self):
        linkstate.saw_429("acc", "servicea", "debrid", 0)
        linkstate._windows[("acc", "servicea", "debrid")].until += 100
        with mock.patch.object(playlinks.store, "play_link_row", return_value=(self.row, "acc")), \
                mock.patch.object(playlinks, "_follow", return_value="https://debrid/a") as follow:
            with self.assertRaises(playlinks.Busy):
                playlinks.where("t" * 32, 0, newer=True)
            follow.assert_not_called()
            # An older player gets a real follow.
            self.assertEqual(playlinks.where("t" * 32, 0), ("https://debrid/a", False))

    def test_a_resolved_file_is_answered_even_in_a_window(self):
        with mock.patch.object(playlinks.store, "play_link_row", return_value=(self.row, "acc")), \
                mock.patch.object(playlinks, "_follow", return_value="https://debrid/a"):
            playlinks.where("t" * 32, 0, newer=True)
            linkstate.saw_429("acc", "servicea", "debrid", 0)
            self.assertEqual(playlinks.where("t" * 32, 0, newer=True), ("https://debrid/a", False))

    def test_two_households_never_share_a_resolved_address(self):
        with mock.patch.object(playlinks, "_follow", side_effect=["https://debrid/A", "https://debrid/B"]):
            with mock.patch.object(playlinks.store, "play_link_row", return_value=(self.row, "acc-A")):
                self.assertEqual(playlinks.where("a" * 32, 0)[0], "https://debrid/A")
            with mock.patch.object(playlinks.store, "play_link_row", return_value=(self.row, "acc-B")):
                self.assertEqual(playlinks.where("b" * 32, 0)[0], "https://debrid/B")


class Sightings(unittest.TestCase):
    """A file that looked gone is written down once another file of its service works (then it was the
    file, not an outage), and never when that says nothing about the file."""
    def setUp(self):
        linkstate.clear()
        playlinks._resolved.clear()

    def entry(self, key, service="servicea", extra=""):
        return '{"u": "https://aio/%s", "k": "%s", "s": "%s", "t": "debrid", "a": "AIOStreams"%s}' % (key, key, service, extra)

    def gone(self, entry):
        row = '{"v": "tt1:1:2", "l": [%s]}' % entry
        with mock.patch.object(playlinks.store, "play_link_row", return_value=(row, "acc")), \
                mock.patch.object(playlinks, "_follow", side_effect=playlinks.Gone()):
            with self.assertRaises(playlinks.Gone):
                playlinks.where("t" * 32, 0, newer=True)

    def works(self, service="servicea"):
        with mock.patch.object(playlinks.store, "record_sighting") as record:
            playlinks._write_sightings("acc", linkstate.worked("acc", service, "debrid"))
        return record

    def test_dead_files_are_written_once_another_works(self):
        for k in ("A", "B", "C"):
            self.gone(self.entry(k))
        record = self.works()
        self.assertEqual(sorted(c.args[3] for c in record.call_args_list), ["A", "B", "C"])
        self.assertEqual(record.call_args_list[0].args[:3], ("acc", "tt1:1:2", "AIOStreams"))
        # (Written once: a later success doesn't write them again.)
        self.works().assert_not_called()

    def test_a_file_never_writes_down_its_own_failure(self):
        self.gone(self.entry("A"))
        self.gone(self.entry("B"))
        follow = playlinks.Follow("acc", "servicea", "debrid", "A", "AIOStreams")
        response = mock.MagicMock()
        response.__enter__.return_value = response
        with mock.patch.object(playlinks._opener, "open", return_value=response), \
                mock.patch.object(playlinks, "_a_file", return_value=False), \
                mock.patch.object(playlinks._writes, "submit") as submit:
            playlinks._follow("https://aio/A", follow)
        self.assertEqual([h[2] for h in submit.call_args.args[2]], ["B"])

    def test_an_outage_writes_nothing(self):
        for k in ("A", "B", "C"):
            self.gone(self.entry(k))
        linkstate._held[("acc", "servicea")] = [(t - linkstate.HELD_S - 1, w) for t, w in linkstate._held[("acc", "servicea")]]
        self.works().assert_not_called()

    def test_another_service_working_says_nothing(self):
        self.gone(self.entry("A"))
        self.works("serviceb").assert_not_called()

    def test_only_gone_counts(self):
        row = '{"v": "tt1:1:2", "l": [%s]}' % self.entry("A")
        for error in (playlinks.Unavailable(), playlinks.Preparing()):
            with mock.patch.object(playlinks.store, "play_link_row", return_value=(row, "acc")), \
                    mock.patch.object(playlinks, "_follow", side_effect=error):
                with self.assertRaises(playlinks.Unavailable):
                    playlinks.where("t" * 32, 0, newer=True)
        self.works().assert_not_called()

    def test_not_a_file_not_downloaded(self):
        self.gone(self.entry("A", extra=', "c": 0'))
        self.works().assert_not_called()

    def test_not_while_the_key_is_refused(self):
        linkstate.bad_key("acc", "servicea")
        self.gone(self.entry("A"))
        self.works().assert_not_called()

    def test_a_failed_write_never_changes_the_answer(self):
        self.gone(self.entry("A"))
        with mock.patch.object(playlinks.store, "record_sighting", side_effect=RuntimeError("db")):
            playlinks._write_sightings("acc", linkstate.worked("acc", "servicea", "debrid"))


if __name__ == "__main__":
    unittest.main()


class OwnAIOStreams(unittest.TestCase):
    """This server has its own AIOStreams (as if put in the database: own_aiostreams.py)."""

    def setUp(self):
        from nightcap import own_aiostreams
        patcher = mock.patch.object(own_aiostreams, "get",
                                    return_value={"url": "http://aio", "template": {"services": [], "presets": []},
                                                  "services": {"servicea": "ServiceA", "serviceb": "ServiceB"},
                                                  "need_a_service": {"kinda"}})
        patcher.start()
        self.addCleanup(patcher.stop)


class Template(OwnAIOStreams):
    """A changed household template reaches each setup this server made, once, off the play's way
    (sources.update_template)."""

    def setUp(self):
        super().setUp()
        from nightcap import sources
        self.sources = sources
        sources._updated.clear()

    def secrets(self, template):
        return {"aiostreams_url": "http://aio/stremio/u/p/manifest.json", "debrid_keys": {"servicea": "k" * 10},
                "aiostreams_setup": {"url": "http://aio/stremio/u/p/manifest.json", "uuid": "u", "password": "p",
                                     **({"template": template} if template else {})}}

    def run_update(self, s, left_out=(), save_error=None):
        """(whether AIOStreams was asked, whether the setup was saved), the update run at once."""
        from contextlib import nullcontext
        from nightcap import aiostreams

        class Now:
            def __init__(self, target, args, **_):
                self.go = lambda: target(*args)

            def start(self):
                self.go()
        saved = []
        with mock.patch.object(aiostreams, "available", return_value=True), \
                mock.patch.object(aiostreams, "save", side_effect=save_error or (lambda setup, cfg: (setup, list(left_out)))) as save, \
                mock.patch.object(self.sources.threading, "Thread", Now), \
                mock.patch.object(self.sources, "_held", return_value=nullcontext("conn")), \
                mock.patch.object(self.sources.store, "secrets", return_value=s), \
                mock.patch.object(self.sources.store, "save_secrets", side_effect=lambda a, x, c, only: saved.append(only)), \
                mock.patch.object(self.sources, "_changed"):
            self.sources.update_template("acc", s)
        # (Only the setup's own secrets are saved: a change made meanwhile to another isn't undone.)
        self.assertTrue(all(only == {"aiostreams_url", "aiostreams_setup"} for only in saved))
        return save.called, bool(saved)

    def test_an_older_setup_is_updated_once(self):
        from nightcap import aiostreams
        s = self.secrets("old")
        self.assertEqual(self.run_update(s), (True, True))
        self.assertEqual(s["aiostreams_setup"]["template"], aiostreams.template_hash())
        self.assertEqual(self.run_update(s), (False, False))

    def test_a_current_setup_and_a_households_own_aiostreams_are_left_alone(self):
        from nightcap import aiostreams
        self.assertEqual(self.run_update(self.secrets(aiostreams.template_hash())), (False, False))
        own = self.secrets("old")
        own["aiostreams_url"] = "https://their-own/manifest.json"
        self.assertEqual(self.run_update(own), (False, False))

    def test_not_tried_again_straight_after_a_failure(self):
        from nightcap import aiostreams
        s = self.secrets("old")
        self.assertEqual(self.run_update(s, save_error=aiostreams.Down("starting")), (True, False))
        self.assertEqual(self.run_update(s), (False, False))

    def test_a_setup_made_without_a_slow_addon_is_tried_again_later(self):
        from nightcap import aiostreams
        s = self.secrets("old")
        self.assertEqual(self.run_update(s, left_out=["AddonA"]), (True, True))
        # Not marked as made from the template, and not tried again straight away.
        self.assertIsNone(s["aiostreams_setup"]["template"])
        self.assertEqual(self.run_update(s), (False, False))
        # A few minutes on: made again with it.
        self.sources._updated["acc"] -= self.sources.REPAIR_EVERY_S
        self.assertEqual(self.run_update(s), (True, True))
        self.assertEqual(s["aiostreams_setup"]["template"], aiostreams.template_hash())


class SlowAddon(unittest.TestCase):
    """AIOStreams refuses a whole setup when one add-on's manifest doesn't answer: it's left out (aiostreams.save)."""

    def cfg(self):
        return {"services": [], "presets": [
            {"type": "addona", "enabled": True, "options": {"name": "AddonA"}},
            {"type": "custom", "enabled": True, "options": {"name": "AddonB"}},
            {"type": "custom", "enabled": True, "options": {"name": "Addon"}}]}

    def test_the_slow_addon_is_left_out_and_the_setup_made(self):
        from nightcap import aiostreams
        cfg = self.cfg()
        calls = []

        def save(setup, c):
            calls.append([p["options"]["name"] for p in c["presets"] if p["enabled"]])
            if len(calls) == 1:
                raise aiostreams.Unavailable("Request for manifest for AddonA timed out after 10000ms")
            if len(calls) == 2:
                raise aiostreams.Unavailable("Failed to fetch manifest for AddonB nc02: fetch failed")
            return {"uuid": "u"}
        with mock.patch.object(aiostreams, "_save", side_effect=save):
            self.assertEqual(aiostreams.save(None, cfg), ({"uuid": "u"}, ["AddonA", "AddonB"]))
        # ("AddonB nc02" is AddonB with its identifier, not Addon: a name is followed by a space.)
        self.assertEqual(calls[-1], ["Addon"])

    def test_another_refusal_or_no_answer_is_raised(self):
        from nightcap import aiostreams
        for error in (aiostreams.Unavailable("Every group must have at least one addon"), aiostreams.Down("no answer")):
            with mock.patch.object(aiostreams, "_save", side_effect=error), self.assertRaises(type(error)):
                aiostreams.save(None, self.cfg())


class OneSetup(OwnAIOStreams):
    """Plays at once make one AIOStreams setup for the household, not one each (sources.ensure)."""

    def run_plays(self, save, n=3):
        """What each play's ensure() answered, and how many times AIOStreams was asked."""
        import threading
        from contextlib import contextmanager
        from nightcap import aiostreams, sources
        sources._repaired.clear()
        saved = {"aiostreams_url": None, "debrid_keys": {}, "aiostreams_setup": None}
        asked = []
        db = threading.Lock()

        @contextmanager
        def setup_lock(account, wait=True):
            # (The database's lock, as Postgres keeps it: across copies of the server.)
            if not db.acquire(blocking=wait):
                yield None
                return
            try:
                yield "conn"
            finally:
                db.release()

        def asked_save(setup, cfg):
            asked.append(1)
            return save()
        with mock.patch.object(aiostreams, "available", return_value=True), \
                mock.patch.object(aiostreams, "save", side_effect=asked_save), \
                mock.patch.object(aiostreams, "config", return_value={}), \
                mock.patch.object(sources.store, "setup_lock", setup_lock), \
                mock.patch.object(sources.store, "secrets", side_effect=lambda a, conn=None: dict(saved)), \
                mock.patch.object(sources.store, "save_secrets", side_effect=lambda a, s, conn=None, only=None: saved.update(s)), \
                mock.patch.object(sources, "_changed"):
            answers = []
            plays = [threading.Thread(target=lambda: answers.append(sources.ensure("acc"))) for _ in range(n)]
            for p in plays:
                p.start()
            for p in plays:
                p.join()
        return answers, len(asked)

    def test_plays_at_once_make_one_setup(self):
        import threading

        def save():
            threading.Event().wait(0.2)
            return {"uuid": "u", "url": "http://aio/u/manifest.json"}, []
        self.assertEqual(self.run_plays(save), ([True, True, True], 1))

    def test_a_play_that_waited_doesnt_wait_again_for_aiostreams(self):
        from nightcap import aiostreams

        import threading

        def save():
            # (AIOStreams starting: no answer, after a while.)
            threading.Event().wait(0.3)
            raise aiostreams.Down("starting")
        with mock.patch.object(aiostreams, "WAIT_S", 0):
            answers, asked = self.run_plays(save)
        # One play waited for AIOStreams; the others waited for that play, not for AIOStreams again.
        self.assertEqual(answers, [False, False, False])
        self.assertEqual(asked, 1)

    def test_a_play_on_another_copy_doesnt_wait(self):
        from contextlib import nullcontext
        from nightcap import aiostreams, sources
        sources._repaired.clear()
        with mock.patch.object(aiostreams, "available", return_value=True), \
                mock.patch.object(aiostreams, "save") as save, \
                mock.patch.object(sources.store, "setup_lock", return_value=nullcontext(None)), \
                mock.patch.object(sources.store, "secrets", return_value={"aiostreams_url": None}):
            self.assertFalse(sources.ensure("acc"))
        save.assert_not_called()


class VersionCheck(unittest.TestCase):
    """At start: asked until AIOStreams answers, quietly; one warning only if it never does, or if it's
    another version (aiostreams.check_version)."""

    def run_check(self, answers, wait_s=300):
        from nightcap import aiostreams
        clock = [0.0]

        class Now:
            def __init__(self, target, **_):
                self.go = target

            def start(self):
                self.go()
        found = iter(answers)
        with mock.patch.object(aiostreams, "available", return_value=True), \
                mock.patch.object(aiostreams, "version", side_effect=lambda: next(found, None)) as asked, \
                mock.patch.object(aiostreams.threading, "Thread", Now), \
                mock.patch.object(aiostreams.time, "time", side_effect=lambda: clock[0]), \
                mock.patch.object(aiostreams.time, "sleep", side_effect=lambda s: clock.__setitem__(0, clock[0] + s)), \
                mock.patch.object(aiostreams, "VERSION_WAIT_S", wait_s), \
                self.assertLogs("nightcap.aiostreams", "INFO") as logs:
            aiostreams.log.info("start")
            aiostreams.check_version()
        return [r.getMessage() for r in logs.records[1:]], asked.call_count

    def test_a_slow_first_start_is_waited_for_quietly(self):
        # About 3½ minutes of no answer (5 s apart), then the tested version: nothing logged.
        self.assertEqual(self.run_check([None] * 42 + ["2.37.0"]), ([], 43))

    def test_another_version_is_said(self):
        logs, _ = self.run_check([None, "2.38.0"])
        self.assertEqual(len(logs), 1)
        self.assertIn("2.38.0", logs[0])

    def test_no_answer_at_all_is_said_once_at_the_end(self):
        logs, asked = self.run_check([])
        self.assertEqual(len(logs), 1)
        self.assertIn("didn't answer within 5 minutes", logs[0])
        self.assertEqual(asked, 60)
