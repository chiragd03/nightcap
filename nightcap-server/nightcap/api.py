"""The HTTP API the TV and the web app talk to.

A device (a TV, or a browser on the web pages) first joins a household (/join, see devices.py)
and gets its own key, which it sends with every request in X-Device-Key; a missing or unknown key
is answered 401 with X-Join-Again, and the device goes back to joining. Changing the household's
sources and keys, its settings, and its devices takes its admin profile (from any of its devices). Every request is also for one profile of that household, named
in X-Profile; one from another household, or one that no longer exists, is answered 404 with
X-Profile-Unknown, and the TV asks who's watching again. ("Who's watching" itself, profiles.json,
needs only the key.)
"""

import base64
import binascii
import json
import logging
import mimetypes
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Literal
from urllib.parse import unquote

from fastapi import Depends, FastAPI, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.exceptions import HTTPException

from . import (schema, accounts, adminpin, aiostreams, appupdate, devices, filetracks, playlinks, discovery, home, livetv, moving, owner, pages, playback, playon, profiles, recommend, refresh,
               search, send, sources, store, tries, watching, widgets)
from .cache import cached, changed
from .version import VERSION
from .ai import AIUnavailable, usable as ai_usable, usage_summary
from .config import MAX_BODY_BYTES, MAX_IMPORT_BYTES, MODE, OPEN_JOIN, S, SERVER_NAME, WEB_DIR, PUBLIC_URL, limits
from .context import me, set_profile
from .errors import Forbidden, NotFound

log = logging.getLogger(__name__)

TITLE_ID = r"^tt\d+$"
VIDEO_ID = r"^tt\d+(:\d+:\d+)?$"


# ---------- Answers ----------

def answer(body, status=200, max_age=0, headers=None):
    """JSON with how long the device may keep it. Answers depend on who's asking (the device's
    household, the profile), so a cache must keep them apart, and only the device itself keeps them.
    One not to be kept at all (sources, devices, sent links, play answers…) isn't stored either: a
    browser would otherwise leave it in its disk cache, for the next person at that computer."""
    cache_control = f"private, max-age={max_age}" if max_age else "no-store"
    return JSONResponse(body, status, headers={"Cache-Control": cache_control,
                                               "Vary": "X-Profile, X-Device-Key", **(headers or {})})


def error(message, status, max_age=0, headers=None):
    return answer({"error": message}, status, max_age, headers)


OK = {"ok": True}


class Problem(Exception):
    """An answer other than the usual one, from deep inside a request (see the handler below)."""

    def __init__(self, message, status, headers=None):
        super().__init__(message)
        self.status, self.headers = status, headers


async def started(app):
    # The database's tables first, if this version changed them (schema.py).
    await run_in_threadpool(schema.apply)
    # Nothing else starts: all work is done as a device asks for it (see refresh.py).
    discovery.start()
    # (Only a warning in the logs if Nightcap's AIOStreams isn't the tested version; nothing waits for it.)
    aiostreams.check_version()
    yield


app = FastAPI(title="Nightcap", docs_url=None, redoc_url=None, openapi_url=None, lifespan=started)
# Answers of a kilobyte or more go out gzipped to whatever takes it (the TV's client does, by itself):
# data out is a hosting cost that grows with use. One that's compressed already says so
# (Content-Encoding) and is left alone: the web app's files (web_app), a households file (export).
app.add_middleware(GZipMiddleware, minimum_size=1000)
# No CORS: the TV is an app and the web app is served from here, so no other website may call this
# server from a visitor's browser.

# Browser protections, on every answer (the TV ignores them). No other site may show these pages in
# a frame; the web app's scripts come only from here. Pictures, video and subtitles come from many
# places (TMDB, add-ons, debrid services, whatever a playback link redirects to), so those stay open;
# the weather search's city lookup is the one other service the app calls. In the cloud, browsers are
# told to use HTTPS only.
CSP = "; ".join([
    # WebAssembly may compile, and workers start from the page's own blob: addresses: the web player's
    # Dolby/DTS decoders (Mediabunny) are WebAssembly in a worker. Neither lets in script from elsewhere.
    "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'", "font-src 'self'",
    "img-src 'self' data: blob: https: http:", "media-src 'self' blob: https: http:",
    # (blob: is only the page's own: a Live TV stream's playlist made in the page, as a household's
    # own stream handler may do, which the player then loads.)
    "connect-src 'self' blob: https: http:", "object-src 'none'", "base-uri 'self'", "form-action 'self'",
    "frame-ancestors 'none'",
])
# The web app's pages (/app/) and the Samsung/LG TV app's (/app/tv/) also play in YouTube's own player:
# trailers and the YouTube add-on's videos. So its script and
# its frame are let in there. Everything else, the API too, keeps CSP as it is.
APP_CSP = CSP.replace("script-src 'self' 'wasm-unsafe-eval'",
                     "script-src 'self' 'wasm-unsafe-eval' https://www.youtube.com https://s.ytimg.com") \
    + "; frame-src https://www.youtube.com https://www.youtube-nocookie.com"
assert APP_CSP.count("youtube") == 3
SECURITY_HEADERS = {
    "Content-Security-Policy": CSP,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    **({} if MODE == "home" else {"Strict-Transport-Security": "max-age=31536000"}),
}


@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    for name, value in SECURITY_HEADERS.items():
        response.headers.setdefault(name, value)
    return response


@app.exception_handler(Problem)
async def on_problem(request, e):
    return error(str(e), e.status, headers=e.headers)


@app.exception_handler(RequestValidationError)
async def on_bad_request(request, e):
    return error(bad_request(e), 400)


@app.exception_handler(ValueError)
async def on_bad_value(request, e):
    return error(str(e), 400)


@app.exception_handler(LookupError)  # errors.NotFound, and "not a known title"
async def on_not_found(request, e):
    return error(str(e), 404)


@app.exception_handler(Forbidden)
async def on_forbidden(request, e):
    return error(str(e), 403)


@app.exception_handler(HTTPException)
async def on_http(request, e):
    return error("not found" if e.status_code == 404 else str(e.detail), e.status_code, max_age=120 if e.status_code == 404 else 0)


# ---------- Who the request is for ----------

def _device(request):
    """The device making the request (401 for one that hasn't joined)."""
    device = devices.for_key(request.headers.get("X-Device-Key"))
    if not device:
        # The device forgets this server's household and joins again.
        raise Problem("join a household first", 401, {"X-Join-Again": "1"})
    return device


def _household(request):
    return _device(request)["account_id"]


async def for_device(request: Request):
    """The device making the request, for pages about the household rather than one profile."""
    return await run_in_threadpool(_device, request)


def _admin_device(request):
    """The device, acting as its household's admin profile (X-Profile) with an admin session the
    PIN unlocked (X-Admin-Session, see adminpin.py). Naming the admin profile alone isn't enough."""
    device = _device(request)
    named = request.headers.get("X-Profile")
    if not named or not _profile_in(named, device["account_id"])["is_admin"]:
        raise Forbidden("Only the household's admin profile can do that")
    try:
        adminpin.require(device["id"], named, request.headers.get("X-Admin-Session"))
    except adminpin.PinNeeded:
        # The app asks the admin to set a PIN, then tries again.
        raise Problem("set the admin PIN first", 403, {"X-Admin-Pin-Unset": "1"})
    except Forbidden as e:
        # The app asks for the PIN, then tries again.
        raise Problem(str(e), 403, {"X-Admin-Locked": "1"})
    return device


async def for_admin(request: Request):
    """A device acting as its household's admin profile, unlocked with the PIN: it may change
    sources, keys, settings, profiles and devices. Returns the device."""
    return await run_in_threadpool(_admin_device, request)


def _profile_in(profile_id, account_id):
    p = store.profile(profile_id)
    if not p or p["account_id"] != account_id:
        # The TV drops its choice on this header and asks who's watching again.
        raise Problem("unknown profile", 404, {"X-Profile-Unknown": "1"})
    return p


