"""Nightcap's own AIOStreams, running next to the server and reachable only by
it (its address is a setting and its template built in or chosen by the owner: own_aiostreams.py). A household's admin gives its
debrid keys (one per service); the server makes the household's setup there from the shared
template (its add-ons, filters and sorting) with those keys, and the household's AIOStreams address is that setup's.
Changing a key updates it. Without any key, the setup has only what needs no debrid service (files
add-ons host themselves, "http"); torrents are never returned (the template excludes "p2p"), so
nothing is ever streamed from other people's computers. The household's extra stream add-ons stay outside it, asked by the server
directly (see playback.addon_results).

A setup is AIOStreams' own: a uuid and a password (made here, kept encrypted with the household's
other secrets), and the password in AIOStreams' encrypted form for its add-on address. If AIOStreams
has lost it (its database was reset), the next update makes it again.

This module only talks to AIOStreams; sources.py decides when (and keeps the secrets).
"""

import base64
import copy
import hashlib
import json
import logging
import re
import secrets
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request

from . import own_aiostreams
from .config import S
from .http import OPENER

log = logging.getLogger(__name__)

PLACEHOLDER = "<template_placeholder>"
TIMEOUT_S = S.advanced.timeouts.aiostreams_seconds


class Unavailable(Exception):
    """Nightcap's AIOStreams didn't answer, or refused the setup (its message says why)."""


class Down(Unavailable):
    """Nightcap's AIOStreams isn't answering at all (starting up after a cold start, say)."""


class Gone(Exception):
    """AIOStreams doesn't know this setup any more."""


# How long a play (or making a setup) waits for Nightcap's AIOStreams while it's starting: it's next to
# the server and takes 30-40 s after a cold start on its half CPU. While it starts
# its port is closed, so each try fails at once and the wait is about this long. That leaves AIOStreams'
# own answer (3-10 s) inside a play's budget (LOOKUP_BUDGET_S, 55 s) and the TV's minute.
WAIT_S = S.advanced.timeouts.aiostreams_setup_wait_seconds
# The AIOStreams the household template was made with and tested on (cloudrun/service.yaml pins it). Another version may treat add-ons differently. Said in the logs at
# start, and on the owner page.
TESTED_VERSION = "2.37.0"


def available():
    """Whether this server has its own AIOStreams."""
    return own_aiostreams.get() is not None


def _own():
    own = own_aiostreams.get()
    if not own:
        raise Unavailable("This server has no AIOStreams of its own")
    return own


def _template():
    return _own()["template"]


def template_hash():
    """A short fingerprint of the household template, kept with each setup made from it, so a
    changed template reaches every household's setup once (sources.update_template)."""
    return hashlib.sha256(json.dumps(_template(), sort_keys=True).encode()).hexdigest()[:16]


def config(keys):
    """The household's setup: the template, with its debrid services on for the keys it has (and off
    for the rest). Template add-ons whose address is left for each household to give (a placeholder)
    are off."""
    cfg = copy.deepcopy(_template())
    for s in cfg.get("services", []):
        key = keys.get(s.get("id"))
        s["enabled"] = bool(key)
        s["credentials"] = {"apiKey": key} if key else {}
    # (The kinds of add-on that only work through a debrid service: AIOStreams refuses a setup that has
    # them on without one. A new one found later is turned off too, see save().)
    need = _own()["need_a_service"]
    for p in cfg.get("presets", []):
        o = p.get("options") or {}
        if PLACEHOLDER in (o.get("manifestUrl"), o.get("url")) or (not keys and p.get("type") in need):
            p["enabled"] = False
    return cfg


def _without(cfg, error):
    """[cfg] with the add-on AIOStreams named as needing a debrid service turned off, or None."""
    m = re.match(r"(.+?) requires at least one usable service", str(error))
    named = [p for p in cfg.get("presets", []) if m and (p.get("options") or {}).get("name") == m.group(1) and p.get("enabled")]
    for p in named:
        p["enabled"] = False
    return cfg if named else None


def _call(method, path, body=None, auth=None, timeout=TIMEOUT_S, quiet=False):
    headers = {"Content-Type": "application/json", "User-Agent": "nightcap-server/1.0"}
    if auth:
        headers["Authorization"] = "Basic " + base64.b64encode(f"{auth[0]}:{auth[1]}".encode()).decode()
    req = Request(f"{_own()['url']}{path}", data=json.dumps(body).encode() if body is not None else None,
                  headers=headers, method=method)
    try:
        with OPENER.open(req, timeout=timeout) as r:
            return json.load(r).get("data") or {}
    except HTTPError as e:
        try:
            error = (json.load(e).get("error") or {})
        except ValueError:
            error = {}
        # (USER_INVALID_DETAILS: no setup with that uuid, or not that password.)
        if e.code in (401, 404) or error.get("code") == "USER_INVALID_DETAILS":
            raise Gone()
        log.warning("AIOStreams refused %s %s: %s %s", method, path, e.code, error.get("code"))
        raise Unavailable(error.get("message") or "Nightcap's AIOStreams refused the setup")
    except Exception as e:
        if not quiet:
            log.warning("AIOStreams didn't answer %s %s: %s", method, path, type(e).__name__)
        raise Down("Nightcap's AIOStreams didn't answer")


