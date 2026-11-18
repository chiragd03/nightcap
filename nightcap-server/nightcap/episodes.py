"""Episodes: when they come out (TVmaze air times), and which comes next."""

import logging
import time
from datetime import datetime, timedelta, timezone

from . import accounts, cache
from .config import S
from .context import NoProfile
from .http import cinemeta, get_json

log = logging.getLogger(__name__)


def out_at(v):
    """When an episode can be watched, as "YYYY-MM-DDTHH:MM:SS" UTC ("" if unknown): when its
    broadcast ends, if TVmaze's air time for it has been looked up (see airtimes); otherwise from
    the end of its air date, since Cinemeta gives only the date (as midnight UTC) and streams turn
    up after the broadcast."""
    try:
        day = datetime.strptime((v.get("released") or "")[:10], "%Y-%m-%d")
    except ValueError:
        return ""
    return broadcast_end(v, day) or (day + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S")


# Cinemeta and TMDB have only air dates. TVmaze has each episode's broadcast time (free, no key).
# Looked up only for shows you're following whose next episode is due about now (see
# follow_airtimes), and kept: the times don't change.

TVMAZE = "https://api.tvmaze.com"
AIRTIMES_TTL = S.advanced.cache.air_times_hours * 3600
AIRTIMES_RETRY = S.advanced.cache.air_times_retry_minutes * 60        # after a lookup that failed
RUNTIME_GUESS_MIN = 60          # when TVmaze doesn't say how long an episode runs


def airtimes_cached(imdb_id):
    """{"season:episode": [air date, broadcast end UTC]} if looked up recently, else None."""
    hit = cache.get(f"tvmaze:{imdb_id}")
    if not hit:
        return None
    at, value = hit
    return value if time.time() - at < (AIRTIMES_TTL if value is not None else AIRTIMES_RETRY) else None


def airtimes(imdb_id):
    """Looks up a show's episode air times on TVmaze ({} if it isn't there or has ended)."""
    known = airtimes_cached(imdb_id)
    if known is not None:
        return known
    try:
        show = get_json(f"{TVMAZE}/lookup/shows?imdb={imdb_id}", retries=1, timeout=S.advanced.timeouts.tvmaze_seconds) or {}
        out = {}
        if show.get("id") and show.get("status") != "Ended":
            for e in get_json(f"{TVMAZE}/shows/{show['id']}/episodes", retries=1, timeout=S.advanced.timeouts.tvmaze_episodes_seconds) or []:
                if not (e.get("airstamp") and e.get("season") and e.get("number")):
                    continue
                start = datetime.fromisoformat(e["airstamp"]).astimezone(timezone.utc)
                end = start + timedelta(minutes=e.get("runtime") or RUNTIME_GUESS_MIN)
                out[f"{e['season']}:{e['number']}"] = [e.get("airdate") or "", end.strftime("%Y-%m-%dT%H:%M:%S")]
        cache.put(f"tvmaze:{imdb_id}", out)
        return out
    except Exception as e:
        log.warning("TVmaze air times for %s unavailable: %s", imdb_id, e)
        cache.put(f"tvmaze:{imdb_id}", None)
        return {}


def broadcast_end(v, day):
    """When an episode's broadcast ends, from TVmaze if looked up; None otherwise, or when TVmaze's
    date for that episode number is more than a day from Cinemeta's (numbered differently)."""
    parts = (v.get("id") or "").split(":")
    times = airtimes_cached(parts[0]) if len(parts) == 3 else None
    found = (times or {}).get(f"{v.get('season')}:{v.get('episode')}")
    if not found:
        return None
    airdate, end = found
    try:
        if abs((datetime.strptime(airdate, "%Y-%m-%d") - day).days) > 1:
            return None
    except ValueError:
        return None
    return end


def next_unwatched(imdb_id, current, watched):
    """The episode to watch next (a Cinemeta video): the current one if unwatched, else the one after."""
    videos = sorted((v for v in cinemeta("series", imdb_id).get("videos") or [] if (v.get("season") or 0) > 0 and v.get("id")),
                    key=lambda v: (v.get("season") or 0, v.get("episode") or 0))
    ids = [v["id"] for v in videos]
    if current not in ids:
        return None
    i = ids.index(current) + (1 if current in watched else 0)
    return videos[i] if i < len(videos) else None


def due_now(v):
    """Whether an episode's air date is yesterday, today or tomorrow (UTC): when its time matters."""
    day = (v.get("released") or "")[:10]
    return day in {time.strftime("%Y-%m-%d", time.gmtime(time.time() + d * 86400)) for d in (-1, 0, 1)}


def early(v, now=None):
    """Whether an episode known only by its air date (no broadcast time from TVmaze) is in the part
    of its air day when it may already be out: from EARLY_HOUR (UTC) until out_at, the day's end. A
    daily show's is often playable hours before."""
    day = (v.get("released") or "")[:10]
    try:
        if broadcast_end(v, datetime.strptime(day, "%Y-%m-%d")):
            return False
    except ValueError:
        return False
    return f"{day}T{EARLY_HOUR:02d}:00:00" <= (now or time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()))


