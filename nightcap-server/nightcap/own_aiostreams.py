"""Nightcap's own AIOStreams, when this server has one: its address ("http://localhost:3000"), the
household setup new households start from (the template: an AIOStreams setup, as JSON),
the debrid services a household can give a key for, and the kinds of add-on that need one, all kept in
the database (own_aiostreams) by the server's owner. With none kept, households give their own
AIOStreams address. (The server names none of them itself.)

Read from the database when it's needed and kept in memory for READ_EVERY_S, so one put in (or changed)
is used within that time without a restart. There's no timer: a server nobody is using doesn't read it.
"""

import logging
import threading
import time
from urllib.parse import urlsplit

from . import store

log = logging.getLogger(__name__)

READ_EVERY_S = 300

_lock = threading.Lock()
_kept = (None, None)   # (when it was read, monotonic; what was read)


def get():
    """{"url", "template"} of this server's own AIOStreams, or None when it hasn't one."""
    global _kept
    at, value = _kept
    if at is not None and time.monotonic() - at < READ_EVERY_S:
        return value
    # (One reads it again; meanwhile the others go on with what was read before, not waiting on the
    # database. Only the very first read is waited for.)
    if not _lock.acquire(blocking=at is None):
        return value
    try:
        at, value = _kept
        if at is not None and time.monotonic() - at < READ_EVERY_S:
            return value
        try:
            value = _usable(store.q("SELECT url, template, services, need_a_service FROM own_aiostreams", one=True))
        except Exception:
            # (The one read before stays, and the database isn't asked again on every call meanwhile.)
            log.exception("Couldn't read Nightcap's own AIOStreams from the database")
        if value != _kept[1]:
            log.info("Nightcap's own AIOStreams: %s", value["url"] if value else "none (households give their own)")
        _kept = (time.monotonic(), value)
        return value
    finally:
        _lock.release()


def _usable(row):
    if not row:
        return None
    url = (row["url"] or "").strip().rstrip("/")
    p = urlsplit(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        log.warning("Nightcap's own AIOStreams isn't used: its address in the database (%r) isn't an http(s) one", url)
        return None
    if not isinstance(row["template"], dict) or not row["template"]:
        log.warning("Nightcap's own AIOStreams isn't used: its template in the database isn't a setup (a JSON object)")
        return None
    services, need = row["services"], row["need_a_service"]
    if not isinstance(services, dict) or not all(isinstance(k, str) and isinstance(v, str) and k and v
                                                  for k, v in services.items()):
        log.warning("Nightcap's own AIOStreams isn't used: its services in the database aren't {\"id\": \"name\"}")
        return None
    if not isinstance(need, list) or not all(isinstance(k, str) and k for k in need):
        log.warning("Nightcap's own AIOStreams isn't used: its add-ons that need a service aren't [\"kind\", …]")
        return None
    return {"url": url, "template": row["template"], "services": services, "need_a_service": set(need)}


def services():
    """{AIOStreams' id: the name shown} of the debrid services a household can give a key for; {} when
    this server has no AIOStreams of its own."""
    own = get()
    return own["services"] if own else {}


def url():
    """Its address, or None."""
    own = get()
    return own["url"] if own else None


def address():
    """(host, port) of its address, for letting the server reach it (it's on a private address), or None."""
    own = get()
    if not own:
        return None
    p = urlsplit(own["url"])
    return p.hostname.lower(), p.port or (443 if p.scheme == "https" else 80)
