"""Talking to other services: JSON over HTTP, TMDB, and Cinemeta's episode lists.

Every fetch here goes through checked connections (OPENER): add-on addresses are a household's own,
so the server must not be steered by one (or by a redirect) to itself or the cloud's metadata
service. The host is looked up once, each address checked, and the connection made to that checked
address (so a second lookup can't swap it), again on every redirect. In the cloud only public
addresses on ports 80 and 443 are reached; at home the network's own (a self-hosted AIOStreams at
192.168.x.x:3000) are too. The one exception is Nightcap's own AIOStreams (own_aiostreams.py), which runs
next to the server (localhost:3000): its address is put in the database by the server's owner, so
its exact host and port are let through, nothing else.

A household's own AI address (an OpenAI-compatible service, see ai.py) is fetched the same way, through
CheckedTransport: the AI library's requests go over these checked connections, never redirected, and
Nightcap's own AIOStreams isn't let through for it.
"""

import http.client
import logging
import ipaddress
import json
import socket
import ssl
import re
import threading
from datetime import datetime
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib import parse as urllib_parse
from urllib import request as urllib_request
from urllib.request import HTTPHandler, HTTPSHandler, Request, build_opener

import certifi
import httpx2

from .cache import cached
from . import own_aiostreams
from .config import AT_HOME, S, TMDB_API_KEY

log = logging.getLogger(__name__)


# python.org builds on macOS ship without system CA roots, so use certifi's bundle.
SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())


class Blocked(OSError):
    """An address the server doesn't fetch from."""


def allowed(address, port):
    ip = ipaddress.ip_address(address.split("%")[0])
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    # Never: the server itself, link-local (the cloud's metadata service, 169.254.169.254), and the like.
    if ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified or ip.is_reserved:
        return False
    return True if AT_HOME else ip.is_global and port in (80, 443)


def _connect(host, port, timeout, source_address=None, own_ok=True):
    """A socket to [host]:[port] on an allowed address. Raises Blocked when it has none. [own_ok]: Nightcap's
    own AIOStreams is let through (not for an AI address: nothing there is an AI)."""
    error = None
    trusted = own_ok and ((host or "").lower(), port) == own_aiostreams.address()
    for family, kind, proto, _, address in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM):
        if not trusted and not allowed(address[0], port):
            error = Blocked(f"Not fetched from: {host}")
            continue
        sock = socket.socket(family, kind, proto)
        try:
            if timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
                sock.settimeout(timeout)
            if source_address:
                sock.bind(source_address)
            sock.connect(address)
            return sock
        except OSError as e:
            sock.close()
            error = e
    raise error or OSError(f"No address for {host}")


class _HTTPConnection(http.client.HTTPConnection):
    own_ok = True

    def connect(self):
        self.sock = _connect(self.host, self.port, self.timeout, self.source_address, self.own_ok)


class _HTTPSConnection(http.client.HTTPSConnection):
    own_ok = True

    def connect(self):
        sock = _connect(self.host, self.port, self.timeout, self.source_address, self.own_ok)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


class CheckedHTTPHandler(HTTPHandler):
    def http_open(self, req):
        return self.do_open(_HTTPConnection, req)


class CheckedHTTPSHandler(HTTPSHandler):
    def __init__(self):
        super().__init__(context=SSL_CONTEXT)

    def https_open(self, req):
        return self.do_open(_HTTPSConnection, req, context=self._context)


# No proxies from the environment: they would be connected to instead of the checked address.
OPENER = build_opener(urllib_request.ProxyHandler({}), CheckedHTTPHandler, CheckedHTTPSHandler)


class _AIHTTPConnection(_HTTPConnection):
    own_ok = False


class _AIHTTPSConnection(_HTTPSConnection):
    own_ok = False