async def for_profile(request: Request):
    """The profile the TV named, in its own household; the rest of the request runs as it."""
    def check():
        account = _household(request)
        named = request.headers.get("X-Profile")
        if not named:
            raise Problem("name the profile in X-Profile", 400)
        return _profile_in(named, account)
    p = await run_in_threadpool(check)
    set_profile(str(p["id"]))
    return p


async def json_body(request: Request):
    """The request's JSON object (400 if it isn't one)."""
    return await read_json(request, MAX_BODY_BYTES)


async def read_body(request, most):
    """The request's body, refused (413) as soon as it's over [most] bytes: from its Content-Length
    before reading any, else while it comes in, so a huge one is never held in memory."""
    try:
        declared = int(request.headers.get("content-length") or 0)
    except ValueError:
        raise Problem("bad request: Content-Length", 400)
    if declared > most:
        raise Problem("too big", 413)
    raw = bytearray()
    async for chunk in request.stream():
        raw += chunk
        if len(raw) > most:
            raise Problem("too big", 413)
    return bytes(raw)


async def read_json(request, most):
    raw = await read_body(request, most)
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        raise Problem("bad request: not JSON", 400)
    if not isinstance(body, dict):
        raise Problem("bad request: expected a JSON object", 400)
    return body


Profile = Depends(for_profile)
Device = Depends(for_device)
Admin = Depends(for_admin)
Body = Depends(json_body)


def bad_request(e):
    first = e.errors()[0] if e.errors() else {}
    where = ".".join(str(x) for x in first.get("loc", ()) if x != "body")
    return f"bad request: {where} {first.get('msg', '')}".strip()


def parsed(model, most=MAX_BODY_BYTES):
    """The request's JSON (whatever its Content-Type says, as the TV sends it), checked
    against [model]; at most [most] bytes."""
    async def read(request: Request):
        return await read_json(request, most)

    async def check(body: dict = Depends(read)):
        try:
            return model.model_validate(body)
        except ValidationError as e:
            raise Problem(bad_request(e), 400)
    return Depends(check)


class Model(BaseModel):
    # The TV may send more than a route uses (newer fields for older servers).
    model_config = ConfigDict(extra="allow")


class Source(Model):
    """Where a play or action came from, as the TV reports it (see watching.source_of)."""

    def source(self):
        return watching.source_of(self.model_dump())


# ---------- Home, Browse, title pages ----------

@app.get("/launcher/home.json", dependencies=[Profile])
def home_feed():
    """Home as last saved, at once; "stale": true means a refresh (below) would change it."""
    try:
        return answer(refresh.home())
    except Exception:
        log.exception("Launcher feed failed")
        return error("feed unavailable", 503, max_age=120)


@app.post("/launcher/refresh", dependencies=[Profile])
def refresh_home():
    """Brings this profile's Home up to date (its recommendations too, when they're due) and
    answers the new Home. Asked for by the app when Home was stale, or after something changed;
    however often it's asked, Home is built at most once a minute."""
    try:
        return answer(refresh.refresh())
    except Exception:
        log.exception("Refreshing Home failed")
        return error("refresh failed", 503)


@app.get("/launcher/page/{kind}.json", dependencies=[Profile])
def page_feed(kind: Literal["tv", "movie"]):
    """The Shows ("tv") or Movies ("movie") page, as Home: as last saved, at once; "stale": true means
    a refresh (below) would change it; "building": true, it's being made for the first time."""
    try:
        return answer(refresh.page(kind))
    except Exception:
        log.exception("Page %s failed", kind)
        return error("page unavailable", 503, max_age=120)


@app.post("/launcher/page/{kind}/refresh", dependencies=[Profile])
def refresh_page(kind: Literal["tv", "movie"]):
    """Brings the Shows or Movies page up to date and answers it (built at most once a minute). It asks
    the AI nothing: Home's refresh keeps the recommendations it's made from up to date."""
    try:
        return answer(refresh.refresh_page(kind))
    except Exception:
        log.exception("Refreshing page %s failed", kind)
        return error("refresh failed", 503)


@app.post("/launcher/browse/warm", dependencies=[Profile])
def warm_browse():
    """Builds the Browse pages of the profile's Home ahead of time, so opening a tile is instant."""
    home.warm_browse_pages(refresh.browse_keys())
    return answer(OK)


@app.get("/launcher/browse/{key}.json", dependencies=[Profile])
def browse(key: str):
    """A Browse tile's page (lang:hi, genre:53, top10:IN, soon), or a genre of the Shows or Movies
    page (genre:80:tv, genre:28:movie)."""
    key = unquote(key)
    if not re.match(r"^[a-z0-9]+(:[A-Za-z0-9]+)?(:(tv|movie))?$", key):
        return error("bad key", 400)
    try:
        page = cached(f"browse:{key}", lambda: home.browse_page(key), ttl=S.advanced.cache.browse_hours * 3600)
        if page:
            page = home.browse_for_me(page, key)
    except Exception:
        log.exception("Browse page %s failed", key)
        return error("page unavailable", 503)
    return answer(page, max_age=600) if page else error("not found", 404, max_age=120)


@app.get("/launcher/title/{ctype}/{tt}.json", dependencies=[Profile])
def title(ctype: Literal["movie", "series"], tt: str):
    try:
        return answer(cached(f"title:{tt}", lambda: pages.title_page(ctype, tt), ttl=S.advanced.cache.title_minutes * 60), max_age=300)
    except Exception:
        log.exception("Title page failed for %s", tt)
        return error("title unavailable", 503)


@app.get("/launcher/similar/{ctype}/{tt}.json", dependencies=[Profile])
def similar(ctype: Literal["movie", "series"], tt: str):
    """The AI's picks if they've been worked out, otherwise TMDB's own list ("ai": false): then
    POST .../rank (below) asks for the AI's."""
    page = pages.similar_page(ctype, tt)
    return answer(_for_me(page), max_age=3600 if page["ai"] else 0)


@app.post("/launcher/similar/{ctype}/{tt}/rank", dependencies=[Profile])
def rank_similar(ctype: Literal["movie", "series"], tt: str):
    """Works out the AI's picks for More like this now, and answers them (TMDB's list again if the
    AI isn't available)."""
    try:
        page = pages.rank_similar(ctype, tt)
    except AIUnavailable as e:
        log.info("More like this for %s without the AI: %s", tt, e)
        page = pages.similar_page(ctype, tt)
    return answer(_for_me(page), max_age=3600 if page["ai"] else 0)


def _for_me(page):
    """More like this without what this profile isn't interested in."""
    skip = store.not_interested(me())
    return {**page, "items": [i for i in page["items"] if i["id"] not in skip]} if skip else page


@app.get("/launcher/person/{pid}.json", dependencies=[Profile])
def person(pid: str):
    if not pid.isdigit():
        return error("not found", 404, max_age=120)
    return answer(cached(f"person:{pid}", lambda: pages.person_page(pid), ttl=S.advanced.cache.person_hours * 3600), max_age=3600)


@app.get("/launcher/preview/{key}.json", dependencies=[Profile])
def preview(key: str):
    """Posters for a settings preview (lang:hi, top10:IN)."""
    key = unquote(key)
    # (A language's series are those streaming in the household's country.)
    where = f":{accounts.country()}" if key.startswith("lang:") else ""
    found = cached(f"preview:{key}{where}", lambda: profiles.settings_preview(key), ttl=S.advanced.cache.preview_hours * 3600)
    return answer(found, max_age=3600) if found else error("not found", 404, max_age=120)


@app.get("/launcher/widgets.json", dependencies=[Profile])
def widget_values():
    return answer(widgets.widgets(), max_age=60)


# ---------- Search ----------

def query(q):
    q = (q or "").strip()[:120]
    if not q:
        raise Problem("empty search", 400)
    return q


