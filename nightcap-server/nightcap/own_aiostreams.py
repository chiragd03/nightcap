"""Nightcap's own AIOStreams, when this server has one: its address (the setting own_aiostreams_url,
OWN_AIOSTREAMS_URL), the household setup new households start from (the template: an AIOStreams
setup, as JSON), the debrid services a household can give a key for, and the kinds of add-on that need
one. With no address, households give their own AIOStreams address.

The template is the one the server's owner chose (the own_aiostreams table), or else the built-in
one. The built-in files are optional (in PRIVATE, kept out of the repository): template.json,
services.json ({AIOStreams' id: the name shown}) and need_a_service.json (["kind", …]). Without them,
only an owner's template is used, with no services offered and no kinds marked. (The server names
none of them itself.)

Read when it's needed and kept in memory for READ_EVERY_S, so a template put in (or changed) is used
within that time without a restart. There's no timer: a server nobody is using doesn't read it.
"""

import json
import logging
import os
import threading
import time
from urllib.parse import urlsplit

from . import store
from .config import S

log = logging.getLogger(__name__)

READ_EVERY_S = 300
PRIVATE = os.path.join(os.path.dirname(__file__), "private", "aiostreams")

_lock = threading.Lock()
_kept = (None, None)   # (when it was read, monotonic; what was read)
_said = None           # the last thing logged about it, so it's said once


def _say(level, text, *args):
    global _said
    if (text, args) != _said:
        _said = (text, args)
        log.log(level, text, *args)


def get():
    """{"url", "template", "services", "need_a_service"} of this server's own AIOStreams, or None when
    it hasn't one."""
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
            value = _read()
        except Exception:
            # (The one read before stays, and the database isn't asked again on every call meanwhile.)
            log.exception("Couldn't read Nightcap's own AIOStreams")
        _kept = (time.monotonic(), value)
        return value
    finally:
        _lock.release()


def _built_in(name, kind):
    """A built-in file's JSON, or None when it isn't there."""
    path = os.path.join(PRIVATE, name)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        value = json.load(f)
    if not isinstance(value, kind):
        raise ValueError(f"{path} isn't a JSON {kind.__name__}")
    return value


def _read():
    url = (S.server.own_aiostreams_url or "").strip().rstrip("/")
    if not url:
        _say(logging.INFO, "Nightcap's own AIOStreams: none (households give their own)")
        return None
    p = urlsplit(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        _say(logging.WARNING, "Nightcap's own AIOStreams isn't used: its address (%r) isn't an http(s) one", url)
        return None
    row = store.q("SELECT template FROM own_aiostreams", one=True)
    template = row["template"] if row else _built_in("template.json", dict)
    if not template:
        _say(logging.WARNING, "Nightcap's own AIOStreams isn't used: it has no template (none chosen, none built in)")
        return None
    if not isinstance(template, dict):
        _say(logging.WARNING, "Nightcap's own AIOStreams isn't used: its template isn't a setup (a JSON object)")
        return None
    services = _built_in("services.json", dict) or {}
    need = _built_in("need_a_service.json", list) or []
    if not all(isinstance(k, str) and isinstance(v, str) and k and v for k, v in services.items()):
        _say(logging.WARNING, "Nightcap's own AIOStreams isn't used: its services aren't {\"id\": \"name\"}")
        return None
    if not all(isinstance(k, str) and k for k in need):
        _say(logging.WARNING, "Nightcap's own AIOStreams isn't used: its add-ons that need a service aren't [\"kind\", …]")
        return None
    # (Only the services the template has: a household's key for another would never be used.)
    has = {s.get("id") for s in template.get("services") or [] if isinstance(s, dict)}
    services = {k: v for k, v in services.items() if k in has}
    _say(logging.INFO, "Nightcap's own AIOStreams: %s (%s template)", url, "the owner's" if row else "the built-in")
    return {"url": url, "template": template, "services": services, "need_a_service": set(need)}


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