class CheckedTransport(httpx2.BaseTransport):
    """The AI library's requests (httpx2, as both AI libraries use) made over the checked connections:
    one connection a request, the answer read whole (an AI's answers aren't streamed here), redirects
    never followed (http.client doesn't). Any failure is the same ConnectError, without the address (a
    household's secret), so the answer can't map which hosts and ports exist."""

    MOST = 16 * 1024 * 1024   # an answer, or a list of models, is far less

    def handle_request(self, request):
        url = request.url
        asked = request.extensions.get("timeout") or {}
        # (Connecting gets the library's connect time, a few seconds, so an address gone dark fails
        # fast; the answer, once connected, its read time: an AI can take minutes to write.)
        connect = asked.get("connect") or S.advanced.timeouts.http_seconds
        read = asked.get("read") or connect
        if url.scheme == "https":
            conn = _AIHTTPSConnection(url.host, url.port or 443, timeout=connect, context=SSL_CONTEXT)
        elif url.scheme == "http":
            conn = _AIHTTPConnection(url.host, url.port or 80, timeout=connect)
        else:
            raise httpx2.ConnectError("Couldn't reach that AI address", request=request)
        try:
            conn.connect()
            conn.sock.settimeout(read)
            target = url.raw_path.decode("ascii") or "/"
            conn.request(request.method, target, body=request.read(), headers=dict(request.headers))
            r = conn.getresponse()
            body = r.read(self.MOST + 1)
            if len(body) > self.MOST:
                raise OSError("too big")
            return httpx2.Response(r.status, headers=r.getheaders(), content=body, request=request)
        except (OSError, http.client.HTTPException):
            raise httpx2.ConnectError("Couldn't reach that AI address", request=request) from None
        finally:
            conn.close()


def checked_http_client():
    """An httpx2 client for the AI library that reaches only allowed addresses (see CheckedTransport)."""
    return httpx2.Client(transport=CheckedTransport(), follow_redirects=False, trust_env=False)


class Backoff:
    """A service's "too many requests": when it says so, every request to it (from any thread or
    profile: the server is one process) waits as long as it asks, at most [most] seconds, then goes
    on. Nothing waits otherwise: requests aren't queued or paced, so a search never waits behind a
    Home being built."""

    def __init__(self, most):
        self.most = most
        self.until = 0.0
        self.lock = threading.Lock()

    def wait(self):
        delay = self.until - time.monotonic()
        if delay > 0:
            time.sleep(delay)

    def hold(self, seconds):
        with self.lock:
            self.until = max(self.until, time.monotonic() + min(seconds, self.most))


def get_json(url, headers=None, retries=S.advanced.timeouts.http_retries, timeout=S.advanced.timeouts.http_seconds,
             backoff=None):
    """[backoff]: the service's Backoff: waited on (only while the service has said to wait), and held
    when it answers "too many requests", for as long as it says (Retry-After), or a little longer each
    time, never more than its most."""
    for attempt in range(retries + 1):
        if backoff:
            backoff.wait()
        try:
            # strem.io rejects the default Python-urllib user agent.
            req = Request(url, headers={"User-Agent": "nightcap-server/1.0", **(headers or {})})
            with OPENER.open(req, timeout=timeout) as r:
                return json.load(r)
        except HTTPError as e:
            if e.code == 429 and attempt < retries:
                after = e.headers.get("Retry-After") if e.headers else None
                wait = float(after) if after and after.replace(".", "", 1).isdigit() else 1 + attempt
                if backoff:
                    backoff.hold(wait)
                else:
                    time.sleep(min(wait, 10))
                continue
            if e.code == 404:
                return None
            raise
        except URLError as e:
            if attempt < retries and not isinstance(e.reason, Blocked):
                time.sleep(1)
                continue
            raise


def get_text(url, most, timeout=S.advanced.timeouts.http_seconds):
    """A text file (a channel list), refused (ValueError) once it's over [most] bytes. Errors never
    carry the address: it may be a household's secret."""
    req = Request(url, headers={"User-Agent": "nightcap-server/1.0"})
    with OPENER.open(req, timeout=timeout) as r:
        raw = r.read(most + 1)
    if len(raw) > most:
        raise ValueError(f"The list is over {most // (1024 * 1024)} MB")
    return raw.decode("utf-8", errors="replace")


