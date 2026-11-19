"""The player's sources: streams and subtitles from the account's add-ons, ranked."""

import logging
import re
import threading
from contextlib import contextmanager
from contextvars import ContextVar
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from functools import lru_cache
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError

from guessit import guessit

from . import accounts, aiostreams, linkstate, own_aiostreams, playlinks, sources, store
from . import cache
from .cache import cached
from .config import LOOKUP_BUDGET_S as LOOKUP_BUDGET, S
from .context import for_me, me
from .episodes import early, is_out, next_card, out_at, ready_key, sources_known
from .http import Blocked, cinemeta, get_json, is_plugin
from .languages import AUDIO_LANGUAGES
from .titles import film_releases, original_language
from .watching import library_state

log = logging.getLogger(__name__)


# Once an episode is out by the clock (or, known only by its air date, from midday UTC of that day:
# episodes.early), one look at the add-ons says whether it can really be played: until then it
# doesn't count as new, and an early one found playable counts as out (a daily show's, hours before
# its air day ends in UTC).
# Building Home notes the episodes to look for (sources_due); the TV's refresh of Home looks
# (look_for_sources), at most every half hour per episode, for two days at most after it's out.

T = S.advanced.timeouts
SOURCES_FOR_DAYS = S.advanced.cache.new_episode_check_days
# A title's sources (and a play's unused extras, for "Look for more sources") are kept this long.
PLAY_TTL = S.advanced.cache.sources_minutes * 60
_checking = set()
_checking_lock = threading.Lock()


def play_key(vid):
    """The cache key for one title's sources: they come from (and carry) the account's own add-ons."""
    return f"play:{accounts.account_id()}:{vid}"




_due = ContextVar("sources_due", default=None)


@contextmanager
def sources_due():
    """While Home is built: collects the episodes whose sources should be looked for (yields the set)."""
    due = set()
    token = _due.set(due)
    try:
        yield due
    finally:
        _due.reset(token)


def look_for_sources(vid):
    """Are there sources for this new episode? Looks now (the list is kept for the player) and returns
    True if there are. Kept as "verified" when one is known to be it, "some" otherwise: an episode out
    by the clock counts as new with any (a daily show's files are often named by date, not episode),
    one found early on its air day only with a verified one (an add-on's unnamed links, "HD Server",
    turn up for any episode, even one that isn't out). One look at a time per episode: another one
    asking gets None."""
    with _checking_lock:
        if vid in _checking:
            return None
        _checking.add(vid)
    try:
        started = time.time()
        streams, _, answered = cached(play_key(vid), lambda: play_sources("series", vid), ttl=PLAY_TTL)
        thin = len(streams) <= THIN_ANSWER and all(s.get("direct") for s in streams)
        if not streams or not answered or thin:
            cache.drop(play_key(vid))
        names = title_names("series", vid)
        ready = ("verified" if any(is_verified(s, vid, names) for s in streams) else "some") if streams else False
        cache.put(ready_key(vid), ready, started)
        log.info("Sources for new episode %s: %d (%s)", vid, len(streams), ready or "none")
        return bool(ready)
    except Exception:
        log.exception("Looking for sources for %s", vid)
        return None
    finally:
        with _checking_lock:
            _checking.discard(vid)


def waiting_for_sources(v):
    """Whether an episode that's out by the clock, or may be out early on its air day (episodes.early),
    has no sources yet; looked for if not looked yet. Not after two days from when it's out."""
    if not v or not (is_out(v) or early(v)):
        return False
    out = datetime.strptime(out_at(v), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) - out > timedelta(days=SOURCES_FOR_DAYS):
        return False
    # (Before it's out by the clock, only a verified source settles it: see episodes.sources_known.)
    known = sources_known(v["id"], early=out_at(v) > time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()))
    if known is None and _due.get() is not None:
        _due.get().add(v["id"])
    return not known



def account_addons():
    """The account's stream and subtitle add-ons: addresses from its secrets, manifests fetched.
    Extra stream add-ons (ones AIOStreams' server is blocked from) are asked for streams only. One whose
    manifest asks to be a last resort (a plugin: "lastResort") is only marked as that, and not fetched again.
    The list is kept an hour, or only a few minutes while an add-on is missing, so it comes back;
    never while Nightcap's own AIOStreams is missing from it (it's next to the server, and back in
    seconds after a cold start)."""
    account = accounts.account_id()
    key = f"addons:{account}"
    hit = cache.get(key)
    if hit and time.time() - hit[0] < (3600 if hit[1]["complete"] else 180):
        return hit[1]["addons"]
    s = store.secrets(account)
    # No AIOStreams at all, on a server with its own: the household's setup there is made first.
    if not s["aiostreams_url"] and sources.ensure(account):
        s = store.secrets(account)
    # Made from an older template (or without an add-on that was too slow): brought up to the current
    # one, off the play's way (the add-on list is loaded again once it is).
    else:
        sources.update_template(account, s)
    ours = sources.managed(s)
    wanted = [(u, False) for u in [s["aiostreams_url"], *s["subtitle_urls"]] if u] \
        + [(u, True) for u in s["stream_urls"] if not u.endswith(sources.LAST_RESORT)]

    def load(item):
        url, direct = item
        try:
            return {"transportUrl": url, "manifest": get_json(url, retries=0, timeout=T.addon_manifest_seconds) or {}, "direct": direct}
        except Exception as e:
            log.warning("Add-on manifest unavailable from %s: %s", url.split("/")[2], e)
            return None
    def load_ours(url):
        """The household's setup in Nightcap's AIOStreams, waited for while AIOStreams is starting (no
        answer), and made again at once if AIOStreams answers that it doesn't know it (it lost it, say,
        after its database was reset)."""
        deadline = time.time() + aiostreams.WAIT_S
        while True:
            try:
                return {"transportUrl": url, "manifest": get_json(url, retries=0, timeout=T.addon_manifest_seconds) or {}, "direct": False}
            except HTTPError as e:
                log.warning("Nightcap's AIOStreams doesn't know the setup (%s): making it again", e.code)
                if sources.repair(account):
                    fresh = store.secrets(account)["aiostreams_url"]
                    return load((fresh, False)) if fresh else None
                return None
            except Exception as e:
                if time.time() + 1 >= deadline:
                    log.warning("Nightcap's AIOStreams didn't answer within %ss: %s", aiostreams.WAIT_S, e)
                    return None
                time.sleep(1)
    jobs = [_addon_pool.submit(load_ours if ours and i == 0 else load, item[0] if ours and i == 0 else item)
            for i, item in enumerate(wanted)]
    found = [j.result() for j in jobs]
    addons = [a for a in found if a]
    for a in addons:
        if a["direct"] and (a["manifest"].get("nightcap") or {}).get("lastResort"):
            a["lastResort"] = True
            sources.remember_last_resort(account, a["transportUrl"])
    addons += [{"transportUrl": u.removesuffix(sources.LAST_RESORT), "manifest": {}, "direct": True, "lastResort": True}
               for u in s["stream_urls"] if u.endswith(sources.LAST_RESORT)]
    # Not kept while our AIOStreams is missing from it: it didn't answer, or the household's first
    # setup there couldn't be made yet (a cold start). The next play tries again.
    if not (ours and found and found[0] is None) and not (aiostreams.available() and not s["aiostreams_url"]):
        cache.put(key, {"addons": addons, "complete": len(addons) == len(found)})
    return addons


