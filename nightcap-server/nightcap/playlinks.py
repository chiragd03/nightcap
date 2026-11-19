"""Playback links: devices never see the add-ons' own stream and subtitle links.

An add-on's link (AIOStreams' /api/v1/debrid/playback/…, or one with a debrid key in its path) works
from anywhere for as long as the household's debrid account lives. So a play answer's links are
kept here instead, encrypted, and the device gets {server}/s/{token}/{n}: one token per play answer,
valid for the running time plus a couple of hours, and only while the device is still in the
household. Opening one, the server follows the add-on's redirects itself (each hop checked, see
http.py) to the file's own address, the debrid service's temporary download link, which carries no
key, and sends the player straight there: a browser reading the file itself (the web player) is
only let in when the link it opened redirects once, straight to the file. A link that has expired
answers 410 with X-Link-Expired: the player renews its token (renew: the same links, no new lookup) and carries on where it was.

A link answers 503 with Retry-After when it may work in a moment, so the player waits instead of
trying another file: Nightcap's own AIOStreams still starting after a cold start (Starting), or the
debrid service busy (a 429 or 5xx: Busy). It answers 502 only when the file is gone. And a few
megabytes where a film should be is an add-on's error clip ("Unexpected provider response"): gone.
"?fresh=1" asks the add-on again instead of using where it led last (a debrid link that died).

A play answer's links are kept as {"v": the video id, "l": [one entry per link]}, each entry {"u": the
add-on's own link, "d": 1 for a direct link (sent on, never followed), and for a stream "a" (the
add-on's name), "f" (the file name), "c": 0 when the debrid service hasn't downloaded it, "k" (the
file's key, the same for the same file whatever the lookup), "t" (AIOStreams' stream type: usenet,
debrid, http), "s" (the debrid service)}.

The token is in the path because libVLC can't send headers. Only its hash is kept.
"""

import hashlib
import hmac
import threading
import json
import logging
import os
import secrets
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError
from urllib.parse import parse_qs, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from . import linkstate, store
from .config import S
from . import own_aiostreams
from .http import CheckedHTTPHandler, CheckedHTTPSHandler

log = logging.getLogger(__name__)

EXTRA_S = S.playback.link_extra_hours * 3600   # beyond the running time
LEAST_S = S.playback.link_min_hours * 3600     # however short the title (or when its running time isn't known)
# Where a link led is kept this long, so seeking doesn't ask the add-on again (and get a new debrid
# link each time); debrid links usually last longer than this.
RESOLVED_S = S.advanced.timeouts.link_resolved_minutes * 60
# Under the TV's own wait for a source to start (30 s), so a slow add-on is one failed source,
# not a player that gave up while the server was still asking.
RESOLVE_TIMEOUT_S = S.advanced.timeouts.link_resolve_seconds
# Redirects followed to reach the file (AIOStreams → the debrid service → its file server is two).
MAX_HOPS = S.advanced.timeouts.link_max_hops
# How long a link waits for Nightcap's own AIOStreams to start (it takes 30-40 s after a cold start)
# before answering "starting": well under the players' 30 s, which they start only once it's answered.
STARTING_WAIT_S = 10
# A file smaller than this isn't a film or an episode: an add-on's error clip.
SMALLEST_FILE = 50 * 1000 * 1000
# Expired links are kept this long, so a long pause renews its token instead of looking again.
RENEWABLE_S = 24 * 3600


class Expired(Exception):
    """No such token, it has expired, or its device has been removed."""


class Unavailable(Exception):
    """The add-on didn't hand over the file (an error, or no answer): its own link is never given
    out instead."""


class Starting(Unavailable):
    """Nightcap's own AIOStreams isn't up yet (a cold start): it will be in a moment."""


class Busy(Unavailable):
    """The add-on or debrid service is busy (429, 5xx): it may hand the file over in a moment. [until]:
    when the household's service (and stream type) may be asked again, for a busy window (0: a busy
    answer about this one file, worth one more try in a moment)."""
    def __init__(self, until=0, service=None, kind=None):
        super().__init__()
        self.until, self.service, self.kind = until, service, kind


class Gone(Unavailable):
    """This file is gone (the add-on says no file matches, it can't be downloaded, its host says
    404/410/401/403): a sighting of a dead file."""


class Preparing(Unavailable):
    """The debrid service is still getting this file (AIOStreams' "downloading"): not dead."""


