"""The Android TV app's updates, and whether a newer server is out (for its owner). Its releases are on GitHub (S.app.releases),
next to other products' (the setup tool's setup-v…): the app's are the ones whose tag starts with
S.app.tag_prefix (tv-v1.4), ignoring GitHub's Latest marker. The newest of them holds
version.json ({"versionCode": 2, "versionName": "0.2"}) and one APK per processor kind,
nightcap-<abi>.apk (armeabi-v7a, arm64-v8a). TVs ask this server, which asks GitHub (at most once
per S.app.check_minutes, and only when a TV asks) and passes the APK along: a TV never talks to
GitHub, and a private repository's token stays here (GITHUB_TOKEN)."""

import json
import logging
import threading
import time
from urllib import request as urllib_request
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .config import GITHUB_TOKEN, S
from .http import CheckedHTTPHandler, CheckedHTTPSHandler

log = logging.getLogger(__name__)

API = "https://api.github.com"
ABIS = ("armeabi-v7a", "arm64-v8a")
TIMEOUT_S = 15

_lock = threading.Lock()
_known = {"at": 0.0, "release": None, "etag": None}


class _DropTokenOnRedirect(HTTPRedirectHandler):
    """A release file is answered with a redirect to where it's stored, which refuses the token."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and urlparse(newurl).hostname != "api.github.com":
            new.remove_header("Authorization")
        return new


# (The same checked connections as every other fetch: never to an address on the local network.)
OPENER = build_opener(urllib_request.ProxyHandler({}), CheckedHTTPHandler, CheckedHTTPSHandler, _DropTokenOnRedirect)


def _headers(accept="application/vnd.github+json"):
    h = {"Accept": accept, "User-Agent": "nightcap-server/1.0", "X-GitHub-Api-Version": "2022-11-28"}
    if GITHUB_TOKEN:
        h["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    return h


def _open(url, accept="application/vnd.github+json", etag=None):
    return OPENER.open(Request(url, headers={**_headers(accept), **({"If-None-Match": etag} if etag else {})}), timeout=TIMEOUT_S)


def _newest_app_release(releases):
    """The newest published release (not a draft or pre-release) whose tag starts with S.app.tag_prefix, or None."""
    prefix = S.app.tag_prefix
    ours = [r for r in releases if isinstance(r, dict) and not r.get("draft") and not r.get("prerelease")
            and str(r.get("tag_name") or "").startswith(prefix) and r.get("published_at")]
    return max(ours, key=lambda r: r["published_at"], default=None)


def _read_latest():
    """{"versionCode", "versionName", "assets": {name: (api url, size)}} of the app's newest release, or None."""
    repo = S.app.releases.strip()
    if not repo:
        return None
    # (Asked with the last answer's ETag: unchanged, GitHub says 304, which doesn't count towards its limits.)
    # (The newest 100 releases, newest first: the app's newest is among them.)
    try:
        with _open(f"{API}/repos/{repo}/releases?per_page=100", etag=_known["etag"]) as r:
            releases = json.load(r)
            etag = r.headers.get("ETag")
    except HTTPError as e:
        if e.code == 304:
            return _known["release"]
        raise
    release = _newest_app_release(releases if isinstance(releases, list) else [])
    if release is None:
        log.warning("No app release (tag %s…) in %s", S.app.tag_prefix, repo)
        _known["etag"] = etag
        return None
    assets = {a["name"]: (a["url"], a.get("size") or 0) for a in release.get("assets") or []}
    if "version.json" not in assets:
        log.warning("App release %s has no version.json", release.get("tag_name"))
        return None
    # (Asked for as the file itself: GitHub answers with a redirect to it.)
    with _open(assets["version.json"][0], accept="application/octet-stream") as r:
        version = json.load(r)
    _known["etag"] = etag
    return {"versionCode": int(version["versionCode"]), "versionName": str(version["versionName"]), "assets": assets}


def latest():
    """The latest release as known (asked again once it's older than S.app.check_minutes). A failed
    ask keeps what was known, and is tried again after a minute. One ask at a time: while it's under
    way, the others get what was known (never kept waiting on a slow GitHub)."""
    if time.time() - _known["at"] < S.app.check_minutes * 60:
        return _known["release"]
    if not _lock.acquire(blocking=False):
        return _known["release"]
    try:
        try:
            _known["release"] = _read_latest()
            _known["at"] = time.time()
        except Exception as e:
            log.warning("App releases unavailable: %s", e)
            _known["at"] = time.time() - S.app.check_minutes * 60 + 60
        return _known["release"]
    finally:
        _lock.release()


def offer(abi):
    """What a TV of processor kind [abi] can update to: {"versionCode", "versionName", "size"}, or None."""
    release = latest()
    asset = release and release["assets"].get(f"nightcap-{abi}.apk")
    if not asset:
        return None
    return {"versionCode": release["versionCode"], "versionName": release["versionName"], "size": asset[1]}


def download(abi):
    """(stream of the APK's bytes, its size) for [abi], or None if there's none or GitHub didn't give it
    (a file replaced since the release was read: it's read again next time)."""
    release = latest()
    asset = release and release["assets"].get(f"nightcap-{abi}.apk")
    if not asset:
        return None
    try:
        r = _open(asset[0], accept="application/octet-stream")
    except OSError as e:
        log.warning("App download unavailable: %s", e)
        # (Only a file GitHub no longer has means the release changed: read again. GitHub down keeps
        # its minute's wait.)
        if isinstance(e, HTTPError) and e.code == 404:
            _known["at"] = 0.0
        return None
    # (The size GitHub actually sends, not the one listed.)
    size = int(r.headers.get("Content-Length") or asset[1])

    def chunks():
        with r:
            while block := r.read(1 << 16):
                yield block
    return chunks(), size


# ---------- A newer server, for its owner ----------
# The newest server version is the releases repository's server.json ({"version": "1.1"}) on its
# main branch, not a release (the app's check reads the app's releases). Asked only when the owner's
# page asks (never on a timer: an idle server stays asleep), kept as long as the app's.

_server = {"at": 0.0, "version": None}
_server_lock = threading.Lock()


def _read_server_version():
    repo = S.app.releases.strip()
    if not repo:
        return None
    with _open(f"{API}/repos/{repo}/contents/server.json", accept="application/vnd.github.raw+json") as r:
        return str(json.load(r)["version"])


def _parts(version):
    return tuple(int(p) for p in version.split(".") if p.isdigit())


def server_status(current):
    """{"version": [current], "latest": the newest out (or None if it couldn't be told), "update": whether
    it's newer}."""
    if time.time() - _server["at"] >= S.app.check_minutes * 60 and _server_lock.acquire(blocking=False):
        try:
            try:
                _server["version"] = _read_server_version()
                _server["at"] = time.time()
            except Exception as e:
                log.warning("Server releases unavailable: %s", e)
                _server["at"] = time.time() - S.app.check_minutes * 60 + 60
        finally:
            _server_lock.release()
    latest = _server["version"]
    return {"version": current, "latest": latest, "update": bool(latest and _parts(latest) > _parts(current))}
