"""Pages and lookups the server has worked out, kept in the database (the source of truth) with a
bounded copy in memory for speed.

What's kept in the database is what came from other services (TMDB, Cinemeta, TVmaze, Netflix,
the AI) and the pages built from it (KEPT below), so a fresh copy of the server, or another one,
answers from them. What isn't: the account's stream and add-on lists (they carry its playback
links, and go stale in minutes) and quick copies of what the database already has.

Each entry is (saved at, value); whoever reads it decides how old is too old. Clearing an entry
also stops a value that was being worked out before the clear from being saved over it (it may be
out of date already).
"""

import logging
import re
import threading
import time
from collections import OrderedDict

from . import store
from .config import CACHE_ENTRIES, S
from .context import scoped

log = logging.getLogger(__name__)

# Kept in the database (after a profile's "<id>|", for the pages that are its own).
KEPT = ("launcher", "browse:", "title:", "similar:", "similarpool:", "person:", "preview:", "quick:", "smart:",
        "cinemeta:", "discover:", "netflix_top10", "lookup:", "lang:", "imdb:", "extras:", "weather:", "tvmaze:",
        "ready:", "pool:", "anime_top:", "found:", "seasonlength:")
_PROFILE = re.compile(r"^[0-9a-f-]{36}\|")
_DROPPED = object()
# "Not in the database either", remembered a minute so a key that's often asked for and rarely
# there (a show's TVmaze air times) isn't a database read each time.
_ABSENT = object()
ABSENT_FOR_S = S.advanced.cache.not_found_seconds


def _kept(key):
    return _PROFILE.sub("", key).startswith(KEPT)


class Memory:
    """The quick copy: bounded, so it can't grow without limit; the entries used longest ago go first."""

    def __init__(self, max_entries):
        self.max_entries = max_entries
        self._items = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            hit = self._items.get(key)
            if hit is None or hit[1] is _DROPPED:
                return None
            self._items.move_to_end(key)
            return hit

    def put(self, key, entry):
        """Saves [entry] unless the key was cleared after the entry's time (when its work began)."""
        with self._lock:
            old = self._items.get(key)
            if old is not None and old[1] is _DROPPED and old[0] > entry[0]:
                return
            self._items[key] = entry
            self._items.move_to_end(key)
            while len(self._items) > self.max_entries:
                self._items.popitem(last=False)

    def drop(self, key):
        self.put(key, (time.time(), _DROPPED))

    def drop_prefix(self, prefix):
        now = time.time()
        with self._lock:
            for key in [k for k in self._items if k.startswith(prefix)]:
                self._items[key] = (now, _DROPPED)

    def __len__(self):
        return len(self._items)


memory = Memory(CACHE_ENTRIES)


def get(key, ttl=None):
    """(saved at, value) for [key] if it's there and younger than [ttl] seconds (any age if None)."""
    hit = memory.get(key)
    if hit is not None and hit[1] is _ABSENT:
        if time.time() - hit[0] < ABSENT_FOR_S:
            return None
        hit = None
    if hit is None and _kept(key):
        started = time.time()
        try:
            hit = store.lookup(key)
        except Exception:
            log.exception("Couldn't read %s", key)
        memory.put(key, hit if hit is not None else (started, _ABSENT))
    if hit is None or (ttl is not None and time.time() - hit[0] >= ttl):
        return None
    return hit


def put(key, value, started=None):
    """Saves [value] for [key], worked out from [started] on (now if not given)."""
    entry = (started or time.time(), value)
    memory.put(key, entry)
    if _kept(key):
        try:
            store.keep_lookup(key, value, entry[0])
        except Exception:
            log.exception("Couldn't keep %s", key)


def drop(key):
    """Clears [key]: it's worked out again next time it's asked for."""
    memory.drop(key)
    if _kept(key):
        try:
            store.drop_lookup(key, time.time())
        except Exception:
            log.exception("Couldn't clear %s", key)


def drop_prefix(prefix):
    memory.drop_prefix(prefix)
    try:
        store.drop_lookups(prefix, time.time())
    except Exception:
        log.exception("Couldn't clear %s…", prefix)


def cached(key, fn, ttl=7 * 24 * 3600, none_ttl=None):
    """fn()'s value for [key] (scoped to the profile for its own pages), worked out again once
    it's [ttl] seconds old ([none_ttl] for an answer of None, e.g. a title TMDB doesn't have yet)."""
    key = scoped(key)
    hit = get(key, ttl)
    if hit is not None and not (hit[1] is None and none_ttl is not None and time.time() - hit[0] >= none_ttl):
        return hit[1]
    started = time.time()
    value = fn()
    put(key, value, started)
    return value


def changed(imdb_id):
    """Something about a title's watch state changed: the profile's Home and its Shows and Movies pages
    are marked out of date (kept, and shown while the app brings them up to date: deleted, the app
    would get a first-time Home of one row), and the title's own page is cleared. Marked once: a
    player reports where it's up to every few seconds."""
    for key in ("launcher", "launcher:tv", "launcher:movie"):
        stale(scoped(key))
    drop(scoped(f"title:{imdb_id}"))


def stale(key):
    """Marks a saved page out of date ("stale": true), keeping when it was made (a newer one made
    meanwhile isn't overwritten), and when it was marked: one being built meanwhile is saved out of
    date too (see stale_since). (When, in memory only: a player marks it every few seconds.)"""
    now = time.time()
    memory.put(f"{key}\0marked", (now, now))
    hit = get(key)
    if hit and isinstance(hit[1], dict) and not hit[1].get("stale"):
        put(key, {**hit[1], "stale": True}, hit[0])


def stale_since(key, started):
    """Whether the page [key] was marked out of date after [started] (a build begun before a change
    hasn't got it: it's saved out of date, so the next refresh builds it again)."""
    hit = memory.get(f"{key}\0marked")
    return bool(hit and hit[1] >= started)