class Refused(Unavailable):
    """The household's debrid service refused: its key (401), its plan (payment_required), or a second
    403 or store limit. [kind]: the stream type a plan refused (None: all of the service's files).
    [why]: "key" (401: none of its files can be had), "plan" (payment_required: that type's can't), or
    "limit" (a second 403 or torrent store limit: its files go last, others first)."""
    def __init__(self, service=None, kind=None, why="key"):
        super().__init__()
        self.service, self.kind, self.why = service, kind, why


class Follow:
    """What a follow is for, so its answer can be told apart and remembered for the right household:
    the account, the file's debrid service, its stream type, key and add-on, and whether it's a guess
    (a header read, an audio check) rather than a file being opened."""
    def __init__(self, account=None, service=None, kind=None, key=None, addon=None, guess=False):
        self.account, self.service, self.kind, self.key, self.addon, self.guess = account, service, kind, key, addon, guess
        self.started = time.time()

    @classmethod
    def of(cls, entry, account, guess=False):
        return cls(account, entry.get("s"), entry.get("t"), entry.get("k"), entry.get("a"), guess)


def _hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def links(raw):
    """A row's links JSON ({"v", "l"}) as (video id or None, [entry dicts with at least "u"])."""
    data = json.loads(raw) if isinstance(raw, str) else raw
    return data.get("v"), data.get("l") or []


def _key_secret():
    return hmac.new(os.environ["SECRETS_KEY"].encode(), b"stream-key", hashlib.sha256).digest()


def stream_key(s):
    """A file's key: the same for the same file whatever the lookup (AIOStreams' own links change every
    time: a new random IV), so what's learned about it holds. A keyed hash of the add-on, its debrid
    service, its stream type, its info hash, its file name and its size; with no file name, its link (a
    plugin's), or its YouTube id. Short: it names, it doesn't hide."""
    if s.get("youtube") and not s.get("url"):
        basis = "yt|" + s["youtube"]
    elif s.get("filename") and s.get("filename") != s.get("addon"):
        basis = "|".join(str(s.get(k) or "") for k in ("addon", "service", "kind", "infoHash", "filename", "size"))
    else:
        basis = "u|" + (s.get("url") or "")
    return hmac.new(_key_secret(), basis.encode(), hashlib.sha256).hexdigest()[:24]


def issue(answer, account_id, device_id, base):
    """[answer] (a play answer) with its stream and subtitle links swapped for this device's
    playback links under [base] ("https://host"). The real ones are kept, encrypted."""
    streams, subs = answer.get("streams") or [], answer.get("subtitles") or []
    # (A YouTube video has no link: the app plays it by its id.)
    # (A "direct" stream, one a device opens itself as Live TV's optional extension says, is kept
    # as {"u", "d"}: its link isn't followed here, only sent on, with the query the device adds.)
    kept = ([_entry(s) for s in streams if s.get("url")] + [{"u": s["url"]} for s in subs])
    if not kept:
        return answer
    token = secrets.token_urlsafe(24)
    runtime = (answer.get("runtimeMs") or 0) // 1000
    lasts = max(LEAST_S, runtime + EXTRA_S)
    row = {"v": answer.get("id"), "l": kept}
    store.add_play_links(_hash(token), account_id, device_id, json.dumps(row), lasts)
    numbers = iter(range(len(kept)))
    at = lambda: f"{base}/s/{token}/{next(numbers)}"
    # When they stop working, so the player (libVLC can't see a 410) asks for new ones before then.
    return {**answer, "linksExpireAt": int((time.time() + lasts) * 1000),
            "streams": [{**{k: v for k, v in s.items() if k != "direct"}, "url": at()} if s.get("url") else s
                        for s in streams],
            "subtitles": [{**s, "url": at()} for s in subs]}


def _entry(s):
    """How a stream's link is kept (see the module's notes)."""
    e = {"u": s["url"]}
    if s.get("direct"):
        e["d"] = 1
    for short, key in (("a", "addon"), ("f", "filename"), ("t", "kind"), ("s", "service")):
        if s.get(key):
            e[short] = str(s[key])[:300]
    if s.get("cached") is False:
        e["c"] = 0
    e["k"] = stream_key(s)
    return e


_resolved = {}  # (token hash, n) or (account, file key) -> (when, address)
_inflight = {}  # (account, file key) -> _Pending, while one follow for it is under way
_inflight_lock = threading.Lock()
_resolved_lock = threading.Lock()