def ask_again(hit, vid, names):
    """Whether a kept list of a title's sources ([at, (streams, …)]) is asked for again although its
    PLAY_TTL hasn't passed: after EXTRAS_ONLY_TTL when it has only the extra add-ons' sources, or none
    known to be this title ([names]: title_names; see play_info)."""
    if not hit or time.time() - hit[0] <= EXTRAS_ONLY_TTL:
        return False
    streams = hit[1][0]
    return not any(not s.get("direct") for s in streams) or not any(is_verified(s, vid, names) for s in streams)


def addon_serves(manifest, resource, ctype, vid):
    for r in manifest.get("resources", []):
        spec = r if isinstance(r, dict) else {}
        if (spec.get("name") or r) != resource:
            continue
        types = spec.get("types") or manifest.get("types") or []
        prefixes = spec.get("idPrefixes") or manifest.get("idPrefixes")
        return ctype in types and (not prefixes or any(vid.startswith(x) for x in prefixes))
    return False


EXTRAS_ONLY_TTL = S.advanced.cache.extras_only_minutes * 60
# An extra add-on answering with this many playable sources (but some) is asked once more.
THIN_ANSWER = 1
THIN_RETRY_AFTER_S = T.thin_retry_seconds
# A plugin's search, with its service waking up (about 33 s and 9 s), has to fit in a play's budget after
# the extra add-ons have had their turn. It isn't asked with less than PLUGIN_MIN_S left. Its answers are
# kept like the add-ons': its links may not last much longer.
PLUGIN_S = T.plugin_seconds
PLUGIN_MIN_S = T.plugin_min_seconds
# The wait before asking a plugin once more (it was waking, or answered 429/503).
PLUGIN_RETRY_S = T.plugin_retry_seconds
EXTRAS_WAIT_S = max(0, LOOKUP_BUDGET - PLUGIN_S)
PLUGIN_TTL = S.advanced.cache.plugin_minutes * 60
YOUTUBE_ID = re.compile(r"[A-Za-z0-9_-]{11}")


def playable(streams):
    """How many of an add-on's streams have something to play (some are just notes or links)."""
    return sum(1 for s in streams if s.get("url"))


_addon_pool = ThreadPoolExecutor(max_workers=S.advanced.pools.addon_requests)  # the requests to add-ons
_lookup_pool = ThreadPoolExecutor(max_workers=S.advanced.pools.source_lookups)  # lookups that wait on them (never the same pool)


def addon_results(resource, ctype, vid, enough=None, only_extras=False):
    """Every result for [resource] ("stream" or "subtitles") from the installed add-ons, and
    whether the main ones (AIOStreams, subtitles) answered. AIOStreams is the source: the extra
    add-ons are asked at the same time, but only used when its answer isn't [enough] (nothing, without
    that), and then only until theirs is. With something to fall back on, or a plugin still to ask,
    they're waited for only until EXTRAS_WAIT_S. Plugins aren't asked here (plugin_streams).
    The extra add-ons' answers left unused are kept a while (unused_extras): a viewer may ask for
    them. [only_extras]: the extra add-ons alone, each waited for to the end of the budget."""
    key = "streams" if resource == "stream" else "subtitles"
    start = time.time()  # the budget includes loading the add-on list, after a restart
    account, profile = accounts.account_id(), me()

    def failed(name, error):
        try:
            store.record_failure(account, profile, vid, name,
                                 "lookup_timed_out" if "timed out" in str(error) else "lookup_failed", str(error))
        except Exception:
            log.exception("Couldn't record the failure of %s", name)
    jobs = []
    addons = account_addons()
    own_url = own_aiostreams.url()
    for a in addons:
        if a.get("lastResort"):
            continue
        base = (a.get("transportUrl") or "").removesuffix("/manifest.json")
        # Add-ons running on the phone or PC (Local Files) can't be reached from here; Nightcap's own
        # AIOStreams and the owner's plugins, next to the server, can.
        own = bool(own_url) and base.startswith(own_url + "/") or is_plugin(base)
        if (re.match(r"^https?://(127\.|localhost)", base) and not own) or not base.startswith("http"):
            continue
        if a.get("direct") and resource != "stream":
            continue
        if only_extras and not a.get("direct"):
            continue
        if addon_serves(a.get("manifest") or {}, resource, ctype, vid):
            jobs.append((a["manifest"].get("name") or "?", f"{base}/{resource}/{ctype}/{vid}.json", a.get("direct")))

    def fetch(job):
        """[(name, result)], or None if the add-on didn't answer."""
        name, url, direct = job
        # Every add-on gets the whole wait (an extra one is only waited for when AIOStreams has
        # nothing, and then it's all there is). A main add-on is tried again only after a quick
        # failure (a dropped connection), when there's still time; a slow answer won't be faster
        # a second time. An extra add-on gets one try.
        tries = 0
        while True:
            tries += 1
            left = LOOKUP_BUDGET - (time.time() - start)
            try:
                found = (get_json(url, retries=0, timeout=left) or {}).get(key) or []
                break
            except Exception as e:
                log.warning("%s %s from %s failed (try %d): %s", resource, vid, name, tries, e)
                timed_out = "timed out" in str(e)
                if direct or tries > 1 or timed_out or LOOKUP_BUDGET - (time.time() - start) < 5:
                    failed(name, e)
                    return None
        # An extra add-on sometimes answers before its own sources are in (one with just its
        # one stream of a dozen): ask once more a moment later, and keep the fuller answer. None
        # at all usually means it doesn't have the title, so that isn't asked again.
        if direct and resource == "stream" and 1 <= playable(found) <= THIN_ANSWER \
                and LOOKUP_BUDGET - (time.time() - start) > THIN_RETRY_AFTER_S + 5:
            time.sleep(THIN_RETRY_AFTER_S)
            try:
                again = (get_json(url, retries=0, timeout=LOOKUP_BUDGET - (time.time() - start)) or {}).get(key) or []
                log.info("Stream %s from %s: %d, asked again: %d", vid, name, playable(found), playable(again))
                if playable(again) > playable(found):
                    found = again
            except Exception as e:
                log.warning("Stream %s from %s, asked again, failed: %s", vid, name, e)
        # A direct add-on's files play straight away, like cached ones.
        if direct:
            for x in found:
                x.setdefault("behaviorHints", {})["cached"] = True
                x["direct"] = True
        return [(name, x) for x in found]

    main = [(_addon_pool.submit(fetch, j)) for j in jobs if not j[2]]
    extra = [(_addon_pool.submit(fetch, j)) for j in jobs if j[2]]
    if only_extras:
        done, _ = wait(extra, timeout=max(0, LOOKUP_BUDGET - (time.time() - start)))
        return [x for f in done if f.result() for x in f.result()], True
    answers = [f.result() for f in main]
    found = [x for a in answers if a for x in a]
    answered = all(a is not None for a in answers)
    if not extra or (enough(found) if enough else found):
        if resource == "stream":
            keep_unused_extras(account, vid, extra)
        return found, answered
    until = start + (EXTRAS_WAIT_S if found or any(a.get("lastResort") for a in addons) else LOOKUP_BUDGET)
    pending, more, used = set(extra), [], set()
    while pending:
        done, pending = wait(pending, timeout=max(0, until - time.time()), return_when=FIRST_COMPLETED)
        if not done:
            break
        used |= done
        more += [x for f in done if f.result() for x in f.result()]
        if enough and enough(more):
            break
    if resource == "stream":
        keep_unused_extras(account, vid, [f for f in extra if f not in used])
    return found + more, answered