@app.get("/launcher/search/quick.json", dependencies=[Profile])
def quick_search(q: str = ""):
    q = query(q)
    try:
        found = cached(f"quick:{q.lower()}", lambda: search.quick_search(q), ttl=S.advanced.cache.quick_search_minutes * 60)
        # (The known titles like it are added for this answer only: this profile's Home is among them.)
        return answer(search.known_matches(q, found), max_age=600)
    except Exception:
        log.exception("Search failed for %r", q)
        return error("search failed", 503)


@app.get("/launcher/search/ai.json", dependencies=[Profile])
def ai_search(q: str = ""):
    """Smart Search. When the AI can't be used (no key, no model, the limit), the title search with a
    "note" saying why; when it failed this time only, a 503, so the apps offer to try again."""
    q = query(q)
    try:
        found = search.ai_search_cards(q)
        # A fallback answer (no AI) isn't worth keeping: the AI may be back soon.
        return answer(found, max_age=0 if found.get("note") else 3600)
    except AIUnavailable as e:
        # (The AI failed this time only: the apps offer to try again.)
        log.info("Smart search for %r: %s", q, e)
        return error("smart search failed", 503)
    except Exception:
        log.exception("Search failed for %r", q)
        return error("search failed", 503)


@app.get("/launcher/recent.json", dependencies=[Profile])
def recent_searches():
    # (With it, what Search needs when it opens: whether to offer Smart Search, which it can't once
    # the month's AI limit is reached either.)
    return answer({"recent": store.recent_searches(me()), "aiAvailable": ai_usable()})


class Searched(Model):
    q: str = ""


@app.post("/launcher/recent", dependencies=[Profile])
def searched(body: Searched = parsed(Searched)):
    """A search was run: answers this profile's recent searches."""
    q = " ".join(body.q.split())
    if not 2 <= len(q) <= 120:
        return error("A search needs 2 to 120 characters", 400)
    store.add_search(me(), q)
    return answer({"recent": store.recent_searches(me())})


# ---------- Playing ----------

@app.get("/launcher/play/{ctype}/{vid}.json", dependencies=[Profile])
def play(request: Request, ctype: Literal["movie", "series"], vid: str, binge: str | None = None, more: bool = False,
         audio: str | None = Query(None, pattern=r"^(\*|[a-z]{2,3})?$"), device=Device):
    """Ranked streams and subtitles for the Nightcap player, with this device's playback links in
    place of the add-ons' own (see playlinks.py). Never kept by a cache. more=1: every source,
    when the answer said there are more (moreSources). audio: the language picked in the player ("hi"),
    or * for the one saved for this title: its files first."""
    vid = unquote(vid)
    if not re.match(VIDEO_ID, vid):
        return error("bad id", 400)
    try:
        info = playback.play_info(ctype, vid, binge, more, audio)
        base = PUBLIC_URL or str(request.base_url).rstrip("/")
        return JSONResponse(playlinks.issue(info, device["account_id"], device["id"], base),
                            headers={"Cache-Control": "no-store"})
    except Exception:
        log.exception("Streams failed for %s", vid)
        return error("streams unavailable", 503)


@app.api_route("/s/{token}/{n}", methods=["GET", "HEAD"], include_in_schema=False)
def playback_link(request: Request, token: str, n: int):
    """A playback link: on to where the add-on points now. 410 (X-Link-Expired) once it has expired
    or its device has been removed: the player renews it (or asks for a fresh play answer).

    Asked with X-Where (1 or 2), where it leads is said as JSON instead ({"url", "direct"}): a browser
    can't read a redirect's address, a stream a device opens itself (Live TV's optional extension) needs it, and the TV
    asks first, so a file that's gone fails in a second, not in libVLC's 30. It's the same address the
    redirect would give this device.

    A player that asks with X-Where: 2 (the TV) is told why a file can't be had:
    X-Dead: file (gone: the next file), X-Dead: account with X-Service and X-Kind (the household's
    debrid service refused, X-Why: key, plan or limit), X-Preparing (being
    downloaded), X-Busy with X-Service, X-Kind and Retry-After (the service is limiting the household:
    wait, or go on with other files). Every other player gets a plain 502 for those, and
    moves on to its next file."""
    newer = request.headers.get("X-Where") == "2"
    plain = {"Cache-Control": "no-store"}
    gone = lambda extra=None: error("The add-on didn't hand over this file", 502, headers={**plain, **(extra if newer and extra else {})})
    try:
        target, direct = playlinks.where(token, n, request.url.query, newer=newer)
    except playlinks.Expired:
        return error("This playback link has expired", 410, headers={"X-Link-Expired": "1"})
    except playlinks.Starting:
        # (Nightcap's AIOStreams after a cold start: the player waits and asks again, same file.)
        return error("Starting up, try again in a moment", 503, headers={**plain, "Retry-After": "5", "X-Starting": "1"})
    except playlinks.Busy as e:
        if not e.until:
            # (Busy about this one file: worth one more try in a moment.)
            return error("The file's service is busy, try again in a moment", 503, headers={**plain, "Retry-After": "5"})
        wait = max(1, int(e.until - time.time()) + 1)
        if not newer:
            return gone()
        return error("The streaming service is busy", 503, headers={
            **plain, "Retry-After": str(wait), "X-Busy": "1", "X-Service": e.service or "", "X-Kind": e.kind or ""})
    except playlinks.Refused as e:
        return gone({"X-Dead": "account", "X-Service": e.service or "", "X-Kind": e.kind or "", "X-Why": e.why})
    except playlinks.Gone:
        return gone({"X-Dead": "file"})
    except playlinks.Preparing:
        return gone({"X-Preparing": "1"})
    except playlinks.Unavailable:
        # (The player moves on to the next source.)
        return gone()
    if request.headers.get("X-Where") in ("1", "2"):
        return JSONResponse({"url": target, "direct": direct}, headers={**plain, "Referrer-Policy": "no-referrer"})
    return RedirectResponse(target, 302, headers={**plain, "Referrer-Policy": "no-referrer"})


class Renewal(Model):
    token: str = Field(pattern=r"^[A-Za-z0-9_-]{16,64}$")
    runtimeMs: int = Field(0, ge=0, le=48 * 3600_000)