class _Pending:
    """One follow under way for a file: a second ask for it waits, and gets the same answer (its
    address, or what it raised)."""
    def __init__(self):
        self.done = threading.Event()
        self.target = None
        self.error = None


def _remember(k, target):
    with _resolved_lock:
        _resolved[k] = (time.time(), target)
        # Kept small: old ones go.
        if len(_resolved) > 5000:
            for old in [old for old, (at, _) in _resolved.items() if time.time() - at >= RESOLVED_S]:
                _resolved.pop(old, None)


def _recalled(k):
    hit = _resolved.get(k)
    return hit[1] if hit and time.time() - hit[0] < RESOLVED_S else None


def resolve(token, n, query="", account=None, newer=False, guess=False):
    """Where playback link [n] of [token] leads now (see where)."""
    return where(token, n, query, account, newer, guess)[0]


def where(token, n, query="", account=None, newer=False, guess=False):
    """Where playback link [n] of [token] leads now: the address the add-on redirects to (or the
    add-on's own address, if it serves the file itself); for a direct one, its own address with
    [query] (what the device added to the link) added. With [account], only a link of that
    household's. [newer]: the player understands busy and refused answers given from memory (X-Where:
    2); [guess]: a header read or an audio check, not a file being opened. (address, whether it's a
    direct link). Raises Expired, or Unavailable (one of its kinds)."""
    h = _hash(token)
    row = store.play_link_row(h, account)
    if row is None:
        _resolved.pop((h, n), None)
        raise Expired()
    raw, owner = row
    vid, entries = links(raw)
    if not 0 <= n < len(entries):
        raise Expired()
    entry = entries[n]
    # A direct one ("d"): its own address, never followed.
    if entry.get("d"):
        url = entry["u"]
        return (url + ("&" if "?" in url else "?") + query if query else url), True
    fresh = "fresh" in parse_qs(query)
    # A subtitle's, or a file with no debrid service: by its token and place.
    if not entry.get("k") or not entry.get("s"):
        hit = None if fresh else _recalled((h, n))
        if hit:
            return hit, False
        target = _follow(entry["u"], Follow.of(entry, owner, guess))
        _remember((h, n), target)
        return target, False
    # A file's: by the household and the file's key (the same file whatever lookup gave its link).
    k = (owner, entry["k"])
    hit = None if fresh else _recalled(k)
    if hit:
        return hit, False
    follow = Follow.of(entry, owner, guess)
    # Known to be refused or busy just now: said from memory, to a player that understands it, and to
    # a guess (a header read, an audio check), which never needs to ask the service then.
    if newer or guess:
        if linkstate.refused(owner, follow.service, follow.kind):
            raise Refused(follow.service, follow.kind, "plan")
        until = linkstate.busy_until(owner, follow.service, follow.kind)
        if until - time.time() > 1:
            raise Busy(until, follow.service, follow.kind)
    # One follow at a time per file: a second ask waits for the first's answer.
    with _inflight_lock:
        waiting = _inflight.get(k)
        mine = None if waiting else _inflight.setdefault(k, _Pending())
    if waiting is not None:
        if waiting.done.wait(RESOLVE_TIMEOUT_S + STARTING_WAIT_S):
            if waiting.error is not None:
                raise waiting.error
            return waiting.target, False
        raise Busy()  # (The first is taking too long: worth asking again in a moment.)
    try:
        # Within the household's debrid service's own limits.
        wait = linkstate.count(owner, follow.service, follow.kind, guess)
        if wait:
            raise Busy(wait, follow.service, follow.kind)
        mine.target = _follow(entry["u"], follow)
        _remember(k, mine.target)
        return mine.target, False
    except Exception as e:
        mine.error = e
        if isinstance(e, Gone):
            _sighting(owner, vid, entry)
        raise
    finally:
        with _inflight_lock:
            _inflight.pop(k, None)
        mine.done.set()


def _sighting(account, vid, entry):
    """A file of this household's that looked gone: held until another file of its service works (then
    it was the file, not an outage: written down, see store.file_health), and forgotten if none does;
    not while its service is down or refusing; never a live channel's or one not downloaded (any follow
    starts it)."""
    service = entry.get("s")
    if not account or not vid or entry.get("c") == 0 or not service or not linkstate.judging(account, service):
        return
    linkstate.hold(account, service, (vid, entry.get("a"), entry["k"]))


