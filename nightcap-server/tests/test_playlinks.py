"""Where a playback link leads (playlinks.py), without the network: the file, an error clip, a busy
service, Nightcap's AIOStreams still starting, asking again, and renewing a token.

Run from nightcap-server/:  env -u DATABASE_URL TMDB_API_KEY=x .venv/bin/python -m unittest tests.test_playlinks
"""

import email.message
import json
import os
import unittest
from unittest import mock
from urllib.error import HTTPError, URLError

os.environ.setdefault("TMDB_API_KEY", "test")
os.environ.setdefault("SECRETS_KEY", "test-secret")

from nightcap import playlinks  # noqa: E402


def headers(**h):
    m = email.message.Message()
    for k, v in h.items():
        m[k.replace("_", "-")] = v
    return m


class Answer:
    def __init__(self, status=206, **h):
        self.status, self.headers = status, headers(**h)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def redirect(to):
    return HTTPError("x", 302, "Found", headers(Location=to), None)


FILM = Answer(Content_Range="bytes 0-0/4000000000", Content_Type="video/x-matroska")


class Follow(unittest.TestCase):
    def open(self, *answers):
        it = iter(answers)

        def opened(req, timeout):
            a = next(it)
            if isinstance(a, Exception):
                raise a
            return a
        return mock.patch.object(playlinks._opener, "open", side_effect=opened)

    def test_redirects_to_the_file(self):
        with self.open(redirect("https://debrid.example/f/1"), FILM):
            self.assertEqual(playlinks._follow("https://addon.example/p/1"), "https://debrid.example/f/1")

    def test_an_error_clip_is_not_the_file(self):
        with self.open(redirect("https://debrid.example/f/1"), Answer(Content_Range="bytes 0-0/2400000", Content_Type="video/mp4")):
            with self.assertRaises(playlinks.Unavailable) as e:
                playlinks._follow("https://addon.example/p/1")
            self.assertNotIsInstance(e.exception, (playlinks.Busy, playlinks.Starting))
        # A stream's playlist is small, and fine.
        with self.open(Answer(200, Content_Length="900", Content_Type="application/vnd.apple.mpegurl")):
            self.assertEqual(playlinks._follow("https://plugin.example/a.m3u8"), "https://plugin.example/a.m3u8")

    def test_busy_is_not_gone(self):
        for code in (429, 503):
            with self.open(HTTPError("x", code, "busy", headers(), None)), self.assertRaises(playlinks.Busy):
                playlinks._follow("https://addon.example/p/1")
        with self.open(HTTPError("x", 404, "gone", headers(), None)), self.assertRaises(playlinks.Unavailable) as e:
            playlinks._follow("https://addon.example/p/1")
        self.assertNotIsInstance(e.exception, playlinks.Busy)

    def test_own_aiostreams_starting(self):
        refused = URLError(ConnectionRefusedError())
        with mock.patch.object(playlinks.own_aiostreams, "address", return_value=("localhost", 3000)), \
                mock.patch.object(playlinks.time, "sleep"):
            # Up after a few tries: the file.
            with self.open(refused, refused, redirect("https://debrid.example/f/1"), FILM):
                self.assertEqual(playlinks._follow("http://localhost:3000/api/p/1"), "https://debrid.example/f/1")
            # Still down after the wait: "starting", not gone.
            with mock.patch.object(playlinks, "STARTING_WAIT_S", 0), self.open(refused), self.assertRaises(playlinks.Starting):
                playlinks._follow("http://localhost:3000/api/p/1")
            # Someone else's server refusing is simply gone.
            with self.open(refused), self.assertRaises(playlinks.Unavailable) as e:
                playlinks._follow("https://addon.example/p/1")
            self.assertNotIsInstance(e.exception, playlinks.Starting)


class Resolve(unittest.TestCase):
    def test_fresh_asks_again(self):
        with mock.patch.object(playlinks.store, "play_link_row", return_value=(json.dumps({"v": "tt1", "l": [{"u": "https://addon.example/p/1"}]}), "acc")), \
                mock.patch.object(playlinks, "_follow", side_effect=["https://debrid.example/a", "https://debrid.example/b"]):
            playlinks._resolved.clear()
            self.assertEqual(playlinks.resolve("t" * 32, 0), "https://debrid.example/a")
            self.assertEqual(playlinks.resolve("t" * 32, 0), "https://debrid.example/a")
            self.assertEqual(playlinks.resolve("t" * 32, 0, "fresh=1"), "https://debrid.example/b")
            self.assertEqual(playlinks.resolve("t" * 32, 0), "https://debrid.example/b")

    def test_renew_keeps_the_same_links(self):
        with mock.patch.object(playlinks.store, "renewable_play_links", return_value='["x"]') as old, \
                mock.patch.object(playlinks.store, "add_play_links") as add:
            out = playlinks.renew("t" * 32, "acc", "dev", 7200)
        self.assertEqual(old.call_args.args[1:3], ("acc", "dev"))
        self.assertEqual(add.call_args.args[1:4], ("acc", "dev", '["x"]'))
        self.assertNotEqual(out["token"], "t" * 32)
        with mock.patch.object(playlinks.store, "renewable_play_links", return_value=None), \
                self.assertRaises(playlinks.Expired):
            playlinks.renew("t" * 32, "acc", "dev")