@app.post("/launcher/play/renew", dependencies=[Profile])
def renew_play(body: Renewal = parsed(Renewal), device=Device):
    """A play's links again, under a new token, after they expired (a long pause): the same files, no
    new lookup. {"token", "linksExpireAt"}: the player puts the new token in its links. 410 once
    they're too old (a day past), or not this device's: then a fresh play answer."""
    try:
        return answer(playlinks.renew(body.token, device["account_id"], device["id"], body.runtimeMs // 1000))
    except playlinks.Expired:
        return error("These playback links are too old", 410)


# A language picked in the player is looked for in this many versions at most, all at once.
AUDIO_CHECK_MOST = 4
AUDIO_CHECK_SECONDS = S.advanced.timeouts.audio_check_seconds


class AudioCheck(Model):
    # The device's own playback links ({server}/s/{token}/{n}) for the versions to look in.
    links: list[str] = Field(min_length=1, max_length=AUDIO_CHECK_MOST)


@app.post("/launcher/audio-languages", dependencies=[Profile])
def audio_languages(body: AudioCheck = parsed(AudioCheck), device=Device):
    """The audio languages each version really has, read from the start of its file (its track list,
    not its file name), for a viewer who picked a language the playing one hasn't: two-letter codes in
    track order ("und" for a track that doesn't say; a track named "Hindi" with no language is "hi"),
    or null where it couldn't be read. Nothing is kept."""
    def check(link):
        m = re.search(r"/s/([A-Za-z0-9_-]{16,64})/(\d{1,4})$", link)
        if not m:
            return None
        try:
            read = playlinks.reader(m.group(1), int(m.group(2)), device["account_id"], AUDIO_CHECK_SECONDS)
            return filetracks.audio_languages(read)
        except (playlinks.Expired, playlinks.Unavailable):
            return None
        except Exception:
            log.exception("Couldn't read a file's audio tracks")
            return None
    with ThreadPoolExecutor(len(body.links)) as pool:
        found = list(pool.map(check, body.links))
    return answer({"languages": found})


class Position(Source):
    type: Literal["movie", "series"]
    id: str = Field(pattern=VIDEO_ID)
    position: int = Field(0, ge=0)
    duration: int = Field(0, ge=0)
    played: int | None = None
    # The audio language picked in the player ("hi"), once heard; "" clears it.
    audioPick: str | None = Field(None, pattern=r"^([a-z]{2,3})?$")
    # The subtitles picked in the player ("eng", "pt-br", or "off").
    subtitlePick: str | None = Field(None, pattern=r"^(off|[a-z]{2,3}(-[a-z0-9]{2,4})?)$")


def save_position(body: Position, device):
    """Progress, then the title's audio and subtitle picks if any came. True unless a pick couldn't be
    saved (the TV sends it again with the next save)."""
    watching.save_progress(body.type, body.id, body.position, body.duration, body.played, body.source(), device["id"])
    try:
        if body.audioPick is not None:
            watching.save_audio_pick(body.id, body.audioPick)
        if body.subtitlePick is not None:
            watching.save_subtitle_pick(body.id, body.subtitlePick)
        return True
    except Exception:
        log.exception("Couldn't save a pick for %s", body.id)
        return False


@app.post("/launcher/progress", dependencies=[Profile])
def progress(body: Position = parsed(Position), device=Device):
    try:
        if not save_position(body, device):
            return error("audio pick not saved", 503)
    except Exception:
        log.exception("Couldn't save progress for %s", body.id)
        return error("not saved", 503)
    return answer(OK)


class Leaving(Position):
    reason: str | None = None


@app.post("/launcher/exit", dependencies=[Profile])
def leaving(body: Leaving = parsed(Leaving), device=Device):
    """Leaving early, with the answer to "Not for me / I'll finish later" (or none)."""
    save_position(body, device)
    reason = {"not_for_me": "not_my_taste", "later": "pausing"}.get(body.reason)
    imdb_id = body.id.split(":")[0]
    if reason:
        store.leave_early(me(), body.id, reason)
    else:
        store.prompt_shown(me(), imdb_id, "early_exit")
    changed(imdb_id)
    return answer(OK)


class WontPlay(Model):
    id: str = Field(pattern=VIDEO_ID)
    addon: str = Field(min_length=1, max_length=80)
    filename: str | None = Field(None, max_length=300)
    error: str | None = Field(None, max_length=300)
    # The file's key (the play answer's), and whether the player found its address gone (a direct
    # file's 404/410): then it's written down as seen gone, not as an add-on's failure.
    key: str | None = Field(None, pattern=r"^[0-9a-f]{24}$")
    dead: bool = False


class Played(Model):
    id: str = Field(pattern=VIDEO_ID)
    key: str = Field(pattern=r"^[0-9a-f]{24}$")


@app.post("/launcher/source-played", dependencies=[Profile])
def source_played(body: Played = parsed(Played)):
    """A file the play answer marked seen gone (or dead) has played after all: no longer held back.
    Sent only for such files."""
    store.forget_sightings(str(accounts.account_id()), body.id, body.key)
    return answer(OK)


@app.post("/launcher/source-failed", dependencies=[Profile])
def source_failed(body: WontPlay = parsed(WontPlay)):
    """A stream the player couldn't play, so add-ons with many dead ones show up."""
    if body.dead and body.key:
        store.record_sighting(str(accounts.account_id()), body.id, body.addon, body.key)
        return answer(OK)
    store.record_failure(accounts.account_id(), me(), body.id, body.addon, "wont_play",
                         " · ".join(x for x in (body.filename, body.error) if x))
    return answer(OK)


# ---------- Watch state ----------

class Watched(Model):
    type: Literal["movie", "series"]
    id: str = Field(pattern=VIDEO_ID)
    watched: bool = True
    season: int | None = Field(None, ge=0)


@app.post("/launcher/watched", dependencies=[Profile])
def mark_watched(body: Watched = parsed(Watched)):
    """An episode, a season, a whole show (the show's id) or a film, watched or not."""
    watching.mark_watched(body.type, body.id, body.watched, body.season)
    return answer(OK)


class Notify(Model):
    id: str = Field(pattern=TITLE_ID)
    on: bool = True


@app.post("/launcher/notify", dependencies=[Profile])
def notify(body: Notify = parsed(Notify)):
    """"+N new episodes" for this show, or not."""
    if not watching.set_notify(body.id, body.on):
        return error("not in the library", 404)
    return answer(OK)


class Hide(Model):
    id: str = Field(pattern=TITLE_ID)
    kind: Literal["continue", "notInterested"]
    hidden: bool = True
    row: str | None = None


@app.post("/launcher/hide", dependencies=[Profile])
def hide(body: Hide = parsed(Hide)):
    # "continue" ("Remove from Continue watching") means "Mark as unwatched".
    if body.kind == "continue":
        watching.mark_unwatched_title(body.id)
    else:
        store.set_not_interested(me(), body.id, body.hidden, row_key=body.row)
        changed(body.id)
    return answer(OK)


class MyListPick(Model):
    id: str = Field(pattern=TITLE_ID)
    type: Literal["movie", "series"]
    on: bool = True


@app.post("/launcher/mylist", dependencies=[Profile])
def my_list_pick(body: MyListPick = parsed(MyListPick)):
    """{id, type, on}: puts a title on this profile's My List, or takes it off."""
    store.set_my_list(me(), body.id, body.type, body.on)
    changed(body.id)
    return answer(OK)


@app.get("/launcher/mylist.json", dependencies=[Profile])
def my_list():
    """This profile's My List: the titles' ids, newest first."""
    return answer({"ids": [r["imdb_id"] for r in store.my_list(me())]})


class Rating(Model):
    id: str = Field(pattern=TITLE_ID)
    value: Literal[-1, 1, 2] | None


@app.post("/launcher/rating", dependencies=[Profile])
def rate(body: Rating = parsed(Rating)):
    store.rate(me(), body.id, body.value)
    changed(body.id)
    return answer(OK)


class Asked(Model):
    id: str = Field(pattern=TITLE_ID)
    kind: Literal["rating", "early_exit"]


@app.post("/launcher/prompt", dependencies=[Profile])
def asked(body: Asked = parsed(Asked)):
    """A one-time question was shown (each is asked once)."""
    store.prompt_shown(me(), body.id, body.kind)
    return answer(OK)


class Interaction(Source):
    id: str = Field(pattern=TITLE_ID)
    kind: Literal["opened", "searched_opened"]


@app.post("/launcher/interaction", dependencies=[Profile])
def interaction(body: Interaction = parsed(Interaction)):
    src = body.source()
    store.interaction(me(), body.id, body.kind, src.get("origin"), src.get("row_key"), src.get("slot"),
                      src.get("request_id"), src.get("model_version"))
    if src.get("row_key") and src.get("origin") == "row":
        store.note_row_opened(me(), src["row_key"])
    return answer(OK)


class Opened(Model):
    row: str = ""
    id: str | None = None


@app.post("/launcher/opened", dependencies=[Profile])
def opened(body: Opened = parsed(Opened)):
    """Which Home row a title was opened from."""
    home.note_row_opened(body.row, body.id)
    return answer(OK)


# ---------- Profiles and the account ----------

@app.get("/launcher/profiles.json")
def who_is_watching(request: Request):
    """The household's profiles, and which one the TV has picked (if it has, and it's still there)."""
    account = _household(request)
    named = request.headers.get("X-Profile")
    p = store.profile(named) if named else None
    return answer(profiles.profile_list(account, p["id"] if p and p["account_id"] == account else None))


@app.get("/launcher/profile.json", dependencies=[Profile])
def my_profile():
    return answer(profiles.profile_page())


@app.post("/launcher/profile", dependencies=[Profile])
def change_profile(request: Request, body: dict = Body):
    """{id?, name?, avatar?, settings?}: change your own, or anyone's as the admin (unlocked)."""
    if body.get("id") and str(body["id"]) != me():
        _admin_device(request)
    return answer(profiles.change_profile(body))


@app.post("/launcher/profiles", dependencies=[Profile, Admin])
def add_profile(body: dict = Body):
    """{name, avatar}: add one (admin only)."""
    return answer(profiles.add_profile(body))


class Remove(Model):
    id: str


@app.post("/launcher/profiles/delete", dependencies=[Profile, Admin])
def remove_profile(body: Remove = parsed(Remove)):
    """{id}: remove one (admin only; never the admin profile)."""
    profiles.remove_profile(body.id)
    return answer(OK)


@app.post("/launcher/account", dependencies=[Profile, Admin])
def change_account(body: dict = Body):
    """The account's time zone, country, location and monthly AI limit (admin only)."""
    return answer({"settings": profiles.change_account(body)})


@app.get("/stats.json", dependencies=[Profile, Admin])
def stats():
    return answer(usage_summary(), max_age=60)


# ---------- Links played on the TV (the web app's history of them) ----------

@app.get("/launcher/sent.json", dependencies=[Profile])
def sent_list():
    """The profile's links, most recently sent first: what, when sent and last played, how far."""
    return answer({"items": send.sent_items()})


class NewLink(Model):
    url: str = Field(max_length=2000)
    name: str | None = Field(None, max_length=80)


@app.post("/launcher/sent", dependencies=[Profile])
def add_link(body: NewLink = parsed(NewLink)):
    """A link the TV is about to play (sent with Play on TV): kept in this profile's history (one
    already there keeps where it got to). Answers it as sent.json lists it."""
    if not re.match(r"^https?://", body.url):
        return error("That isn't a link", 400)
    item = send.send_link(body.url, body.name or "")
    return answer(next((i for i in send.sent_items() if i["id"] == item["id"]), item))


@app.get("/launcher/sent/{item}.jpg", dependencies=[Profile])
def sent_thumb(item: str):
    """The frame grabbed from one of this profile's sent streams."""
    jpeg = send.thumb(item) if item.isdigit() else None
    if not jpeg:
        return error("no thumbnail", 404)
    return Response(bytes(jpeg), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@app.post("/launcher/sent/{item}/thumb", dependencies=[Profile])
async def save_sent_thumb(item: str, request: Request):
    if not item.isdigit():
        return error("not found", 404)
    body = await read_body(request, MAX_BODY_BYTES)
    if body[:2] != b"\xff\xd8":
        return error("expected a JPEG", 400)
    await run_in_threadpool(send.save_thumb, item, body)
    return answer(OK)


class SentPosition(Model):
    position: int = Field(0, ge=0)
    duration: int = Field(0, ge=0)


@app.post("/launcher/sent/{item}/progress", dependencies=[Profile])
def sent_progress(item: str, body: SentPosition = parsed(SentPosition)):
    if not item.isdigit():
        return error("not found", 404)
    send.sent_progress(item, body.position, body.duration)
    return answer(OK)


@app.post("/launcher/sent/{item}/delete", dependencies=[Profile])
def sent_delete(item: str):
    send.sent_remove(item)
    return answer(OK)


# ---------- A new TV joining a household ----------

@app.get("/join/households.json")
def households():
    """What a device joining this server needs: the households to pick from, or that a code is
    needed; and where it runs ("home" or "cloud", set when it was deployed)."""
    found = devices.households()
    return answer({"server": SERVER_NAME, "mode": MODE, "codeRequired": not OPEN_JOIN, "households": found})


class Joining(Model):
    household: str | None = None
    code: str | None = Field(None, max_length=20)
    device: str | None = Field(None, max_length=100)   # (cut to names.device)
    kind: Literal["tv", "browser"] = "tv"
    install: str | None = Field(None, min_length=8, max_length=100)


@app.post("/join")
def join(request: Request, body: Joining = parsed(Joining)):
    """A device joins a household (by its code, or by picking it where the server allows that) and
    gets its key, to send with every request from now on."""
    try:
        household, key = devices.join(body.household, body.code, body.device, body.kind, body.install, tries.address(request))
    except accounts.TooManyTries:
        return error("Too many wrong codes. Try again in a few minutes.", 429)
    log.info("A %s (%s) joined %s", body.kind, body.device or "unnamed", household["name"])
    return answer({"household": household, "key": key})


# ---------- The household: its devices, sources and keys ----------
# These are about the household, not one profile's viewing: listing its devices needs only a
# device's key; everything else, the admin profile as well (X-Profile).

class Pin(Model):
    pin: str = Field(max_length=20)


@app.get("/household/admin.json", dependencies=[Profile])
def admin_status(request: Request, device=Device):
    """{"pinSet", "unlocked"}: whether the admin profile has a PIN, and whether this device is
    unlocked now (the admin profile only)."""
    return answer(adminpin.status(device["id"], me(), request.headers.get("X-Admin-Session")))


@app.post("/household/admin/unlock", dependencies=[Profile])
def admin_unlock(body: Pin = parsed(Pin), device=Device):
    """{pin}: an admin session for this device ({"session", "expiresIn"}). Wrong: 403 with how many
    tries are left; too many: 429 with how long it's locked."""
    try:
        return answer(adminpin.unlock(device["id"], me(), body.pin))
    except adminpin.PinNeeded:
        return error("set the admin PIN first", 403, headers={"X-Admin-Pin-Unset": "1"})
    except adminpin.WrongPin as e:
        return answer({"error": str(e), "triesLeft": e.tries_left}, 403)
    except adminpin.Locked as e:
        return answer({"error": "Too many wrong PINs. Try again later.", "lockedFor": e.seconds}, 429,
                      headers={"Retry-After": str(e.seconds)})


@app.post("/household/admin/pin", dependencies=[Profile])
def admin_set_pin(request: Request, body: Pin = parsed(Pin), device=Device):
    """{pin}: sets the admin profile's PIN (the first one freely, a new one only while unlocked).
    Every other admin session ends; answers a new one for this device."""
    return answer(adminpin.set_pin(device["id"], me(), body.pin, request.headers.get("X-Admin-Session")))


@app.post("/household/admin/lock", dependencies=[Profile])
def admin_lock(request: Request):
    """Ends this device's admin session."""
    adminpin.lock(request.headers.get("X-Admin-Session"))
    return answer(OK)


def _unlocked_admin(request, device):
    """Whether the request is the household's admin profile with its PIN unlocked (as for_admin asks),
    without refusing it otherwise."""
    named = request.headers.get("X-Profile")
    p = store.profile(named) if named else None
    if not p or p["account_id"] != device["account_id"] or not p["is_admin"]:
        return False
    # (Checked, not renewed: the Devices panel asks every 20 seconds, which mustn't keep admin unlocked.)
    return adminpin.unlocked(device["id"], named, request.headers.get("X-Admin-Session"))


@app.get("/household/devices.json")
def household_devices(request: Request, device=Device):
    """The household's devices; for the admin (PIN unlocked), what each is watching now or watched last."""
    activity = _unlocked_admin(request, device)
    found, ok = devices.listing(device["account_id"], device["id"], activity)
    return answer({"devices": found, **({} if ok else {"activityUnavailable": True})})


class DeviceName(Model):
    name: str = Field(max_length=S.names.device)


@app.post("/household/devices/{device_id}/rename")
def rename_device(device_id: str, body: DeviceName = parsed(DeviceName), device=Admin):
    """{name}: a name of the admin's choosing for a TV or browser ("Office Mac")."""
    devices.rename(device["account_id"], device_id, body.name)
    return answer(OK)


# Invites made by the household's admin: one device each, as the owner's (see accounts.py).

class NewInvite(Model):
    label: str | None = Field(None, max_length=S.names.invite_label)


def _made(job):
    try:
        return answer(job())
    except accounts.TooManyInvites as e:
        return error(f"There are {e.args[0]} invites open already: cancel one, or wait for one to be used", 409)


@app.get("/household/invites.json")
def household_invites(device=Admin):
    """The household's invites, newest first (never their codes)."""
    return answer({"invites": accounts.invites(device["account_id"])})


@app.post("/household/invites")
def household_invite(body: NewInvite = parsed(NewInvite), device=Admin):
    """{label?}: a new invite for one device, named for whoever it's for; its code is shown this once."""
    return _made(lambda: owner.invite_json(accounts.new_invite(device["account_id"], body.label, "admin")))


@app.post("/household/invites/{invite_id}/cancel")
def household_cancel_invite(invite_id: str, device=Admin):
    """Cancels an open invite: its code stops working."""
    accounts.cancel_invite(device["account_id"], invite_id)
    return answer(OK)


@app.post("/household/invites/{invite_id}/remove")
def household_remove_invite(invite_id: str, device=Admin):
    """Takes a used or expired invite off the list (finished ones also go by themselves after 7 days)."""
    accounts.remove_invite(device["account_id"], invite_id)
    return answer(OK)


@app.post("/household/invites/clear")
def household_clear_invites(device=Admin):
    """Takes every used and expired invite off the list: {"removed"}."""
    return answer(accounts.clear_finished_invites(device["account_id"]))


@app.post("/household/devices/{device_id}/code")
def device_code(device_id: str, device=Admin):
    """A one-time code for a TV or browser to join again as itself, when it has lost its key (a
    browser's storage cleared, an app's data wiped): joined with it, it keeps its name and history,
    gets a new key, and its old key stops working. Shown this once; works for 24 hours, on the same
    kind of device; one it had open before stops working."""
    def made():
        found = accounts.new_device_code(device["account_id"], device_id)
        if not found:
            raise NotFound("No such device")
        return {**owner.invite_json(found), "for": {"id": device_id, "name": found[1]["label"]}}
    return _made(made)


@app.post("/household/devices/{device_id}/remove")
def remove_device(device_id: str, device=Admin):
    """Removes a TV or browser: its key stops working at once."""
    devices.remove(device["account_id"], device_id)
    return answer(OK)


@app.post("/launcher/leave")
def leave(device=Device):
    """This device leaves its household (a browser's "Sign out"): its key stops working at once."""
    devices.remove(device["account_id"], str(device["id"]))
    return answer(OK)


@app.get("/household/sources.json")
def household_sources(device=Admin):
    return answer(sources.overview(device["account_id"]))


class Address(Model):
    url: str | None = Field(None, max_length=2000)


@app.post("/household/sources/aiostreams")
def set_aiostreams(body: Address = parsed(Address), device=Admin):
    """The AIOStreams address ({"url": null} removes it)."""
    sources.set_aiostreams(device["account_id"], body.url)
    return answer(sources.overview(device["account_id"]))


@app.post("/household/sources/addons/{kind}")
def add_addon(kind: Literal["stream", "subtitle"], body: Address = parsed(Address), device=Admin):
    """Adds an extra stream add-on or a subtitle add-on."""
    sources.add_addon(device["account_id"], kind, body.url)
    return answer(sources.overview(device["account_id"]))


@app.post("/household/sources/addons/{kind}/{addon_id}/remove")
def remove_addon(kind: Literal["stream", "subtitle"], addon_id: str, device=Admin):
    sources.remove_addon(device["account_id"], kind, addon_id)
    return answer(sources.overview(device["account_id"]))


class DebridKey(Model):
    key: str | None = Field(None, max_length=300)


@app.post("/household/sources/debrid/{service}")
def set_debrid_key(service: str, body: DebridKey = parsed(DebridKey), device=Admin):
    """A debrid service's key ({"key": null} removes it): the household's setup in Nightcap's own
    AIOStreams is made or updated with it (see sources.set_debrid)."""
    sources.set_debrid(device["account_id"], service, body.key)
    return answer(sources.overview(device["account_id"]))


class AIKey(Model):
    provider: str
    key: str | None = Field(None, max_length=300)
    model: str | None = Field(None, max_length=200)
    baseUrl: str | None = Field(None, max_length=500)
    # US dollars per million tokens, [input, output]; [0, 0] for a free model.
    price: list[float] | None = Field(None, min_length=2, max_length=2)


@app.post("/household/sources/ai")
def set_ai_key(body: AIKey = parsed(AIKey), device=Admin):
    """The household's AI: provider, key, model, the address ("other" only) and its price when Nightcap
    doesn't know it. {"key": null} with a model keeps the saved key; without one, removes the AI."""
    sources.set_ai(device["account_id"], body.provider, body.key, body.model, body.baseUrl, body.price)
    return answer(sources.overview(device["account_id"]))


class AIModels(Model):
    provider: str
    key: str | None = Field(None, max_length=300)
    baseUrl: str | None = Field(None, max_length=500)


@app.post("/household/sources/ai/models")
def ai_models(body: AIModels = parsed(AIModels), device=Admin):
    """The chat models a key can use, known ones first (the key given, else the saved one). A POST: the
    key mustn't be in an address, where it would be logged."""
    return answer({"models": sources.ai_models(device["account_id"], body.provider, body.key, body.baseUrl)})


class SourceTest(Model):
    what: Literal["aiostreams", "stream", "subtitle", "ai"]
    id: str | None = None
    url: str | None = Field(None, max_length=2000)
    provider: str | None = None
    key: str | None = Field(None, max_length=300)
    model: str | None = Field(None, max_length=200)
    baseUrl: str | None = Field(None, max_length=500)


@app.post("/household/sources/test")
def test_source(request: Request, body: SourceTest = parsed(SourceTest), device=Admin):
    """Tests one source: a saved one (what, and id for an add-on), or one not saved yet (url, or provider,
    key, model and baseUrl; with a model but no key, that model with the saved key). An AI is tested with
    one small real answer (charged to the admin profile)."""
    admin = request.headers.get("X-Profile")
    if body.what == "ai" and body.key:
        return answer(sources.test_key(sources.ai_settings(body.provider, body.key, body.model, body.baseUrl), admin))
    if body.what == "ai" and body.model:
        return answer(sources.test_key(sources.with_saved_key(device["account_id"], body.provider, body.model, body.baseUrl), admin))
    if body.what != "ai" and body.url:
        return answer(sources.test_addon(sources.check_url(body.url), sources.TEST_SLEEPING_S))
    return answer(sources.test_saved(device["account_id"], body.what, body.id, admin))


# ---------- Live TV (see livetv.py) ----------

CHANNEL_ID = r"^[0-9a-f]{12}$"


@app.get("/livetv/page.json", dependencies=[Profile])
def livetv_page(device=Device):
    """The Live TV page: the channel watched last, My channels, then a row per kind of channel."""
    return answer(livetv.page(device["account_id"], device["id"]))


@app.get("/livetv/browse.json", dependencies=[Profile])
def livetv_browse(kind: str | None = Query(None, max_length=40), countries: str | None = Query(None, max_length=400),
                  languages: str | None = Query(None, max_length=400), q: str | None = Query(None, max_length=120),
                  offset: int = Query(0, ge=0), limit: int = Query(60, ge=1, le=200),
                  row: str | None = Query(None, max_length=20), device=Device):
    """Browse all, with filters (countries, languages: comma-separated ids, "any" for any; not given:
    the household's places), or one of the household's own rows (row: its key, from the page)."""
    return answer(livetv.browse(device["account_id"], device["id"], kind, countries, languages, q, offset, limit, row))


@app.get("/livetv/hidden.json", dependencies=[Profile])
def livetv_hidden(device=Device):
    """The channels hidden because they failed to play, to try again (one that plays is back at once)."""
    return answer(livetv.hidden_channels(device["account_id"], device["id"]))


class ChannelPick(Model):
    channel: str = Field(pattern=CHANNEL_ID)
    on: bool = True


@app.post("/livetv/favourite", dependencies=[Profile])
def livetv_favourite(body: ChannelPick = parsed(ChannelPick), device=Device):
    """{channel, on}: adds a channel to (or takes it from) the profile's My channels."""
    livetv.favourite(device["account_id"], body.channel, body.on)
    return answer(OK)


@app.get("/livetv/play/{channel}.json", dependencies=[Profile])
def livetv_play(request: Request, channel: str, device=Device):
    """A channel's streams, best first, as this device's playback links (like a title's, see play)."""
    if not re.match(CHANNEL_ID, channel):
        return error("bad id", 400)
    base = PUBLIC_URL or str(request.base_url).rstrip("/")
    return JSONResponse(livetv.play(device["account_id"], channel, device["id"], base),
                        headers={"Cache-Control": "no-store"})


class ChannelFailed(Model):
    channel: str = Field(pattern=CHANNEL_ID)


@app.post("/livetv/failed", dependencies=[Profile])
def livetv_failed(body: ChannelFailed = parsed(ChannelFailed), device=Device):
    """None of the channel's streams played on this device (a few times in a row hides it there for a while)."""
    livetv.failed(device["account_id"], device["id"], body.channel)
    return answer(OK)


class ChannelWatched(Model):
    channel: str = Field(pattern=CHANNEL_ID)
    seconds: int = Field(ge=0, le=600)


@app.post("/livetv/watching", dependencies=[Profile])
def livetv_watching(body: ChannelWatched = parsed(ChannelWatched), device=Device):
    """{channel, seconds}: the player played the channel [seconds] more since it last said."""
    livetv.watching(device["account_id"], device["id"], body.channel, body.seconds)
    return answer(OK)


@app.get("/household/livetv.json")
def household_livetv(device=Admin):
    """Live TV's settings: the lists (masked), the places, and what can be picked for them."""
    return answer(livetv.overview(device["account_id"], device["id"]))


class ChannelList(Model):
    url: str = Field(max_length=2000)
    name: str | None = Field(None, max_length=100)


@app.post("/household/livetv/lists")
def add_channel_list(body: ChannelList = parsed(ChannelList), device=Admin):
    """Adds a channel list (read at once: refused if it isn't one)."""
    livetv.add_list(device["account_id"], body.url, body.name)
    return answer(livetv.overview(device["account_id"], device["id"]))


@app.post("/household/livetv/lists/{list_id}/remove")
def remove_channel_list(list_id: str, device=Admin):
    livetv.remove_list(device["account_id"], list_id)
    return answer(livetv.overview(device["account_id"], device["id"]))


@app.post("/household/livetv/lists/{list_id}/read")
def read_channel_list(list_id: str, device=Admin):
    """Reads a list again now."""
    livetv.read_again(device["account_id"], list_id)
    return answer(livetv.overview(device["account_id"], device["id"]))


class ChannelListSettings(Model):
    refreshMinutes: int | None = None
    fields: dict[str, str] = Field(default_factory=dict, max_length=20)


@app.post("/household/livetv/lists/{list_id}/settings")
def channel_list_settings(list_id: str, body: ChannelListSettings = parsed(ChannelListSettings), device=Admin):
    """A list's Advanced settings: how often it's read again, and which attribute plays each role."""
    livetv.set_list_settings(device["account_id"], list_id, body.refreshMinutes, body.fields)
    return answer(livetv.overview(device["account_id"], device["id"]))


class Places(Model):
    countries: list[str] = Field(max_length=40)
    languages: list[str] = Field(max_length=40)


@app.post("/household/livetv/places")
def set_livetv_places(body: Places = parsed(Places), device=Admin):
    """{countries, languages}: where the Live TV page's channels come from (an empty list: any)."""
    livetv.set_places(device["account_id"], body.countries, body.languages)
    return answer(livetv.overview(device["account_id"], device["id"]))


# ---------- The server's owner ----------
# Whoever deployed the server, with the owner key in X-Owner-Key (see owner.py). Not about any
# household's devices or profiles: no device key needed.

def for_owner(request: Request):
    try:
        owner.check(request.headers.get("X-Owner-Key"), tries.address(request))
    except owner.TooManyTries:
        raise Problem("Too many wrong keys. Try again in a few minutes.", 429)


Owner = Depends(for_owner)


@app.get("/server/households.json", dependencies=[Owner])
def owner_households():
    """Every household: its admin, how many profiles and devices, and its invite."""
    return answer({"server": SERVER_NAME, "mode": MODE, "households": owner.households()})


@app.get("/server/version.json", dependencies=[Owner])
def owner_version():
    """This server's version and the newest out ({"version", "latest", "update"}): the owner's page
    says when there's a newer image to pull. With "aiostreams" ({"version", "tested", "ok"}, or None
    without one): whether Nightcap's AIOStreams is the version its household template was tested on."""
    return answer({**appupdate.server_status(VERSION), "aiostreams": aiostreams.status()})


class NewHousehold(Model):
    name: str = Field(max_length=S.names.household)
    admin: str = Field(max_length=S.names.profile)
    avatar: str | None = Field(None, max_length=40)
    # Who its first invite is for (it names the device that joins with it).
    invite: str | None = Field(None, max_length=S.names.invite_label)


@app.post("/server/households", dependencies=[Owner])
def owner_create(body: NewHousehold = parsed(NewHousehold)):
    """A new household with its admin profile ({"name", "admin": the admin profile's name, "avatar"?,
    "invite"?: who its first invite is for})."""
    return answer(owner.create(body.name, body.admin, body.avatar, body.invite))


class Rename(Model):
    name: str = Field(max_length=S.names.household)


@app.post("/server/households/{account_id}/rename", dependencies=[Owner])
def owner_rename(account_id: str, body: Rename = parsed(Rename)):
    owner.rename(account_id, body.name)
    return answer(OK)


class Confirm(Model):
    confirm: str = Field(max_length=S.names.household)


@app.post("/server/households/{account_id}/delete", dependencies=[Owner])
def owner_delete(account_id: str, body: Confirm = parsed(Confirm)):
    """Deletes a household and everything in it; {"confirm": its name}. Its devices stop working."""
    owner.delete(account_id, body.confirm)
    return answer(OK)


class NewAdmin(Model):
    profile: str = Field(max_length=40)


@app.post("/server/households/{account_id}/admin-pin/reset", dependencies=[Owner])
def owner_reset_pin(account_id: str):
    """Clears the household admin profile's forgotten PIN; it sets a new one at its next admin action."""
    owner.reset_admin_pin(account_id)
    return answer(OK)


@app.post("/server/households/{account_id}/admin", dependencies=[Owner])
def owner_set_admin(account_id: str, body: NewAdmin = parsed(NewAdmin)):
    """Makes one of the household's profiles its admin (the one before stops being it)."""
    owner.set_admin(account_id, body.profile)
    return answer(OK)


@app.post("/server/households/{account_id}/invite", dependencies=[Owner])
def owner_invite(account_id: str, body: NewInvite = parsed(NewInvite)):
    """{label?}: a new invite for one device of the household (its code, shown this once, and link),
    named for whoever it's for. Its other open invites keep working."""
    return _made(lambda: owner.new_invite(account_id, body.label))


@app.get("/server/households/{account_id}/invites.json", dependencies=[Owner])
def owner_invites(account_id: str):
    """The household's invites, newest first (never their codes)."""
    return answer({"invites": owner.invites(account_id)})


@app.post("/server/households/{account_id}/invites/{invite_id}/cancel", dependencies=[Owner])
def owner_cancel_invite(account_id: str, invite_id: str):
    """Cancels an open invite: its code stops working."""
    accounts.cancel_invite(account_id, invite_id)
    return answer(OK)


@app.get("/server/households/{account_id}/profiles.json", dependencies=[Owner])
def owner_profiles(account_id: str):
    """The household's profiles, to pick its admin from."""
    if not store.account(account_id):
        return error("No such household", 404)
    return answer({"profiles": [profiles.profile_json(p) for p in store.profiles(account_id)]})


class Export(Model):
    password: str = Field(max_length=200)
    households: list[str] | None = None


@app.post("/server/export", dependencies=[Owner])
def owner_export(body: Export = parsed(Export)):
    """Every household ({"households": null}) or the ones listed, as one file locked with
    {"password"}, for moving to another server (see moving.py)."""
    data, name = moving.export(body.households, body.password)
    # (Already compressed inside its encryption: not gzipped again.)
    return Response(data, media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store",
                             "Content-Encoding": "identity"})


class Import(Model):
    password: str = Field(max_length=200)
    # The ids of households already here to replace (true: every one), and whether to only look.
    replace: bool | list[str] = []
    check: bool = False
    file: str = Field(max_length=MAX_IMPORT_BYTES)


@app.post("/server/import", dependencies=[Owner])
def owner_import(body: Import = parsed(Import, most=MAX_IMPORT_BYTES)):
    """Brings in the households in an exported file ({"file": base64, "password"}): new ones are
    created; ones already here are replaced if listed in "replace" (their ids; true for all), else
    skipped. With "check": true nothing changes, and the answer lists them, new or already here."""
    try:
        data = base64.b64decode(body.file, validate=True)
    except binascii.Error:
        return error("The file should be sent as base64", 400)
    try:
        found = moving.import_file(data, body.password, body.replace, body.check)
        return answer({"households": found} if body.check else {"imported": found})
    except moving.WrongPassword:
        return error("Wrong password, or that isn't an exported file", 403)


# ---------- Play on TV ----------

class Playing(Model):
    title: dict | None = None
    link: dict | None = None


@app.post("/household/devices/{device_id}/play", dependencies=[Profile])
def play_on_tv(device_id: str, body: Playing = parsed(Playing), device=Device):
    """Sends a title ({"title": {"type", "id"}}) or a link ({"link": {"url", "name"?}}) to one of
    the household's TVs, as the profile in X-Profile. 409 at once if the TV is off or asleep;
    otherwise check GET /household/play/{request}.json for its answer."""
    try:
        request_id = playon.send(device["account_id"], me(), device_id, body.title, body.link)
    except playon.Off:
        return error("The TV is off or asleep", 409, headers={"X-TV-Off": "1"})
    return answer({"request": request_id, "status": "waiting"})


@app.get("/household/play/{request_id}.json")
def play_status(request_id: int, device=Device):
    """waiting (not picked up yet), shown (on the TV, not answered), accepted, declined, or
    unreachable (not picked up within 25 seconds: off, asleep or not reachable)."""
    return answer({"status": playon.status(device["account_id"], request_id)})


@app.get("/launcher/app.json")
def app_update(abi: str = Query("armeabi-v7a", pattern="^(armeabi-v7a|arm64-v8a)$"), device=Device):
    """The newest Android TV app for this TV's processor kind ({"versionCode", "versionName", "size"}),
    or {} if there's none to offer. The TV compares it with its own."""
    return answer(appupdate.offer(abi) or {})


@app.get("/launcher/app.apk")
def app_download(abi: str = Query("armeabi-v7a", pattern="^(armeabi-v7a|arm64-v8a)$"), device=Device):
    """That app's APK, passed along from GitHub as it comes."""
    found = appupdate.download(abi)
    if not found:
        return error("The app update can't be downloaded right now", 503)
    chunks, size = found
    # (Already compressed: never gzipped again on the way.)
    return StreamingResponse(chunks, media_type="application/vnd.android.package-archive",
                             headers={"Content-Length": str(size), "Content-Encoding": "identity", "Cache-Control": "no-store"})


@app.get("/launcher/inbox.json")
def inbox(device=Device):
    """The TV's check (every 10 seconds while its screen is on): a request waiting for it, or none."""
    found = playon.next_for(device)
    return answer({"request": found} if found else {})


class Answer(Model):
    accept: bool


@app.post("/launcher/inbox/{request_id}/answer")
def answer_request(request_id: int, body: Answer = parsed(Answer), device=Device):
    playon.answer(device, request_id, body.accept)
    return answer(OK)


# ---------- The web app ----------
# nightcap-web, built into WEB_DIR. Its own pages (/app/join/…, /app/settings…) are worked out in
# the browser, so any /app/ path that isn't a file answers its index.html. The Samsung/LG TV app is
# built into its tv/ folder and answers the same way under /app/tv/, with its own index.html.

def _web_file(path):
    """The built file for [path] under WEB_DIR (never outside it), or None."""
    base = os.path.realpath(WEB_DIR)
    found = os.path.realpath(os.path.join(base, path))
    return found if (found == base or found.startswith(base + os.sep)) and os.path.isfile(found) else None


@app.get("/app", include_in_schema=False)
def web_root():
    return RedirectResponse("/app/", 308)


def _send_web(request, found, cache):
    """A built file, as its compressed copy (made with the image, see the Dockerfile) when the browser
    takes that kind: Brotli, else gzip, else the file itself."""
    takes = {t.split(";")[0].strip() for t in request.headers.get("accept-encoding", "").split(",")}
    headers = {"Cache-Control": cache, "Vary": "Accept-Encoding", "Content-Security-Policy": APP_CSP}
    for encoding, ending in (("br", ".br"), ("gzip", ".gz")):
        if encoding in takes and os.path.isfile(found + ending):
            return FileResponse(found + ending, media_type=mimetypes.guess_type(found)[0] or "application/octet-stream",
                                headers={**headers, "Content-Encoding": encoding})
    return FileResponse(found, headers={**headers, "Content-Encoding": "identity"})


# Where the built files are: a missing one there is missing (404), never the app's page, which a
# browser would take for a script (an open tab of an older build asking for a file a deploy took away).
_WEB_FILES = ("assets/", "tv/assets/", "fonts/", "brand/", "avatars/")


@app.get("/app/{path:path}", include_in_schema=False)
def web_app(request: Request, path: str):
    tv = path == "tv" or path.startswith("tv/")
    found = _web_file(path) if path else None
    if found:
        # Built files have their content's hash in the name: kept a year. index.html never is.
        cache = "public, max-age=31536000, immutable" if path.startswith(("assets/", "tv/assets/")) else "no-cache"
        return _send_web(request, found, cache)
    if path.startswith(_WEB_FILES):
        return error("not found", 404)
    index = _web_file("tv/index.html" if tv else "index.html")
    if not index:
        return error("The web app isn't built into this server", 404)
    return _send_web(request, index, "no-cache")




# ---------- The server itself ----------

@app.get("/limits.json")
def server_limits():
    """What this server allows (profiles, devices, add-ons, name lengths, PIN length, the audio
    languages…), so the apps allow the same. Asked before joining too, so it needs no device."""
    return answer(limits(), max_age=300)


@app.get("/ready")
def ready():
    """Up and answering (nothing is built ahead of time: Home answers from what's saved)."""
    return answer({"ready": True})


@app.get("/status", dependencies=[Profile])
def status():
    cache = recommend.recs()
    return answer({
        "ready": bool(cache),
        "built_at": cache and time.ctime(cache["built_at"]),
        "taste_summary": cache and cache["taste_summary"],
        "seeds": cache and cache.get("seeds"),
        "rows": cache and {k: len(v) for k, v in cache["catalogs"].items()},
    }, max_age=120)