# The extra add-ons' answers a play didn't use (AIOStreams had enough), by (account, video): their
# lookups, kept PLAY_TTL like the play's own list, so "Look for more sources" doesn't ask them again.
# In memory only: they hold the add-ons' links.
_unused_extras = {}
# Where a play that asked for every source asks its plugins (plugin_streams uses _lookup_pool itself).
_more_pool = ThreadPoolExecutor(max_workers=S.advanced.pools.more_sources)
_unused_lock = threading.Lock()


def keep_unused_extras(account, vid, futures):
    with _unused_lock:
        now = time.time()
        for k in [k for k, (at, _) in _unused_extras.items() if now - at > PLAY_TTL]:
            del _unused_extras[k]
        _unused_extras[(account, vid)] = (now, futures)


def unused_extras(account, vid):
    """The lookups a play left unused, while they're kept: None if there are none here (another
    copy of the server made the play, or it was too long ago)."""
    with _unused_lock:
        hit = _unused_extras.get((account, vid))
    return hit[1] if hit and time.time() - hit[0] < PLAY_TTL else None


def extras_left_unused(account, vid):
    """Whether the play's extra add-ons may have something it didn't use: one still answering, or
    one that answered with sources."""
    return any(not f.done() or f.result() for f in unused_extras(account, vid) or [])


def extra_streams(ctype, vid, started):
    """The extra add-ons' sources for a viewer who asked for more: the play's own lookups if they're
    kept (waited for, within the budget), else the add-ons are asked now."""
    account = accounts.account_id()
    futures = unused_extras(account, vid)
    if futures is None:
        found, _ = addon_results("stream", ctype, vid, only_extras=True)
        return found
    done, _ = wait(futures, timeout=max(0, LOOKUP_BUDGET - (time.time() - started)))
    return [x for f in done if f.result() for x in f.result()]


def first_match(text, table, default=None):
    return next((label for label, rx in table if re.search(rx, text, re.I)), default)


PIXEL_HEIGHTS = [("4K", r"2160p"), ("1080p", r"1080[pi]"), ("720p", r"720p"), ("480p", r"480p")]
RESOLUTIONS = PIXEL_HEIGHTS + [("4K", r"\b4k\b|\buhd\b")]
VIDEO_CODECS = [("AV1", r"\bav1\b"), ("HEVC", r"[xh]\.?265|hevc"), ("AVC", r"[xh]\.?264|\bavc\b"),
                ("VC-1", r"vc-?1"), ("MPEG-2", r"mpeg-?2")]
AUDIO_CODECS = [("Atmos", r"atmos"), ("TrueHD", r"truehd"), ("DTS-HD MA", r"dts-?hd[ .]?ma"), ("DTS:X", r"dts[-:. ]?x\b"),
                ("DTS", r"\bdts"), ("DD+", r"ddp|e-?ac-?3|dd\+"), ("DD", r"\bac-?3\b|\bdd[ .]?[25]|\bdd\b"),
                ("AAC", r"\baac"), ("FLAC", r"\bflac"), ("Opus", r"\bopus")]
SOURCES = [("CAM", r"\b(cam|hdcam|telesync|hdts|\bts\b|tc)\b"), ("Remux", r"remux"), ("Blu-ray", r"blu-?ray|bdrip|brrip"),
           ("WEB-DL", r"web-?dl"), ("WEBRip", r"webrip|\bweb\b"), ("HDTV", r"hdtv")]


FILENAME_LANGUAGES = [("hi", r"\bhindi\b|\bhin\b"), ("ta", r"\btamil\b|\btam\b"), ("te", r"\btelugu\b|\btel\b"),
                      ("en", r"\benglish\b|\beng\b")]


def stream_languages(filename):
    """Audio languages as two-letter codes, from the file name. (Never from how an add-on words its labels:
    a household's own AIOStreams can word them any way.)"""
    return [code for code, rx in FILENAME_LANGUAGES if re.search(rx, filename.replace(".", " "), re.I)]


# Language names as AIOStreams' stream details give them ("English", "Latino"), to two-letter codes.
# The ones that say how many there are ("Multi", "Dual Audio"), not which, are left out.
DETAIL_LANGUAGES = {"latino": "es", "malayalam": "ml", "kannada": "kn", "bengali": "bn", "punjabi": "pa",
                    "marathi": "mr", "urdu": "ur", "dutch": "nl", "swedish": "sv", "norwegian": "no", "danish": "da",
                    "finnish": "fi", "turkish": "tr", "greek": "el", "hebrew": "he", "thai": "th", "indonesian": "id",
                    "vietnamese": "vi", "romanian": "ro", "persian": "fa", "malay": "ms", "filipino": "tl",
                    "lithuanian": "lt", "latvian": "lv", "estonian": "et", "bulgarian": "bg", "croatian": "hr",
                    "serbian": "sr", "slovak": "sk", "slovenian": "sl", "catalan": "ca", "gujarati": "gu", "telugu": "te"}


def detail_languages(details):
    """Audio languages as two-letter codes from AIOStreams' stream details (streamData.parsedFile):
    its audio tracks when it read them from the file, else the languages it read from the name."""
    tracks = details.get("audioTracks") or []
    names = [t.get("lang") for t in tracks if t.get("lang")] or details.get("languages") or []
    codes = []
    for name in names:
        low = str(name).strip().lower()
        code = LANGUAGE_FOR_AUDIO.get(str(name).strip().title()) or DETAIL_LANGUAGES.get(low)
        if code and code not in codes:
            codes.append(code)
    return codes


