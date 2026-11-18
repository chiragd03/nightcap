"""Bringing one profile's Home up to date, when its TV or web app asks. Nothing runs on a timer:
what nobody asks for isn't done (and costs nothing).

Home answers at once with the one last saved, marked stale when a refresh would change it (it's
old, or a new episode's sources haven't been looked for). The app then asks for the refresh,
and shows the new Home in place of the old.
"""

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from . import cache, store
from .config import S
from .ai import AIUnavailable
from .context import for_me, scoped
from .home import first_home, launcher_feed
from .playback import look_for_sources, sources_due
from .recommend import fetch_library, recs, refresh_if_needed
from .titles import fill_missing_titles

log = logging.getLogger(__name__)

# A saved Home younger than this is shown as it is.
HOME_FRESH_S = S.advanced.refresh.home_fresh_minutes * 60
# However often an app asks, Home is built at most once a minute.
MIN_REBUILD_S = S.advanced.refresh.min_rebuild_seconds

# Kept lookups past their use, deleted once a day (each kind well after it would be worked out again
# anyway): lists with dates in them would otherwise pile up for good (a new key every day).
SWEEP = [("discover:", 3), ("pool:", 3), ("quick:", 2), ("search:", 3), ("cinemeta:", 3), ("extras:", 7),
         ("similarpool:", 3), ("similar:", 14), ("title:", 3), ("browse:", 3), ("preview:", 3), ("person:", 3),
         ("weather:", 1), ("tvmaze:", 3), ("ready:", 3), ("lang:", 3),
         ("lookup:", 60), ("imdb:", 60), ("found:", 150), ("seasonlength:", 14)]
_swept = [0.0]


def sweep():
    """At most once a day (per running server): see SWEEP."""
    if time.time() - _swept[0] < 86400:
        return
    _swept[0] = time.time()
    try:
        log.info("Swept %d old lookups", store.sweep_lookups(SWEEP))
    except Exception:
        log.exception("Couldn't sweep old lookups")


def _build():
    """Builds the profile's Home and saves it; also returns the episodes whose sources to look for."""
    with sources_due() as due:
        started = time.time()
        feed = launcher_feed()
    feed = {**feed, "stale": bool(due) or cache.stale_since(scoped("launcher"), started)}
    # (One begun after this one and saved first is newer: kept.)
    saved = cache.get(scoped("launcher"))
    if not (saved and saved[0] > started):
        cache.put(scoped("launcher"), feed, started)
    return feed, set(due)


def home():
    """Home as saved, marked stale if a refresh would change it. None saved yet (a profile's first):
    a light one at once (first_home), and the app's refresh builds the full one."""
    hit = cache.get(scoped("launcher"))
    if not hit:
        return first_home()
    saved_at, feed = hit
    return {**feed, "stale": feed.get("stale", False) or time.time() - saved_at >= HOME_FRESH_S}


def refresh():
    """Brings Home up to date: missing titles, the recommendations (only when they're due, by
    recommend.refresh_if_needed's rules), new episodes' sources, then Home itself. Returns the
    new Home (or the saved one, if it was built less than a minute ago)."""
    hit = cache.get(scoped("launcher"))
    # (One saved as stale still has new episodes' sources to look for: that's done whatever its age.)
    if hit and time.time() - hit[0] < MIN_REBUILD_S and not hit[1].get("stale"):
        return {**hit[1], "stale": False}
    sweep()
    try:
        fill_missing_titles()
    except Exception:
        log.exception("Couldn't fill missing titles")
    try:
        # A new profile has nothing to go on yet. (Without the AI the rows are ranked in code.)
        if fetch_library():
            refresh_if_needed(force=recs() is None)
    except AIUnavailable as e:
        log.info("Not rebuilding recommendations: %s", e)
    except Exception:
        log.exception("Refresh failed; keeping the previous recommendations")
    feed, due = _build()
    # An episode that's out, or may be out early on its air day (episodes.early), not yet known to have
    # sources: look now (all at once; each can take most of a minute), and show it if it has.
    if due:
        with ThreadPoolExecutor(max_workers=4) as pool:
            if any(list(pool.map(for_me(look_for_sources), due))):
                feed, _ = _build()
    return {**feed, "stale": False}


# ---------- The Shows and Movies pages ----------
# Each is built only when it's opened (never with Home), from what Home's refresh already brought up to
# date (the recommendations, TMDB's lists), so a page refresh asks the AI nothing and looks for no sources.

_page_lock = threading.Lock()


def _page_key(kind):
    return scoped(f"launcher:{kind}")


def page(kind):
    """The Shows ("tv") or Movies ("movie") page as saved, stale when it's older than Home keeps
    itself. None saved yet: at once, Home's saved rows of that kind (no lookups), marked building and
    stale, and the app's page refresh builds the real one."""
    hit = cache.get(_page_key(kind))
    if hit:
        saved_at, feed = hit
        return {**feed, "stale": feed.get("stale", False) or time.time() - saved_at >= HOME_FRESH_S}
    home_hit = cache.get(scoped("launcher"))
    rows = []
    if home_hit:
        typed = lambda i: (i.get("type") == "movie") == (kind == "movie")
        # (Not My List: it's Home's only.)
        rows = [{**r, "items": [i for i in r["items"] if typed(i)]} for r in home_hit[1].get("rows") or []
                if not r.get("style") == "tiles" and r.get("id") != "mylist"]
        rows = [r for r in rows if len(r["items"]) >= 6 or r["id"] == "continue" and r["items"]]
    return {"generated_at": int(time.time()), "featured": [], "widgets": (home_hit[1].get("widgets") if home_hit else None) or {},
            "rows": rows, "building": True, "stale": True}


def refresh_page(kind):
    """Builds the Shows or Movies page now (unless it was built in the last minute and isn't out of
    date) and answers it. Two at once: the second waits for the first and answers what it built."""
    fresh = lambda hit: hit and time.time() - hit[0] < MIN_REBUILD_S and not hit[1].get("stale")
    hit = cache.get(_page_key(kind))
    if fresh(hit):
        return {**hit[1], "stale": False}
    with _page_lock:
        hit = cache.get(_page_key(kind))
        if fresh(hit):
            return {**hit[1], "stale": False}
        started = time.time()
        feed = launcher_feed(page=kind)
        cache.put(_page_key(kind), {**feed, "stale": cache.stale_since(_page_key(kind), started)}, started)
        return {**feed, "stale": False}


def browse_keys():
    """The Browse tiles on the profile's saved Home."""
    hit = cache.get(scoped("launcher"))
    rows = (hit[1].get("rows") if hit else None) or []
    return [t["id"] for r in rows if r.get("id") == "browse" for t in r.get("items", [])]