def is_out(v, now=None):
    """Whether an episode can be watched: out by the clock (out_at), or found playable early on its
    air day (see early; playback.look_for_sources looks)."""
    at = out_at(v)
    if not at:
        return False
    now = now or time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
    # (Early, only with a source known to be this episode: see playback.look_for_sources.)
    return at <= now or (early(v, now) and bool(v.get("id")) and sources_known(v["id"]) == "verified")


EARLY_HOUR = S.advanced.cache.new_episode_early_hour


# Whether a new episode's add-ons have answered with sources, per account (playback.look_for_sources
# looks, and keeps the answer here).
SOURCES_RECHECK = S.advanced.cache.new_episode_recheck_minutes * 60


def ready_key(vid):
    return f"ready:{accounts.account_id()}:{vid}"


def sources_known(vid, early=False):
    """From the last look: "verified" (a source known to be this episode), "some" (sources, none
    known to be it) or False (none: kept only half an hour); None if not looked yet (or there's no
    profile to ask for). For an episode [early] on its air day "some" is kept only half an hour too:
    it's looked for again until a source known to be it turns up (an add-on's unnamed links are there
    for any episode, before it's out)."""
    try:
        hit = cache.get(ready_key(vid))
    except NoProfile:
        return None
    if not hit:
        return None
    at, ready = hit
    lasting = ready == "verified" or (ready == "some" and not early)
    return ready if lasting or time.time() - at < SOURCES_RECHECK else None


def new_episodes(imdb_id, last_watched, current=None, watched=(), started=False):
    """The "+N" badge: once an episode has come out since you last watched, how many aired
    episodes are waiting for you (not just the newly released ones): the one you're on unless
    you've started it, and every unwatched one after it."""
    try:
        meta = cinemeta("series", imdb_id)
    except Exception as e:
        # One show's lookup failing shouldn't take Continue watching down with it.
        log.warning("New episodes for %s unavailable: %s", imdb_id, e)
        return 0
    aired = sorted((v for v in meta.get("videos") or [] if (v.get("season") or 0) > 0 and is_out(v)),
                   key=lambda v: (v.get("season") or 0, v.get("episode") or 0))
    if not any(last_watched < out_at(v) for v in aired):
        return 0
    ids = [v.get("id") for v in aired]
    after = (ids.index(current) + (1 if started else 0)) if current in ids else 0
    return sum(1 for v in aired[after:] if v.get("id") not in watched)


def waiting_episodes(row, watched):
    """"+N" for one library row (see new_episodes)."""
    last = row["last_watched_at"].astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S") if row["last_watched_at"] else ""
    return new_episodes(row["imdb_id"], last, row["current_video_id"], watched, started=bool(row["position_ms"]))


def episode_out(vid):
    """Whether one episode can be watched yet (true when Cinemeta doesn't list it)."""
    v = next((v for v in cinemeta("series", vid.partition(":")[0]).get("videos") or [] if v.get("id") == vid), None)
    return v is None or is_out(v)


def next_episode(vid):
    """The episode after [vid] that has aired (specials skipped), as a Cinemeta video, or None."""
    imdb_id, _, _ = vid.partition(":")
    videos = sorted((v for v in cinemeta("series", imdb_id).get("videos") or []
                     if (v.get("season") or 0) > 0 and v.get("id")),
                    key=lambda v: (v.get("season") or 0, v.get("episode") or 0))
    ids = [v["id"] for v in videos]
    if vid not in ids:
        return None
    following = videos[ids.index(vid) + 1:]
    nxt = following[0] if following else None
    return nxt if nxt and is_out(nxt) else None


def next_card(vid):
    nxt = next_episode(vid)
    if not nxt:
        return None
    return {"id": nxt["id"], "episode": f"S{nxt['season']} E{nxt['episode']}",
            "name": nxt.get("name") or nxt.get("title") or f"Episode {nxt['episode']}",
            "thumbnail": nxt.get("thumbnail")}


def aired_episodes(imdb_id, season=None):
    """A show's aired episodes (specials left out), or just one season's."""
    return [v["id"] for v in cinemeta("series", imdb_id).get("videos") or []
            if v.get("id") and (v.get("season") or 0) > 0 and is_out(v)
            and (season is None or v.get("season") == season)]