def parse_stream(addon, s, order):
    """A stream reduced to what the player and its source list need. AIOStreams' stream details
    (streamData, from Nightcap's own AIOStreams or any asked for them) give its languages, debrid
    service, whether it's cached, its size and bitrate; without them they're read from its labels."""
    hints = s.get("behaviorHints") or {}
    data = s.get("streamData") if isinstance(s.get("streamData"), dict) else {}
    details = data.get("parsedFile") or {}
    # Some add-ons only give the file name in their description.
    filename = hints.get("filename") or next(iter(re.findall(
        r"[\w.()\[\]-]+\.(?:mkv|mp4|m4v|avi|ts)\b", (s.get("title") or s.get("description") or ""))), "")
    text = " ".join([filename, s.get("name") or "", s.get("title") or "", s.get("description") or ""])
    clean = re.sub(r"[._]", " ", text)
    hdr = []
    if re.search(r"\b(dv|dovi|dolby ?vision)\b", clean, re.I):
        hdr.append("DV")
    if re.search(r"hdr10\+|hdr10plus", clean, re.I):
        hdr.append("HDR10+")
    elif re.search(r"\bhdr(10)?\b", clean, re.I):
        hdr.append("HDR")
    size = hints.get("videoSize") or 0
    if not size and (m := re.search(r"([\d.]+)\s*(GB|MB)", text)):
        size = float(m.group(1)) * (1e9 if m.group(2) == "GB" else 1e6)
    mbps = re.search(r"([\d.]+)\s*Mbps", text)
    group = re.search(r"-([A-Za-z0-9]+)(?:\.[a-z0-9]{2,4})?$", filename)
    service = hints.get("service")
    # (None: it didn't say.)
    cached = hints.get("cached")
    direct = bool(s.get("direct"))
    languages = stream_languages(filename)
    via = None
    if data:
        on = data.get("service") or {}
        # A plain web link (an add-on that serves files itself, not through a debrid service) plays
        # straight away, like a cached one.
        plain = data.get("type") == "http"
        service = on.get("id") or (None if plain else service)
        cached = bool(on.get("cached")) if on else (plain or cached)
        direct = direct or plain
        size = data.get("size") or size
        # The add-on behind it in AIOStreams.
        via = data["addon"].get("name") if isinstance(data.get("addon"), dict) else data.get("addon")
        found = detail_languages(details)
        if found or details.get("languages") is not None:
            languages = found + [c for c, rx in FILENAME_LANGUAGES
                                 if c not in found and re.search(rx, filename.replace(".", " "), re.I)]
    return {
        "url": s["url"], "addon": addon, "order": order, "filename": filename,
        # An HLS stream, for players that have to know: the address they get (a playback link) won't say.
        "hls": bool(re.search(r"\.m3u8($|\?)", s["url"], re.I)),
        # The file name is the most reliable; add-on labels sometimes say "4K" for upscales.
        "resolution": first_match(filename, PIXEL_HEIGHTS) or first_match(clean, RESOLUTIONS, ""),
        "hdr": hdr,
        "video": first_match(clean, VIDEO_CODECS), "audio": first_match(clean, AUDIO_CODECS),
        "source": first_match(clean, SOURCES), "size": int(size),
        "mbps": round(details["bitrate"] / 1e6, 1) if details.get("bitrate") else float(mbps.group(1)) if mbps else None,
        "group": group.group(1) if group else None,
        "cached": cached, "service": service, "serviceName": own_aiostreams.services().get(service),
        "via": via if via != addon else None,
        "threeD": bool(re.search(r"\b3d\b|\bhsbs\b|\bhou\b", clean, re.I)),
        "bingeGroup": hints.get("bingeGroup"), "direct": direct,
        # AIOStreams' stream type and the file's hash (when it gives one): part of the file's key.
        "kind": data.get("type") if data else None,
        "infoHash": (data.get("torrent") or {}).get("infoHash") if isinstance(data.get("torrent"), dict) else s.get("infoHash"),
        # From an extra add-on, not through AIOStreams.
        "extra": bool(s.get("direct")),
        "languages": languages,
        # Which season and episode AIOStreams read the file as (episode_marks).
        **({"fileEpisode": [details.get("seasons"), details.get("episodes")]}
           if details.get("seasons") and details.get("episodes") else {}),
    }


QUALITY_STEPS = {"480p": 1, "720p": 2, "1080p": 3, "4K": 4}


def resolution_score(resolution, quality):
    """The picture's part of a stream's score. With a chosen quality ("1080p"), that one wins, then
    the next one up, then the next one down; "best" (or none) means the sharpest."""
    if quality not in QUALITY_STEPS:
        return {"4K": 40, "1080p": 30, "720p": 12, "480p": 0}.get(resolution, 5)
    have = QUALITY_STEPS.get(resolution)
    if have is None:
        return 5
    gap = have - QUALITY_STEPS[quality]
    return {0: 40, 1: 28, -1: 24, 2: 14, -2: 12}.get(gap, 5)


def stream_score(s, prefs=None):
    """Higher is better for a 4K HDR TV on the home network, then
    the profile's choices: its quality, and versions in its audio language first (dubbed ones too)."""
    prefs = prefs or {}
    score = resolution_score(s["resolution"], prefs.get("quality"))
    # Language beats a step of quality: a 1080p Hindi version wins over a 4K English one.
    # Releases often list no language at all; those are nearly always in the original language.
    langs = s["languages"] or [prefs.get("original") or "en"]
    if prefs.get("language") and prefs["language"] in langs:
        score += 30
    score += {"Remux": 2, "Blu-ray": 4, "WEB-DL": 5, "WEBRip": 2, "HDTV": -4, "CAM": -200}.get(s["source"], 0)
    if "HDR" in s["hdr"] or "HDR10+" in s["hdr"]:
        score += 5
    # Dolby Vision without an HDR10 base layer shows wrong colours outside Dolby's own players.
    elif "DV" in s["hdr"]:
        score -= 25
    score += {"AV1": -20, "VC-1": -8, "MPEG-2": -8}.get(s["video"], 0)
    if s["mbps"] and s["mbps"] > 45:
        score -= 12
    elif s["mbps"] and s["mbps"] > 30:
        score -= 4
    if s["threeD"]:
        score -= 100
    if s["cached"] is False:
        score -= 60
    # Free direct add-ons have more dead links than a debrid service: at the same quality, the service goes first.
    if s.get("direct"):
        score -= 3
    return score - s["order"] * 0.01


LANGUAGE_CODES = {"en": "English", "hi": "Hindi", "ta": "Tamil", "te": "Telugu", "es": "Spanish", "fr": "French",
                  "de": "German", "it": "Italian", "ja": "Japanese", "ko": "Korean", "ru": "Russian", "pt": "Portuguese",
                  "uk": "Ukrainian", "pl": "Polish", "cs": "Czech", "hu": "Hungarian", "zh": "Chinese", "ar": "Arabic",
                  # Every language a profile can pick for its audio is one (or picking it would do nothing).
                  **{code: name for code, _, name, _ in AUDIO_LANGUAGES}}


# The TV stores the audio language by name ("Hindi"); streams list two-letter codes.
LANGUAGE_FOR_AUDIO = {name: code for code, name in LANGUAGE_CODES.items()}


def stream_label(s):
    # Only worth saying when it isn't plain English.
    langs = " + ".join(LANGUAGE_CODES.get(x, x.upper()) for x in s["languages"]) if s["languages"] != ["en"] else None
    return "  ·  ".join(x for x in [s["resolution"], *s["hdr"], s["source"], s["video"], s["audio"], langs,
                                    f"{s['size'] / 1e9:.1f} GB" if s["size"] else None] if x)


