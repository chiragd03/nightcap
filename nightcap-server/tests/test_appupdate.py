"""The Android TV app's updates from GitHub releases (appupdate), without the network.

Run from nightcap-server/:  env -u DATABASE_URL TMDB_API_KEY=x .venv/bin/python -m unittest tests.test_appupdate
"""

import io
import json
import os
import unittest
from unittest import mock

os.environ.setdefault("TMDB_API_KEY", "test")

from nightcap import appupdate  # noqa: E402

RELEASE = {"tag_name": "tv-v0.2", "published_at": "2026-11-01T10:00:00Z", "assets": [
    {"name": "version.json", "url": "api/version", "size": 40},
    {"name": "nightcap-armeabi-v7a.apk", "url": "api/apk32", "size": 25_000_000},
]}
RELEASES = f"{appupdate.API}/repos/{appupdate.S.app.releases}/releases?per_page=100"


def fake_open(answers):
    def _open(url, accept=None, etag=None):
        body = answers[url]
        if isinstance(body, Exception):
            raise body
        out = io.BytesIO(json.dumps(body).encode() if not isinstance(body, bytes) else body)
        out.headers = {}
        return out
    return _open


class AppUpdate(unittest.TestCase):
    def setUp(self):
        appupdate._known.update(at=0.0, release=None)

    def answers(self, **extra):
        return {RELEASES: [RELEASE],
                "api/version": {"versionCode": 2, "versionName": "0.2"}, **extra}

    def test_offer(self):
        with mock.patch.object(appupdate, "_open", side_effect=fake_open(self.answers())):
            self.assertEqual(appupdate.offer("armeabi-v7a"), {"versionCode": 2, "versionName": "0.2", "size": 25_000_000})
            # No APK for this kind of processor: nothing offered.
            self.assertIsNone(appupdate.offer("arm64-v8a"))

    def test_asked_once_an_hour(self):
        with mock.patch.object(appupdate, "_open", side_effect=fake_open(self.answers())) as o:
            appupdate.offer("armeabi-v7a")
            appupdate.offer("armeabi-v7a")
        self.assertEqual(o.call_count, 2)  # the release and its version.json, once

    def test_github_down_keeps_what_was_known(self):
        with mock.patch.object(appupdate, "_open", side_effect=fake_open(self.answers())):
            appupdate.offer("armeabi-v7a")
        appupdate._known["at"] = 0.0
        with mock.patch.object(appupdate, "_open", side_effect=OSError("down")):
            self.assertEqual(appupdate.offer("armeabi-v7a")["versionCode"], 2)

    def test_release_without_version_offers_nothing(self):
        bare = {"tag_name": "tv-v0.3", "published_at": "2026-11-02T10:00:00Z",
                "assets": [{"name": "nightcap-armeabi-v7a.apk", "url": "x", "size": 1}]}
        with mock.patch.object(appupdate, "_open", side_effect=fake_open(self.answers(**{RELEASES: [bare, RELEASE]}))):
            self.assertIsNone(appupdate.offer("armeabi-v7a"))

    def test_only_the_apps_own_releases_count(self):
        # The setup tool's newer release (GitHub's Latest), a newer draft and pre-release of the app, and
        # an untagged-by-us one: the app's tv-v0.2 is still offered.
        setup = {"tag_name": "setup-v1.0", "published_at": "2026-11-10T10:00:00Z",
                 "assets": [{"name": "nightcap-setup", "url": "api/setup", "size": 5}]}
        draft = {**RELEASE, "tag_name": "tv-v0.4", "draft": True, "published_at": None}
        pre = {**RELEASE, "tag_name": "tv-v0.3", "prerelease": True, "published_at": "2026-11-09T10:00:00Z"}
        other = {**RELEASE, "tag_name": "v0.9", "published_at": "2026-11-08T10:00:00Z"}
        older = {**RELEASE, "tag_name": "tv-v0.1", "published_at": "2026-10-01T10:00:00Z",
                 "assets": [{"name": "version.json", "url": "api/old", "size": 40}]}
        with mock.patch.object(appupdate, "_open", side_effect=fake_open(self.answers(**{
                RELEASES: [setup, draft, pre, other, older, RELEASE]}))):
            self.assertEqual(appupdate.offer("armeabi-v7a"), {"versionCode": 2, "versionName": "0.2", "size": 25_000_000})

    def test_no_app_release_offers_nothing(self):
        setup = {"tag_name": "setup-v1.0", "published_at": "2026-11-10T10:00:00Z", "assets": []}
        with mock.patch.object(appupdate, "_open", side_effect=fake_open(self.answers(**{RELEASES: [setup]}))):
            self.assertIsNone(appupdate.offer("armeabi-v7a"))

    def test_download_failing_is_none_and_reread(self):
        with mock.patch.object(appupdate, "_open", side_effect=fake_open(self.answers(**{"api/apk32": appupdate.HTTPError("api/apk32", 404, "Not Found", {}, None)}))):
            self.assertIsNone(appupdate.download("armeabi-v7a"))
        self.assertEqual(appupdate._known["at"], 0.0)

    def test_token_dropped_only_off_github(self):
        h = appupdate._DropTokenOnRedirect()
        for where, kept in (("https://objects.githubusercontent.com/x", False), ("https://api.github.com/repos/a/b", True)):
            req = appupdate.Request("https://api.github.com/x", headers={"Authorization": "Bearer t"})
            new = h.redirect_request(req, None, 302, "Found", {}, where)
            self.assertEqual(new.has_header("Authorization"), kept)

    def test_download_streams(self):
        with mock.patch.object(appupdate, "_open", side_effect=fake_open(self.answers(**{"api/apk32": b"APK" * 10}))):
            chunks, size = appupdate.download("armeabi-v7a")
            self.assertEqual(b"".join(chunks), b"APK" * 10)
            self.assertEqual(size, 25_000_000)


class ServerVersion(unittest.TestCase):
    def setUp(self):
        appupdate._server.update(at=0.0, version=None)

    def test_newer_server(self):
        url = f"{appupdate.API}/repos/{appupdate.S.app.releases}/contents/server.json"
        with mock.patch.object(appupdate, "_open", side_effect=fake_open({url: {"version": "1.10"}})):
            self.assertEqual(appupdate.server_status("1.9"), {"version": "1.9", "latest": "1.10", "update": True})
        self.assertFalse(appupdate.server_status("1.10")["update"])

    def test_github_down_says_nothing(self):
        with mock.patch.object(appupdate, "_open", side_effect=OSError("down")):
            self.assertEqual(appupdate.server_status("1.0"), {"version": "1.0", "latest": None, "update": False})


if __name__ == "__main__":
    unittest.main()
