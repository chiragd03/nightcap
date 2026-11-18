"""Sources whose file runs far from the title's length (playback.check_lengths), without the network.

Run from nightcap-server/:  env -u DATABASE_URL TMDB_API_KEY=x .venv/bin/python -m unittest tests.test_lengths
"""

import os
import unittest
from unittest import mock

os.environ.setdefault("TMDB_API_KEY", "test")

from nightcap import playback  # noqa: E402

AUDIO = {"b": ["en", "hi"]}
RUNS = {"a": 11_700 * 0.66, "b": 11_700 * 0.91, "c": 6.0, "d": 11_700 * 1.05, "e": None, "f": 11_700, "g": 11_700}


def rank(found):
    for s in found:
        s["_tier"] = 4 if s.get("otherLength") else s.get("tier", 0)
    return sorted(found, key=lambda s: (s["_tier"], s["order"]))


def sources(*names, **extra):
    return rank([{"url": n, "order": i, **extra.get(n, {})} for i, n in enumerate(names)])


class Lengths(unittest.TestCase):
    def setUp(self):
        self.read = mock.patch.object(playback, "file_header", side_effect=lambda s, *a: {"seconds": RUNS[s["url"]], "audio": AUDIO.get(s["url"])}).start()

    def tearDown(self):
        mock.patch.stopall()

    def order(self, streams):
        return [s["url"] for s in streams]

    def test_far_off_go_last_marked(self):
        out = playback.check_lengths(sources("a", "b", "c", "d"), 11_700, False, rank)
        self.assertEqual(self.order(out), ["b", "d", "a", "c"])
        self.assertEqual(out[2]["otherLength"], "Runs 2 h 09 min, not 3 h 15 min")
        self.assertEqual(out[3]["otherLength"], "Runs 6 s, not 3 h 15 min")
        self.assertNotIn("otherLength", out[0])

    def test_reads_on_once_when_the_first_were_off(self):
        out = playback.check_lengths(sources("a", "c", "e", "b", "f", "g"), 11_700, False, rank)
        self.assertEqual(self.read.call_count, 6)
        self.assertEqual(self.order(out)[-2:], ["a", "c"])

    def test_unknown_length_is_left_alone(self):
        out = playback.check_lengths(sources("e", "b"), 11_700, False, rank)
        self.assertEqual(self.order(out), ["e", "b"])

    def test_no_runtime_reads_nothing(self):
        playback.check_lengths(sources("a", "b"), None, False, rank)
        self.read.assert_not_called()

    def test_only_what_would_be_tried_first(self):
        out = playback.check_lengths(sources("a", "b", "c", **{"a": {"cached": False}, "c": {"tier": 3}}), 11_700, False, rank)
        self.assertEqual([c.args[0]["url"] for c in self.read.call_args_list], ["b"])
        self.assertNotIn("otherLength", out[0])

    def test_a_source_with_no_address_is_left_alone(self):
        # A plugin's YouTube video has no "url" at all (it's played by its id).
        found = sources("a", "b")
        found.insert(0, {"youtube": "dQw4w9WgXcQ", "order": -1, "_tier": 0})
        out = playback.check_lengths(found, 11_700, False, rank)
        self.assertIn("dQw4w9WgXcQ", [s.get("youtube") for s in out])
        self.assertEqual(sorted(c.args[0]["url"] for c in self.read.call_args_list), ["a", "b"])

    def test_a_files_audio_tracks_come_with_it(self):
        out = {s["url"]: s for s in playback.check_lengths(sources("b", "d"), 11_700, False, rank)}
        self.assertEqual(out["b"]["fileAudio"], ["en", "hi"])
        self.assertNotIn("fileAudio", out["d"])

    def test_episodes_run_freer(self):
        out = playback.check_lengths(sources("b", "d"), 11_700 * 0.6, True, rank)
        self.assertFalse(any("otherLength" in s for s in out))