LANGUAGES = {"eng": "English", "hin": "Hindi", "spa": "Spanish", "fre": "French", "fra": "French", "ger": "German",
             "deu": "German", "ita": "Italian", "por": "Portuguese", "pob": "Portuguese (Brazil)", "jpn": "Japanese",
             "kor": "Korean", "chi": "Chinese", "zho": "Chinese", "ara": "Arabic", "rus": "Russian", "dut": "Dutch",
             "nld": "Dutch", "swe": "Swedish", "nor": "Norwegian", "dan": "Danish", "fin": "Finnish", "pol": "Polish",
             "tur": "Turkish", "gre": "Greek", "ell": "Greek", "heb": "Hebrew", "tha": "Thai", "ind": "Indonesian",
             "tam": "Tamil", "tel": "Telugu", "pan": "Punjabi", "urd": "Urdu", "ben": "Bengali", "mal": "Malayalam"}
LANG_ALIASES = {"en": "eng", "hi": "hin", "es": "spa", "fr": "fre", "de": "ger", "it": "ita", "pt": "por",
                "ja": "jpn", "ko": "kor", "zh": "chi", "ar": "ara", "ru": "rus", "nl": "dut", "fra": "fre",
                "deu": "ger", "zho": "chi", "nld": "dut", "ell": "gre"}


def release_tokens(name):
    return {t for t in re.split(r"[^a-z0-9]+", (name or "").lower()) if len(t) > 2} - {"the", "and", "mkv", "mp4", "srt"}


def parse_subtitles(found, filename):
    """Subtitles grouped by language, best match for the chosen file first within each."""
    target = release_tokens(filename)
    seen, out = set(), []
    for addon, s in found:
        if not s.get("url") or s["url"] in seen:
            continue
        seen.add(s["url"])
        code = (s.get("lang") or "und").lower()
        code = LANG_ALIASES.get(code, code)
        release = s.get("title") or s.get("subtitleFileName") or s.get("movieReleaseName") or ""
        out.append({"url": s["url"], "lang": code, "language": LANGUAGES.get(code, code.upper()),
                    "release": release, "addon": addon, "match": len(target & release_tokens(release))})
    out.sort(key=lambda x: (x["language"] != "English", x["language"], -x["match"]))
    for x in out:
        del x["match"]
    return out


def play_sources(ctype, vid):
    """Every stream (parsed) and subtitle for one movie or episode, and whether AIOStreams (and the
    subtitle add-ons) answered; cached because add-ons are slow."""
    subs_f = _lookup_pool.submit(for_me(addon_results), "subtitles", ctype, vid)
    names = title_names(ctype, vid)

    def any_verified(results):
        return any(is_verified(parse_stream(addon, s, 0), vid, names) for addon, s in results if s.get("url"))
    found, answered = addon_results("stream", ctype, vid, any_verified)
    streams = [parse_stream(addon, s, i) for i, (addon, s) in enumerate(found) if s.get("url")]
    subs, subs_answered = subs_f.result()
    return streams, subs, answered and subs_answered


def pick_reasons(streams, prefs, binge=None):
    """Why the first stream is the one tried first, in a few words for the loading screen
    ("Hindi audio, your setting", "no 4K found")."""
    if not streams:
        return []
    top, out = streams[0], []
    if binge and top.get("bingeGroup") == binge:
        out.append("same version as the last episode")
    if want := prefs.get("language"):
        name = LANGUAGE_CODES.get(want, want)
        langs = top["languages"] or [prefs.get("original") or "en"]
        have = " + ".join(LANGUAGE_CODES.get(x, x.upper()) for x in langs)
        out.append(f"{name} audio, your setting" if want in langs else f"{have} audio (no {name} version)")
    quality = prefs.get("quality")
    if quality in QUALITY_STEPS:
        out.append(f"{quality}, your setting" if top["resolution"] == quality else
                   f"{top['resolution'] or 'best'} (no {quality} found)" if not any(s["resolution"] == quality for s in streams)
                   else top["resolution"] or "")
    elif top["resolution"]:
        sharpest = max(QUALITY_STEPS.get(s["resolution"], 0) for s in streams)
        out.append(f"{top['resolution']}, the sharpest" if QUALITY_STEPS.get(top["resolution"], 0) == sharpest else top["resolution"])
    return [x for x in out if x]


def words(text):
    """[text]'s words, lower case, for comparing a title with a file name. An apostrophe joins rather
    than splits ("India's" and "Indias" are both "indias"), as file names usually leave it out."""
    text = re.sub(r"['’`´]", "", (text or "").lower()).replace("&", " and ")
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


def other_title(filename, names):
    """Whether a file name seems to be for another title: it names something else first
    ("Ancient.Civilizations.S02E04.Rise.and.Fall" for Rise and Fall). Site tags in front
    ("[Site.to]", "www.site.com -") are ignored; no file name or no title name: not suspect."""
    if not filename or not names:
        return False
    name = re.sub(r"^(\s*(\[[^\]]*\]|\([^)]*\)|www\.\S+|\S+\.(com|org|net|to|in|me|cc)\b)\s*-?\s*)+", "", filename, flags=re.I)
    have = words(name)
    return not any(have.startswith(words(n)) for n in names)


# Which episode a file is: AIOStreams' own reading of its name when it gives one (parsedFile), else
# guessit's (a library made for reading file names, tested on a great many). Neither is ours to get wrong:
# hand-made patterns read "S02E05.720p" as episodes 5 to 720. The rules guessit needn't run are left
# out (it's then about 10 ms a name, and each name is read once). A bare number stays a number: by
# default guessit splits "One.Piece.1071" into season 10, episode 71 (an anime's episodes are often
# counted from the first); kept whole, it has no season, so it names no episode here.
GUESSIT = {"type": "episode", "episode_prefer_number": True, "excludes": [
    "language", "subtitle_language", "country", "release_group", "website", "streaming_service", "audio_codec",
    "audio_channels", "audio_profile", "video_codec", "video_profile", "color_depth", "container", "mimetype",
    "edition", "crc32", "uuid", "size", "bonus", "cd", "part", "disc", "film", "proper_count", "aspect_ratio",
    "bit_rate", "audio_bit_rate", "video_bit_rate", "frame_rate", "other"]}


def as_marks(seasons, episodes):
    """((seasons), (episodes)) from a reading's season and episode (a number or a list), or None unless
    there are both: an episode without a season ("HD Server 3" is read as episode 3) says nothing."""
    def numbers(x):
        return tuple(n for n in (x if isinstance(x, (list, tuple)) else [x]) if isinstance(n, int) and not isinstance(n, bool))
    s, e = numbers(seasons), numbers(episodes)
    return (s, e) if s and e else None


@lru_cache(maxsize=8192)
def guessed_episode(filename):
    try:
        g = guessit(filename, GUESSIT)
    except Exception:
        log.warning("Couldn't read a file name's episode")
        return None
    return as_marks(g.get("season"), g.get("episode"))


def episode_marks(s):
    """The seasons and episodes a source's file says it is, or None if it doesn't say both."""
    said = s.get("fileEpisode")
    return as_marks(*said) if said else guessed_episode(s.get("filename") or "")


def other_episode(s, vid):
    """The episode a source's file says it is, as "S2 E12", when that's not [vid]'s; None for one that
    names no episode, or this one (a two-episode file with it too)."""
    parts = vid.split(":")
    marks = episode_marks(s) if len(parts) == 3 else None
    if not marks or (int(parts[1]) in marks[0] and int(parts[2]) in marks[1]):
        return None
    return f"S{marks[0][0]} E{marks[1][0]}"