_writes = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sightings")


def _write_sightings(account, held):
    """Files seen gone, now known to be theirs (their service works). A failed write changes nothing."""
    for vid, addon, key in held:
        try:
            store.record_sighting(account, vid, addon, key)
        except Exception:
            log.exception("Couldn't note a file that looked gone")


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


# Checked connections (see http.py): an add-on's link can't send the server to itself or the network.
_opener = build_opener(ProxyHandler({}), _NoRedirect, CheckedHTTPHandler, CheckedHTTPSHandler)


# AIOStreams' error videos (v2.37.0, static-errors.ts: one per kind of debrid error), sorted.
CLIPS_GONE = {"no_matching_file", "unavailable_for_legal_reasons", "download_failed"}
CLIPS_BUSY = {"429", "content_proxy_limit_reached"}


def _follow(url, follow=None):
    """The file's own address: [url]'s redirects followed (at most MAX_HOPS, all within
    RESOLVE_TIMEOUT_S) to the one that answers with the file. AIOStreams' error videos (a redirect to
    its /static/ clips) are told apart by name; a host's own refusal by its status. [follow]: what the
    follow is for (its household, service, type), so a busy service and a refused account are
    remembered for the right one. Raises Unavailable (plain: not this file now), Gone, Preparing,
    Refused, Busy or Starting."""
    started = time.monotonic()
    deadline = started + RESOLVE_TIMEOUT_S
    hops = 0
    while hops <= MAX_HOPS:
        req = Request(url, headers={"User-Agent": "Nightcap", "Range": "bytes=0-0"})
        try:
            with _opener.open(req, timeout=max(1.0, deadline - time.monotonic())) as r:
                if _a_file(r) and 0 < _size(r) < SMALLEST_FILE:
                    log.info("A playback link led to %d bytes: an error clip, not the file", _size(r))
                    raise Unavailable()
                if follow and follow.account and follow.service:
                    # (Not this file's own: it works now. Written in the background: the player waits for the address.)
                    held = [h for h in linkstate.worked(follow.account, follow.service, follow.kind) if h[2] != follow.key]
                    if held:
                        _writes.submit(_write_sightings, follow.account, held)
                return url
        except HTTPError as e:
            location = e.headers.get("Location") if 300 <= e.code < 400 else None
            if not location:
                log.info("A playback link answered %s", e.code)
                if e.code == 429 or e.code >= 500:
                    raise Busy()
                raise Gone() if e.code in (401, 403, 404, 410) and not _own(url) else Unavailable()
            came_from_ours = _own(url)
            url = urljoin(url, location)
            # (Only Nightcap's own AIOStreams sending the player to its own clip: another add-on's redirect
            # to that address isn't AIOStreams speaking.)
            clip = _clip(url) if came_from_ours else None
            if clip is not None:
                raise _from_clip(clip, follow)
            hops += 1
        except Unavailable:
            raise
        except Exception as e:
            # Nightcap's own AIOStreams after a cold start: its port is closed until it's up.
            if _own(url) and isinstance(getattr(e, "reason", e), ConnectionRefusedError):
                if time.monotonic() - started < STARTING_WAIT_S:
                    time.sleep(1)
                    continue
                log.info("A playback link's AIOStreams is still starting")
                raise Starting()
            # A file the household's service is still fetching before AIOStreams can play it: being
            # prepared, not dead.
            if _own(url) and follow and follow.kind == "usenet" and "timed out" in str(getattr(e, "reason", e)).lower():
                log.info("A playback link is still being prepared")
                raise Preparing()
            log.info("A playback link didn't answer: %s", type(e).__name__)
            raise Unavailable()
    log.info("A playback link redirected more than %s times", MAX_HOPS)
    raise Unavailable()


def _clip(url):
    """The name of an AIOStreams error video [url] is ("download_failed"), or None: only Nightcap's own
    AIOStreams' (its clips are known; another's are only small files)."""
    if not _own(url):
        return None
    path = urlsplit(url).path
    if not path.startswith("/static/") or not path.endswith(".mp4"):
        return None
    return path[len("/static/"):-len(".mp4")]