TMDB_BACKOFF = Backoff(S.advanced.tmdb.most_wait_seconds)


def tmdb(path, **params):
    headers = {"accept": "application/json"}
    # v4 read-access tokens are JWTs; v3 keys go in the query string.
    if TMDB_API_KEY.startswith("eyJ"):
        headers["Authorization"] = f"Bearer {TMDB_API_KEY}"
    else:
        params["api_key"] = TMDB_API_KEY
    _count(path)
    return get_json(f"https://api.themoviedb.org/3{path}?{urlencode(params)}", headers, backoff=TMDB_BACKOFF,
                    retries=S.advanced.tmdb.retries)


# TMDB requests made, by kind (the path without its ids), for the logs and for measuring.
TMDB_CALLS = {}


def _count(path):
    kind = re.sub(r"/\d+", "/{id}", path)
    TMDB_CALLS[kind] = TMDB_CALLS.get(kind, 0) + 1


def cinemeta(ctype, imdb_id):
    meta = cached(f"cinemeta:{ctype}:{imdb_id}", lambda: (get_json(
        f"https://v3-cinemeta.strem.io/meta/{ctype}/{imdb_id}.json") or {}).get("meta") or {},
        ttl=S.advanced.cache.cinemeta_hours * 3600)
    return with_tmdb_episodes(meta) if ctype == "series" else meta


def with_tmdb_episodes(meta):
    """Cinemeta's episode list can lag a daily show by days, so a show's latest season gets TMDB's later episodes too, with their air dates
    (the dates decide when each counts as out). Only where the two clearly number that season alike:
    TMDB has every episode Cinemeta has, and dates Cinemeta's last one within a day of Cinemeta's own
    date (a finale TMDB splits in two, or seasons cut differently, fail that). Added in order, from the
    one after Cinemeta's last, stopping at the first TMDB hasn't dated. TMDB's season is kept as long
    as Cinemeta's list; a failed ask isn't kept, so it's tried again next time."""
    tmdb_id = meta.get("moviedb_id")
    eps = [v for v in meta.get("videos") or [] if (v.get("season") or 0) > 0 and v.get("episode")]
    if meta.get("type") != "series" or not tmdb_id or not eps:
        return meta
    season = max(v["season"] for v in eps)
    mine = {v["episode"]: v for v in eps if v["season"] == season}
    try:
        found = cached(f"tmdb-season:{tmdb_id}:{season}", lambda: tmdb(f"/tv/{tmdb_id}/season/{season}") or {},
                       ttl=S.advanced.cache.cinemeta_hours * 3600)
    except Exception as e:
        log.warning("TMDB episodes for %s unavailable: %s", meta.get("id"), e)
        return meta
    theirs = {e.get("episode_number"): e for e in found.get("episodes") or [] if e.get("episode_number")}
    last = max(mine)
    if not mine.keys() <= theirs.keys() or not _same_day(mine[last].get("released"), theirs[last].get("air_date")):
        return meta
    extra = []
    n = last + 1
    while (e := theirs.get(n)) and e.get("air_date"):
        extra.append({"id": f"{meta['id']}:{season}:{n}", "season": season, "episode": n, "number": n,
                      "name": e.get("name") or f"Episode {n}", "overview": e.get("overview") or "",
                      "released": f"{e['air_date']}T00:00:00.000Z"})
        n += 1
    return {**meta, "videos": (meta.get("videos") or []) + extra} if extra else meta


def _same_day(released, air_date):
    """Whether Cinemeta's date ("2026-11-11T00:00:00.000Z") and TMDB's ("2026-11-11") are within a day."""
    try:
        a = datetime.strptime((released or "")[:10], "%Y-%m-%d")
        b = datetime.strptime(air_date or "", "%Y-%m-%d")
    except ValueError:
        return False
    return abs((a - b).days) <= 1