def title_names(ctype, vid):
    """The names a title goes by here, to compare file names with."""
    imdb_id = vid.split(":")[0]
    known = store.title(imdb_id) or {}
    return [n for n in (known.get("name"), cinemeta(ctype, imdb_id).get("name")) if n]


def is_verified(s, vid, names):
    """Whether a stream is known to be this film or episode, so it can be played by itself: a plugin says
    so (it goes by the title's id and the exact episode); otherwise its file name has to. An episode's
    must give this season and episode, and a film's must be there at all. AIOStreams has checked the title
    of what it hands over from its own filters; a direct source's name (from an extra add-on, or one it
    passes through as it is) is compared here, so it can't pass without a title to compare it with.
    "HD Server 3" says nothing: unverified."""
    if s.get("plugin"):
        return bool(s.get("verified"))
    if s.get("otherLength"):
        return False
    name = s["filename"]
    if not name or (s.get("direct") and (not names or other_title(name, names))):
        return False
    parts = vid.split(":")
    if len(parts) != 3:
        return True
    marks = episode_marks(s)
    return bool(marks) and int(parts[1]) in marks[0] and int(parts[2]) in marks[1]


# A file that runs far from the title's length is another title, a sample or a stub. The right file
# runs close to the film's runtime (extended cuts too); another film of the same name, a sample or a
# stub runs far shorter. A show's runtime is its usual episode's, so its episodes are let run further from it.
FILM_LENGTH = (0.8, 1.3)
EPISODE_LENGTH = (0.5, 2.0)
# The first few a play would try are read, all at once; once more if some were off.
LENGTH_CHECKED = 4
LENGTH_ROUNDS = 2
LENGTH_CHECK_S = S.advanced.timeouts.length_check_seconds
# What a file was found to run, by its link: a play asked again (a reconnect) doesn't read it again.
LENGTH_KEPT_S = 6 * 3600
# One that couldn't be read is tried again after this (it may only have been busy).
LENGTH_FAILED_S = 120
_lengths = {}
_lengths_lock = threading.Lock()
_length_pool = ThreadPoolExecutor(LENGTH_CHECKED * 2, thread_name_prefix="lengths")


def title_runtime(ctype, vid, known):
    """How long the title runs, in seconds (a film; a show's usual episode), or None."""
    if known.get("runtime_min"):
        return known["runtime_min"] * 60
    m = re.search(r"\d+", str(cinemeta(ctype, vid.split(":")[0]).get("runtime") or ""))
    return int(m.group()) * 60 if m and int(m.group()) else None


def file_seconds(s):
    """How long a source's file runs, read from its header (filetracks.py), or None."""
    return file_header(s)["seconds"]


def file_header(s, account=None, vid=None):
    """What a source's file says about itself (filetracks.file_info: its audio tracks' languages, in
    order, and how long it runs), read once and kept a while; each None when it couldn't be read.
    [account]: the household it's read for (taken on the request's thread: the reads run in a pool
    with no profile), so it's kept by the file's key under that household (the add-on's link changes on
    every lookup) and counted within its debrid service's limits. A read that worked is kept
    LENGTH_KEPT_S; one that failed, a couple of minutes; a file still being prepared, not at all; and
    none is tried while the household's service is limiting it. A file of [vid] that turns out gone is
    written down (playlinks._sighting)."""
    from . import filetracks  # (It uses this module's language tables.)
    key = (account, playlinks.stream_key(s)) if account else s["url"]
    hit = _lengths.get(key)
    if hit and time.time() - hit[0] < hit[2]:
        return hit[1]
    follow = playlinks.Follow(account, s.get("service"), s.get("kind"), playlinks.stream_key(s), s.get("addon"),
                              guess=True) if account else None
    if follow and follow.service and not s.get("direct"):
        if (linkstate.busy_until(account, follow.service, follow.kind) or linkstate.refused(account, follow.service, follow.kind)
                or linkstate.count(account, follow.service, follow.kind, guess=True)):
            return dict(filetracks.NOTHING)
    kept = LENGTH_KEPT_S
    try:
        info = filetracks.file_info(playlinks.file_reader(s["url"], bool(s.get("direct")), LENGTH_CHECK_S, follow))
    except playlinks.Preparing:
        return dict(filetracks.NOTHING)
    except playlinks.Gone:
        if follow and not s.get("direct"):
            playlinks._sighting(account, vid, {"c": 0 if s.get("cached") is False else 1, "s": follow.service,
                                               "a": s.get("addon"), "k": follow.key})
        info, kept = dict(filetracks.NOTHING), LENGTH_FAILED_S
    except playlinks.Unavailable:
        info, kept = dict(filetracks.NOTHING), LENGTH_FAILED_S
    except Exception:
        log.exception("Couldn't read a file's header")
        info, kept = dict(filetracks.NOTHING), LENGTH_FAILED_S
    with _lengths_lock:
        _lengths[key] = (time.time(), info, kept)
        if len(_lengths) > 5000:
            for k in [k for k, (at, _, ttl) in _lengths.items() if time.time() - at >= ttl]:
                _lengths.pop(k, None)
    return info


def how_long(seconds):
    m = round(seconds / 60)
    return f"{round(seconds)} s" if seconds < 90 else f"{m} min" if m < 60 else f"{m // 60} h {m % 60:02d} min"


def check_lengths(streams, runtime, episode, rank, vid=None):
    """[streams] in the order they'd be tried ([rank] sorts them), with the first few a play would try
    by itself read for how long they run; one far from [runtime] is marked (otherLength, what it runs),
    and so goes last and is never tried by itself. One that couldn't be read is left as it was."""
    if not runtime:
        return streams
    low, high = EPISODE_LENGTH if episode else FILM_LENGTH
    checked, off, heard = set(), 0, False
    # (The household, taken here: the reads run in a pool with no profile.)
    try:
        account = str(accounts.account_id())
    except Exception:
        account = None
    for _ in range(LENGTH_ROUNDS):
        # (Verified ones only, as rank placed them (_tier): the others aren't tried first anyway. Not one
        # a debrid service hasn't got yet: its link would start the download.)
        # (A source with no address, as a plugin's YouTube video, has no file to read: it's left out.)
        batch = [s for s in streams if s.get("url") and s["url"] not in checked and s.get("_tier", 0) <= 1
                 and s.get("cached") is not False][:LENGTH_CHECKED]
        if not batch:
            break
        futures = {_length_pool.submit(file_header, s, account, vid): s for s in batch}
        done, _ = wait(futures, timeout=LENGTH_CHECK_S + 1)
        checked.update(s["url"] for s in batch)
        found = 0
        for f in done:
            info, s = f.result(), futures[f]
            seconds = info["seconds"]
            # (Its audio tracks' languages, in order, come with it: the player opens it in the wanted one.)
            if info["audio"]:
                s["fileAudio"] = info["audio"]
                heard = True
            if seconds and not low <= seconds / runtime <= high:
                s["otherLength"] = f"Runs {how_long(seconds)}, not {how_long(runtime)}"
                found += 1
        off += found
        if not found:
            break
        streams = rank(streams)
    # (A file's own header saying its languages can move it: the wanted language first.)
    if heard:
        streams = rank(streams)
    if off:
        log.info("Lengths: %d of %d read run far from %s", off, len(checked), how_long(runtime))
    return streams


