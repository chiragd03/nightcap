"""What the server remembers, for a while and in memory only, about following a household's
playback links (playlinks.py): so a debrid service that's limiting the account isn't asked again
until it can answer, a refused plan isn't asked again at all for a while, and a household stays
inside its debrid service's own limits. Everything here is per household (account), and per
debrid service: a household can have several, each with its own limits. Lost when the server
restarts or sleeps, which only means asking once more.

The service's published limits: 300 calls a minute per API key, per endpoint; and 60 new files an
hour that it has to fetch first, of each kind.
"""

import threading
import time

# A busy service's first 429 in this long: a short wait; more: 60 s, doubling, up to the most.
BUSY_FIRST_S = 10
BUSY_NEXT_S = 60
BUSY_MOST_S = 600
BUSY_MEMORY_S = 600
# A usenet download limit met twice (store_limit_exceeded): usenet waits this long.
USENET_LIMIT_S = 600
# A plan that lacks something (payment_required): not asked again for this long.
REFUSED_S = 600
# The second of these within this long is the account's, not one file's (a 403, a store limit).
SECOND_WITHIN_S = 600
# This many different files giving download_failed within this long: the service is down, not the files.
DOWN_FILES = 3
DOWN_WITHIN_S = 120
# Follows the server makes for a household, under the debrid service's own limits.
USENET_PER_HOUR = 45
USENET_GUESSES = 30          # of those, header reads and checks may use this many (the rest: opens)
ALL_PER_MINUTE = 200

_lock = threading.Lock()


def _now():
    return time.time()


class _Window:
    def __init__(self):
        self.until = 0.0
        self.level = 0
        self.last_open = 0.0


_windows = {}      # (account, service, type) -> _Window: a 429's busy window
_usenet_limit = {}  # (account, service) -> until
_refused = {}      # (account, service, type) -> until: payment_required
_seconds = {}      # (account, service, what, scope) -> (when the first was seen, its file's key)
_failed = {}       # (account, service) -> {key: when}: download_failed sightings
_counts = {}       # (account, service, "usenet"|"all") -> [times]
_quiet = {}        # (account, service) -> until: a 401 or payment_required lately (no file is judged then)
_held = {}         # (account, service) -> [(when, what)]: files seen gone, until a file of the service works
# A file seen gone is written down only once another file of its service works within this long (the
# service was up: the file, not an outage); otherwise it's forgotten.
HELD_S = 600


def busy_until(account, service, kind):
    """When a busy window for this household's service and stream type ends (0: none open)."""
    with _lock:
        until = max((_windows.get((account, service, kind)) or _Window()).until,
                    _usenet_limit.get((account, service), 0) if kind == "usenet" else 0)
    return until if until > _now() else 0


def saw_429(account, service, kind, started):
    """A real 429 from the service on a follow that began at [started]: opens the window, or lengthens it
    one step, unless a window was already open when that follow began (four at once: one step). The
    window's end."""
    with _lock:
        w = _windows.setdefault((account, service, kind), _Window())
        now = _now()
        if w.until > started + 1:
            return w.until
        recent = now - w.last_open < BUSY_MEMORY_S
        w.level = w.level + 1 if recent else 1
        length = BUSY_FIRST_S if w.level == 1 else min(BUSY_MOST_S, BUSY_NEXT_S * 2 ** (w.level - 2))
        w.until = now + length
        w.last_open = now
        return w.until


def worked(account, service, kind):
    """A follow of this service and type worked: its busy window closes and starts again from the first
    step. The files of the service seen gone lately (hold), now known to be the files' fault, are
    handed back to be written down."""
    with _lock:
        _windows.pop((account, service, kind), None)
        now = _now()
        return [what for at, what in _held.pop((account, service), []) if now - at < HELD_S]


def hold(account, service, what):
    """A file of this household's service seen gone: kept until a file of the service works (worked)."""
    with _lock:
        now = _now()
        kept = [(at, w) for at, w in _held.get((account, service), []) if now - at < HELD_S]
        _held[(account, service)] = kept[-50:] + [(now, what)]


def usenet_limit(account, service):
    """Usenet's download limit met twice: usenet waits."""
    with _lock:
        _usenet_limit[(account, service)] = _now() + USENET_LIMIT_S
        return _usenet_limit[(account, service)]


def refuse(account, service, kind):
    with _lock:
        _refused[(account, service, kind)] = _now() + REFUSED_S
        _quiet[(account, service)] = _now() + REFUSED_S


def bad_key(account, service):
    """The household's key for this service was refused (401): no file of it is judged for a while."""
    with _lock:
        _quiet[(account, service)] = _now() + REFUSED_S


def judging(account, service):
    """Whether a file of this household's service may be judged gone now: not while the service is down
    (3+ files failing at once) or within 10 min of a refused key or plan."""
    with _lock:
        if _quiet.get((account, service), 0) > _now():
            return False
    return not service_down(account, service)


def refused(account, service, kind):
    """Whether this household's plan refused this service and type lately (payment_required)."""
    with _lock:
        return _refused.get((account, service, kind), 0) > _now()


def second(account, service, what, scope="", key=None):
    """Whether this is the second [what] (a 403 for an add-on, a store limit for a stream type) of this
    household's service within SECOND_WITHIN_S, from another file ([key]): the first is one file's, the
    second the account's. The same file twice is still one file's."""
    with _lock:
        k = (account, service, what, scope)
        first = _seconds.get(k)
        now = _now()
        if first and now - first[0] < SECOND_WITHIN_S and (key is None or first[1] != key):
            return True
        if not first or now - first[0] >= SECOND_WITHIN_S:
            _seconds[k] = (now, key)
        return False


def failed_download(account, service, key):
    """A download_failed for this file: True when 3+ different files of the household's service gave
    one within DOWN_WITHIN_S (the service is down, not the files)."""
    with _lock:
        seen = _failed.setdefault((account, service), {})
        now = _now()
        for k in [k for k, t in seen.items() if now - t > DOWN_WITHIN_S]:
            del seen[k]
        seen[key] = now
        return len(seen) >= DOWN_FILES


def service_down(account, service):
    with _lock:
        seen = _failed.get((account, service)) or {}
        now = _now()
        return sum(1 for t in seen.values() if now - t <= DOWN_WITHIN_S) >= DOWN_FILES


def count(account, service, kind, guess=False):
    """Counts one follow the server makes for this household's service; returns when the count would
    let it through again (0: now, counted). A usenet follow counts toward the hour's usenet budget (a
    guess, toward its smaller share), every follow toward the minute's."""
    with _lock:
        now = _now()
        def window(name, seconds, most):
            times = [t for t in _counts.get((account, service, name), []) if now - t < seconds]
            _counts[(account, service, name)] = times
            return 0 if len(times) < most else times[len(times) - most] + seconds
        wait = window("all", 60, ALL_PER_MINUTE)
        if kind == "usenet":
            wait = max(wait, window("usenet", 3600, USENET_GUESSES if guess else USENET_PER_HOUR))
        if wait:
            return wait
        _counts.setdefault((account, service, "all"), []).append(now)
        if kind == "usenet":
            _counts.setdefault((account, service, "usenet"), []).append(now)
        return 0


def clear():
    """Forgets everything (tests)."""
    with _lock:
        for d in (_windows, _usenet_limit, _refused, _seconds, _failed, _counts, _quiet, _held):
            d.clear()