def version():
    """The version Nightcap's AIOStreams says it is ("2.37.0"), or None if it didn't answer (not
    logged: while it starts it doesn't, and the caller says what that means)."""
    try:
        return _call("GET", "/api/v1/status", timeout=5, quiet=True).get("version")
    except (Unavailable, Gone):
        return None


def status():
    """For the owner's page: {"version": AIOStreams' version or None if it didn't answer, "tested":
    TESTED_VERSION, "ok": whether they're the same}; None when this server has no AIOStreams."""
    if not available():
        return None
    v = version()
    return {"version": v, "tested": TESTED_VERSION, "ok": v == TESTED_VERSION}


def check_version():
    """At start: a warning in the logs when Nightcap's AIOStreams isn't the version the template was
    tested on. It's asked every few seconds until it answers (it starts next to the server: 30-40 s
    usually, about 3½ minutes the very first time, when it downloads its data lists), for up to
    VERSION_WAIT_S; nothing is logged while it's starting, one warning if it never answered. On a
    thread of its own: the server doesn't wait for it."""
    if not available():
        return

    def ask():
        deadline = time.time() + VERSION_WAIT_S
        while True:
            v = version()
            if v:
                if v != TESTED_VERSION:
                    log.warning("Nightcap's AIOStreams is version %s, not %s (the version its household template "
                                "was tested on): some add-ons may find nothing", v, TESTED_VERSION)
                return
            if time.time() + 5 >= deadline:
                log.warning("Nightcap's AIOStreams didn't answer within %d minutes of the server starting: "
                            "its version is unknown", VERSION_WAIT_S // 60)
                return
            time.sleep(5)
    threading.Thread(target=ask, name="aiostreams-version", daemon=True).start()


# How long the start-up check asks: past AIOStreams' first-ever start (about 3½ minutes).
VERSION_WAIT_S = 300


def manifest_url(setup):
    return f"{_own()['url']}/stremio/{setup['uuid']}/{setup['encryptedPassword']}/manifest.json"


def save(setup, cfg):
    """The household's setup in AIOStreams, made or updated with [cfg]; returns it (new when it was
    made: {"uuid", "password", "encryptedPassword", "url"}) and the names of the add-ons left out.
    AIOStreams refuses a whole setup when one add-on's manifest doesn't answer in time (an extra add-on
    can take over 10 s): that add-on is left out and it's tried again, so the household has sources now, and
    the add-on goes back in at the next update (sources.update_template). Without a debrid key, an
    add-on AIOStreams says needs one (beyond the ones listed as needing one) is turned off the same way."""
    left_out = []
    for _ in range(len(cfg.get("presets", [])) + 1):
        try:
            return _save(setup, cfg), left_out
        except Down:
            raise
        except Unavailable as e:
            slow = _slow(cfg, e)
            if slow:
                log.warning("AIOStreams couldn't reach the add-on %s: the setup is made without it for now", slow)
                left_out.append(slow)
            elif any(s.get("enabled") for s in cfg.get("services", [])) or not _without(cfg, e):
                raise
    raise Unavailable("Nightcap's AIOStreams refused the setup")


def _slow(cfg, error):
    """The add-on whose manifest AIOStreams couldn't fetch (named in its refusal), turned off in
    [cfg]; its name, or None. AIOStreams says "Request for manifest for <name> timed out after 10000ms"
    or "Failed to fetch manifest for <name>: …", the name sometimes followed by " <identifier>"."""
    m = re.match(r"Request for manifest for (.+?) timed out after |Failed to fetch manifest for (.+?): ", str(error))
    if not m:
        return None
    named = m.group(1) or m.group(2)
    for p in cfg.get("presets", []):
        name = (p.get("options") or {}).get("name")
        if p.get("enabled") and name and (named == name or named.startswith(name + " ")):
            p["enabled"] = False
            return name
    return None


def _save(setup, cfg):
    if setup:
        try:
            _call("PUT", "/api/v1/user", {"config": cfg}, auth=(setup["uuid"], setup["password"]))
            return setup
        except Gone:
            log.info("AIOStreams has lost the setup %s…: making it again", setup["uuid"][:8])
    password = secrets.token_urlsafe(24)
    made = _call("POST", "/api/v1/user", {"config": cfg, "password": password})
    setup = {"uuid": made["uuid"], "password": password, "encryptedPassword": made["encryptedPassword"]}
    return {**setup, "url": manifest_url(setup)}