class Formats(unittest.TestCase):
    def test_live_tv_link(self):
        # A live channel's direct link is sent on with the device's query.
        row = json.dumps({"v": None, "l": [{"u": "https://live.example/c.m3u8", "d": 1, "k": "x"}]})
        with mock.patch.object(playlinks.store, "play_link_row", return_value=(row, "acc")):
            self.assertEqual(playlinks.resolve("t" * 32, 0, "a=1"), "https://live.example/c.m3u8?a=1")

    def test_links_read(self):
        new = {"v": "tt1:1:2", "l": [{"u": "https://addon.example/p/1", "k": "x"}, {"u": "https://direct.example/f", "d": 1}]}
        vid, entries = playlinks.links(json.dumps(new))
        self.assertEqual(vid, "tt1:1:2")
        self.assertEqual([e["u"] for e in entries], ["https://addon.example/p/1", "https://direct.example/f"])

    def test_a_new_shape_entry_is_followed_unless_direct(self):
        # (A dict alone must never mean "direct": that would hand the add-on's own link to the device.)
        row = json.dumps({"v": "tt1", "l": [{"u": "https://addon.example/p/1", "a": "AIOStreams"}, {"u": "https://direct.example/f", "d": 1}]})
        with mock.patch.object(playlinks.store, "play_link_row", return_value=(row, "acc")), \
                mock.patch.object(playlinks, "_follow", return_value="https://debrid.example/a") as follow:
            playlinks._resolved.clear()
            self.assertEqual(playlinks.resolve("t" * 32, 0), "https://debrid.example/a")
            self.assertEqual(follow.call_args.args[0], "https://addon.example/p/1")
            self.assertEqual(playlinks.resolve("t" * 32, 1), "https://direct.example/f")

    def test_a_files_key_is_the_same_whatever_its_link(self):
        a = {"url": "https://aio/x1", "addon": "AIOStreams", "service": "servicea", "kind": "debrid",
             "infoHash": "abc", "filename": "Show.S01E02.mkv", "size": 1000}
        b = dict(a, url="https://aio/x2")
        self.assertEqual(playlinks.stream_key(a), playlinks.stream_key(b))
        self.assertNotEqual(playlinks.stream_key(a), playlinks.stream_key(dict(a, kind="usenet")))
        self.assertNotEqual(playlinks.stream_key(a), playlinks.stream_key(dict(a, filename="Show.S01E03.mkv")))
        # A plugin's streams (file name = the add-on) go by their link.
        p1 = {"url": "https://p/1", "addon": "Sites", "filename": "Sites"}
        self.assertNotEqual(playlinks.stream_key(p1), playlinks.stream_key(dict(p1, url="https://p/2")))

    def test_issue_keeps_what_each_link_is(self):
        answer = {"id": "tt1:1:2", "runtimeMs": 0, "streams": [
            {"url": "https://aio/x1", "addon": "AIOStreams", "filename": "f.mkv", "service": "servicea", "kind": "usenet", "cached": False},
            {"url": "https://direct.example/f", "direct": True, "addon": "Extra", "filename": "g.mkv"}],
            "subtitles": [{"url": "https://subs/1.srt"}]}
        with mock.patch.object(playlinks.store, "add_play_links") as add:
            out = playlinks.issue(answer, "acc", "dev", "https://server")
        vid, entries = playlinks.links(add.call_args.args[3])
        self.assertEqual(vid, "tt1:1:2")
        self.assertEqual(entries[0]["t"], "usenet")
        self.assertEqual(entries[0]["c"], 0)
        self.assertEqual(entries[1]["d"], 1)
        self.assertEqual(entries[2], {"u": "https://subs/1.srt"})
        self.assertTrue(all(st["url"].startswith("https://server/s/") for st in out["streams"]))
        self.assertNotIn("direct", out["streams"][1])


if __name__ == "__main__":
    unittest.main()