def _from_clip(clip, follow):
    """What an AIOStreams error video means for this follow (see CLIPS_*)."""
    f = follow or Follow()
    who = f.account and f.service
    log.info("A playback link led to AIOStreams' %s clip", clip)
    if clip == "downloading":
        return Preparing()
    if clip == "download_failed" and who and linkstate.failed_download(f.account, f.service, f.key or ""):
        return Unavailable()  # (Several files at once: the service is down, not this file.)
    if clip in CLIPS_GONE:
        return Gone()
    if not who:
        return Unavailable()
    if clip == "401":
        linkstate.bad_key(f.account, f.service)
        return Refused(f.service)
    if clip == "payment_required":
        linkstate.refuse(f.account, f.service, f.kind)
        return Refused(f.service, f.kind, "plan")
    if clip == "403":
        return Refused(f.service, why="limit") if linkstate.second(f.account, f.service, "403", f.addon or "", f.key) else Unavailable()
    if clip == "store_limit_exceeded":
        if not linkstate.second(f.account, f.service, "store", f.kind or "", f.key):
            return Unavailable()
        if f.kind == "usenet":
            return Busy(linkstate.usenet_limit(f.account, f.service), f.service, "usenet")
        return Refused(f.service, why="limit")
    if clip in CLIPS_BUSY:
        return Busy(linkstate.saw_429(f.account, f.service, f.kind, f.started), f.service, f.kind)
    return Unavailable()  # "500", or a clip this version doesn't know


def _own(url):
    p = urlsplit(url)
    own = own_aiostreams.address()
    return own is not None and p.hostname is not None and \
        (p.hostname.lower(), p.port or (443 if p.scheme == "https" else 80)) == own


def _a_file(r):
    """Whether an answer is a video file (not a stream's playlist, which is small by nature)."""
    kind = (r.headers.get("Content-Type") or "").lower()
    return (kind.startswith("video/") or kind.startswith("application/octet-stream")) and "mpegurl" not in kind


def _size(r):
    """The whole file's size, from an answer to "bytes=0-0" (Content-Range), or 0 when it doesn't say."""
    total = (r.headers.get("Content-Range") or "").rpartition("/")[2]
    if total.isdigit():
        return int(total)
    length = r.headers.get("Content-Length") or ""
    # (A server that ignores Range sends the whole file: its length is the file's.)
    return int(length) if length.isdigit() and r.status == 200 else 0


def renew(token, account_id, device_id, runtime_s=0):
    """A new token over the same links as [token] (one of this device's, expired up to a day ago), so a
    play paused for hours carries on without looking for sources again: {"token", "linksExpireAt"}.
    [runtime_s]: how long the title runs, as for issue. Raises Expired."""
    kept = store.renewable_play_links(_hash(token), account_id, device_id, RENEWABLE_S)
    if not kept:
        raise Expired()
    new = secrets.token_urlsafe(24)
    lasts = max(LEAST_S, runtime_s + EXTRA_S)
    store.add_play_links(_hash(new), account_id, device_id, kept, lasts)
    return {"token": new, "linksExpireAt": int((time.time() + lasts) * 1000)}


def reader(token, n, account, seconds):
    """read(offset, size) for the file behind playback link [n] of [token] (one of [account]'s): that
    part of it, or less where the file ends, all within [seconds]. For reading a file's own track
    list (filetracks.py). Raises Expired, or Unavailable."""
    return _reader(resolve(token, n, account=account, guess=True), seconds)


def file_reader(url, direct, seconds, follow=None):
    """read(offset, size), as reader's, for a stream's own link (before it's a device's playback link):
    the file an add-on's link leads to, or a direct one's own address. [follow]: the household and file
    it's read for: where the link led is kept for it, so opening the file soon after doesn't ask the
    debrid service again. Raises Unavailable (one of its kinds)."""
    if direct:
        return _reader(url, seconds)
    target = _follow(url, follow)
    if follow and follow.account and follow.key:
        _remember((follow.account, follow.key), target)
    return _reader(target, seconds)


def _reader(url, seconds):
    deadline = time.monotonic() + seconds

    def read(offset, size):
        req = Request(url, headers={"User-Agent": "Nightcap", "Range": f"bytes={offset}-{offset + size - 1}"})
        try:
            with _opener.open(req, timeout=max(1.0, deadline - time.monotonic())) as r:
                # (A server that ignores Range sends the whole file from its start.)
                if offset and r.status != 206:
                    return b""
                return r.read(size)
        except Exception as e:
            log.info("A file's start couldn't be read: %s", type(e).__name__)
            raise Unavailable()
    return read