# The player's words when every source found seems to be another title's or episode's file.
NOTHING_YET = "No sources found for this one yet. Try again later."
SETTING_UP = "Setting up sources…"


def source_tier(s, vid, names):
    """The order sources are tried in, lowest first: verified from AIOStreams, verified from the extra
    add-ons, a plugin's, the ones that can't be verified, and last a direct file that seems to be another
    title or episode. A wrong episode is worse than a wait."""
    if s.get("plugin"):
        return 2 if s.get("verified") else 3
    if s.get("otherLength"):
        return 4
    if s.get("direct") and (other_title(s["filename"], names) or other_episode(s, vid)):
        return 4
    if not is_verified(s, vid, names):
        return 3
    return 1 if s.get("extra") else 0


def youtube_id(s):
    """The YouTube video a plugin's stream is, when it has no address of its own (Stremio's ytId). The apps
    play it themselves, so it's only taken when it's the shape of a video's id."""
    yt = s.get("ytId")
    return yt if not s.get("url") and isinstance(yt, str) and YOUTUBE_ID.fullmatch(yt) else None


def plugin_stream(addon, s, order):
    """A plugin's stream, parsed like an add-on's, with what it says of itself. It has no file name, so it
    goes by the plugin's: what the source lists show for one with nothing else to say. A YouTube video has
    "youtube" (its id) in place of "url", and its description is the uploader's title, not a release's:
    "4K" or "CAM" in it says nothing, so it isn't read."""
    says = s.get("nightcap") or {}
    hints = {**(s.get("behaviorHints") or {}), "cached": True}
    yt = youtube_id(s)
    video = {"url": "", "title": "", "description": ""} if yt else {}
    out = {**parse_stream(addon, {**s, **video, "direct": True, "behaviorHints": hints}, order), "filename": addon, "plugin": True, "hls": says.get("type") == "hls",
           "verified": bool(says.get("verified")), "browser": bool(says.get("browser")), "lengthS": says.get("lengthS")}
    if yt:
        del out["url"]
        out["youtube"] = yt
    return out


def worth_retrying(e):
    """A plugin's failure that a moment's wait may get past: 429, 503, or a connection that didn't
    connect or dropped. Not another 4xx, nor running out of time (that wait was the play's)."""
    if isinstance(e, HTTPError):
        return e.code in (429, 503)
    if isinstance(e, URLError):
        return not isinstance(e.reason, (TimeoutError, Blocked))
    return isinstance(e, ConnectionError)


def short_error(e):
    """What went wrong, without the address (a plugin's holds its token)."""
    return f"HTTP {e.code}" if isinstance(e, HTTPError) else type(getattr(e, "reason", None) or e).__name__


def plugin_streams(ctype, vid, started):
    """What the household's plugins have for this title. Only asked here, for a play: never by the look
    for a new episode's sources, or for titles nobody is playing. A stream that needs headers is left out,
    as players can't send them. A plugin that fails or runs out of time counts for nothing and isn't kept
    (an empty answer is: it looked), so the next play asks it again. Their addresses hold tokens: never logged."""
    def ask(n, url):
        left = LOOKUP_BUDGET - (time.time() - started)
        if left < PLUGIN_MIN_S:
            # (Not an error for the play: what the add-ons found still goes out.)
            log.warning("Plugin %d not asked for %s: %.0f s left", n, vid, left)
            return []

        def fetch():
            base = url.removesuffix("/manifest.json")
            # (Its manifest isn't read again, so it isn't asked what it serves: it answers for what it doesn't.)
            for again in (False, True):
                try:
                    answer = get_json(f"{base}/stream/{ctype}/{vid}.json", retries=0,
                                      timeout=LOOKUP_BUDGET - (time.time() - started)) or {}
                    break
                except Exception as e:
                    # Waking, or an old instance going away (Cloud Run's 429 or 503, a dropped
                    # connection): once more after a moment, if the play's time allows.
                    left_after = LOOKUP_BUDGET - (time.time() - started) - PLUGIN_RETRY_S
                    if again or not worth_retrying(e) or left_after < PLUGIN_MIN_S:
                        raise
                    log.info("Plugin %d: %s for %s, asking once more in %d s", n, short_error(e), vid, PLUGIN_RETRY_S)
                    time.sleep(PLUGIN_RETRY_S)
            return [plugin_stream(s.get("name") or "Plugin", s, 1000 + i) for i, s in enumerate(answer.get("streams") or [])
                    if (s.get("url") or youtube_id(s)) and not (s.get("nightcap") or {}).get("needsHeaders")]
        try:
            return cached(f"plugin:{account}:{n}:{vid}", fetch, ttl=PLUGIN_TTL)
        except Exception as e:
            log.warning("Plugin %d failed for %s: %s", n, vid, type(e).__name__)
            return []
    account = accounts.account_id()
    plugins = [a["transportUrl"] for a in account_addons() if a.get("lastResort")]
    jobs = [_lookup_pool.submit(for_me(ask), n, url) for n, url in enumerate(plugins, 1)]
    return [s for job in jobs for s in job.result()]


def more_key(vid):
    return f"more:{me()}:{vid}"


def meets_want(s, want, original):
    """How well a file has the wanted audio language: 3 its own header says so, 2 its name does, 1 it
    names none and [want] is English or the title's own, 0 not. The TV's rule (PlayOrder.level)."""
    if not want:
        return 0
    heard = s.get("fileAudio")
    if heard:
        return 3 if want in heard else 0
    if s.get("languages"):
        return 2 if want in s["languages"] else 0
    return 1 if want in ("en", original) else 0


def play_info(ctype, vid, binge=None, more=False, audio=None):
    """What the Nightcap player needs: ranked streams, subtitles matched to the best one, where to
    resume (always fresh), and the next episode. [binge] is the release the previous episode
    played, kept when it's there so quality and audio stay the same through a season. With no verified
    source, the plugins are asked too (plugin_streams). [more]: the viewer asked for every source (Look
    for more sources): the extra add-ons' unused ones and the plugins too; remembered for PLAY_TTL, so
    a fresh answer for the same play (new links, a reconnect) keeps them. [audio]: the language picked
    in the player ("hi"), "*" for the one saved for this title, or "" / None for none: files with it
    are tried first."""
    started = time.time()
    # A film that isn't out yet has no sources: whatever turns up is another title of the same name
    # (an old film, a book). None are looked for; the answer says when it comes out.
    releases = film_releases(vid) if ctype == "movie" else None
    names = title_names(ctype, vid)
    if releases is not None:
        streams, found_subs = [], []
    else:
        # Asked for again after a couple of minutes: a list that has only the extra add-ons' sources
        # (they're patchy: one sometimes answers with one source of its dozen), or none known to
        # be this title (an extra add-on can miss a new episode for minutes at a time, and an add-on's unnamed
        # links, "HD Server", don't play it).
        if ask_again(cache.get(play_key(vid)), vid, names):
            cache.drop(play_key(vid))
        streams, found_subs, answered = cached(play_key(vid), lambda: play_sources(ctype, vid), ttl=PLAY_TTL)
        # A failed lookup (or one AIOStreams missed) must not stick around: the next try asks again.
        # Nor a thin one from the extra add-ons alone (one source that may not play).
        thin = len(streams) <= THIN_ANSWER and all(s.get("direct") for s in streams)
        if not streams or not answered or thin:
            cache.drop(play_key(vid))
    settings = store.profile_settings(me())
    prefs = {"quality": settings.get("quality"),
             "language": LANGUAGE_FOR_AUDIO.get(settings.get("audio_language") or "English"),
             "original": original_language(vid.split(":")[0], ctype)}
    imdb_id = vid.split(":")[0]
    known = store.title(imdb_id) or {}
    if more and releases is None:
        cache.put(more_key(vid), True)
    everything = releases is None and (more or bool(cache.get(more_key(vid), PLAY_TTL)))
    has_plugins = any(a.get("lastResort") for a in account_addons()) if releases is None else False
    # What this play didn't ask, or didn't use, that the viewer may ask for.
    more_to_ask = not everything and releases is None and bool(streams) and (
        extras_left_unused(accounts.account_id(), vid) or (has_plugins and any(is_verified(s, vid, names) for s in streams)))
    # Asked for every source: the plugins start now, alongside the extra add-ons (which can take the
    # whole budget), not after them.
    plugins_early = _more_pool.submit(for_me(plugin_streams), ctype, vid, started) if everything else None
    if everything:
        have = {s["url"] for s in streams}
        extras = [parse_stream(addon, s, 500 + i) for i, (addon, s) in enumerate(extra_streams(ctype, vid, started))
                  if s.get("url") and s["url"] not in have]
        streams = streams + [s for i, s in enumerate(extras) if s["url"] not in {x["url"] for x in extras[:i]}]
    verified = sum(is_verified(s, vid, names) for s in streams)
    asked = releases is None and (not verified or everything)
    from_plugins = plugins_early.result() if plugins_early else plugin_streams(ctype, vid, started) if asked else []
    if releases is not None:
        log.info("Play %s: not out yet (%s), no sources looked for", vid, releases or "no date")
    else:
        log.info("Play %s: %d verified, %d not, %s%s", vid, verified, len(streams) - verified,
                 f"{len(from_plugins)} from plugins" if asked else "plugins not asked",
                 ", every source (asked for more)" if everything else ", more to ask" if more_to_ask else "")
    try:
        st = library_state(imdb_id)
    except Exception:
        log.exception("Couldn't read watch state for %s", vid)
        st = {}
    want = st.get("audioPick") if audio == "*" else audio or None
    # Files of this household's seen gone lately (store.file_health): a dead one goes after the rest.
    try:
        health = store.file_health(str(accounts.account_id()), vid) if streams or from_plugins else {}
    except Exception:
        log.exception("Couldn't read which files were seen gone for %s", vid)
        health = {}
    # Nothing unverified is dropped (a file can be named in a way this doesn't recognise): it's kept for last.
    def rank(found):
        for s in found:
            s["_tier"] = source_tier(s, vid, names)
            s.setdefault("key", playlinks.stream_key(s))
        # (Verified ones first; among them the wanted language; then not dead; then as before.)
        return sorted(found, key=lambda s: (s["_tier"] <= 2, meets_want(s, want, prefs["original"]),
                                            health.get(s["key"]) != "dead", -s["_tier"],
                                            bool(binge) and s.get("bingeGroup") == binge, stream_score(s, prefs)),
                      reverse=True)
    # (Copies: the cached answer's sources aren't marked.)
    streams = rank([dict(s) for s in streams + from_plugins])
    # A file that runs far from the title's length is another title, a sample or a stub: read for the
    # first few, before any is tried.
    if releases is None:
        streams = check_lengths(streams, title_runtime(ctype, vid, known), ctype == "series", rank, vid)
    for s in streams:
        s.pop("_tier", None)
    why = pick_reasons(streams, prefs, binge)
    # A file that says it's another episode is never played by itself (the TV tries the others);
    # it's left in the list, marked, for picking by hand (a name can be misread).
    streams = [{**s, "label": stream_label(s) or s["filename"], "verified": is_verified(s, vid, names),
                # (A file seen gone: "dead" twice, 30 min apart, tried last; "seen" once lately, last in its group.)
                **({health[s["key"]]: True} if s["key"] in health else {}),
                **({"otherEpisode": other} if s.get("direct") and (other := other_episode(s, vid)) else {})}
               for s in streams]
    subtitles = parse_subtitles(found_subs, streams[0]["filename"] if streams else "")
    same = ctype == "movie" or st.get("video_id") == vid
    meta = cinemeta(ctype, vid.split(":")[0])
    parts = vid.split(":")
    episode = next((v for v in meta.get("videos") or [] if v.get("id") == vid), {}) if len(parts) == 3 else {}
    return {
        "id": vid, "type": ctype, "name": meta.get("name") or vid,
        "episode": f"S{parts[1]} E{parts[2]}  ·  {episode.get('name') or episode.get('title') or ''}".strip(" ·")
        if len(parts) == 3 else None,
        "resume": (st.get("timeOffset") or 0) if same else 0,
        # How long it runs (a film; a show's usual episode), so the player can tell a clip that isn't it.
        "runtimeMs": known["runtime_min"] * 60_000 if known.get("runtime_min") else None,
        "streams": streams, "subtitles": subtitles, "why": why,
        # What the player says when none of them would be tried by itself (each another episode's file,
        # or far from its length): plain words for the viewer, not why (the Source list still has them).
        # (None found while the household's sources are still being set up: that's said instead.)
        "notice": (NOTHING_YET if streams and all(s.get("otherEpisode") or s.get("otherLength") for s in streams)
                   else SETTING_UP if not streams and releases is None and sources.setting_up(accounts.account_id()) else None),
        # The audio language wanted (a code, "en"), and the title's original one: a player that can't
        # pick an audio track (a browser) prefers files in that language alone.
        "audioLanguage": prefs["language"] or prefs["original"], "originalLanguage": prefs["original"],
        # The audio language picked in the player for this title, if one was ("hi").
        "titleAudio": st.get("audioPick"),
        # The subtitles picked in the player for this title, if any were ("eng", "off").
        "titleSubtitles": st.get("subtitlePick"),
        "next": next_card(vid) if ctype == "series" else None,
        # For the one-time questions: already rated? already asked? episodes finished so far.
        "myRating": store.rating(me(), vid.split(":")[0]),
        "asked": sorted(store.prompts(me(), vid.split(":")[0])),
        "finishedEpisodes": len(store.ticks(me(), vid.split(":")[0])) if ctype == "series" else None,
        # A film that isn't out yet: when it comes out ("2026-11-04", "" if not known). No streams then.
        **({"releases": releases} if releases is not None else {}),
        # Sources this play didn't ask or use (the plugins, the extra add-ons): asked for with ?more=1.
        **({"moreSources": True} if more_to_ask else {}),
    }
