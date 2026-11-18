"""Title details from TMDB: the shared title cache, genres, and what a card shows."""

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from psycopg.types.json import Jsonb

from . import cache, store
from .config import S

C = S.advanced.cache
from .cache import cached
from .context import NoProfile, me
from .http import cinemeta, tmdb

log = logging.getLogger(__name__)


def _found(imdb_id):
    """TMDB's match for an IMDb id, film and series: {"movie": [tmdb id, original language] or None,
    "tv": ...}. One lookup per title, kept (it doesn't change): each card, its language and its
    recommendations all ask it."""
    def load():
        data = tmdb(f"/find/{imdb_id}", external_source="imdb_id") or {}
        first = lambda hits: [hits[0]["id"], hits[0].get("original_language")] if hits else None
        return {"movie": first(data.get("movie_results") or []), "tv": first(data.get("tv_results") or [])}
    found = cached(f"found:{imdb_id}", load, ttl=C.found_days * 86400)
    if not found["movie"] and not found["tv"]:
        cache.drop(f"found:{imdb_id}")  # (Not on TMDB yet: asked again next time.)
    return found


def tmdb_find(imdb_id, ctype):
    hit = _found(imdb_id)["movie" if ctype == "movie" else "tv"]
    return hit[0] if hit else None


def original_language(imdb_id, ctype):
    """The title's original language as a two-letter code ("hi" for Pathaan), "en" if unknown."""
    try:
        hit = _found(imdb_id)["movie" if ctype == "movie" else "tv"]
    except Exception:
        log.warning("Couldn't look up the language of %s", imdb_id)
        return "en"
    return (hit and hit[1]) or "en"



TMDB_IMG = "https://image.tmdb.org/t/p"


def fresh_match(imdb_id, ctype):
    """TMDB's match for an IMDb id asked now, not the kept one (see _found); None if there's none."""
    data = tmdb(f"/find/{imdb_id}", external_source="imdb_id") or {}
    hits = data.get("movie_results" if ctype == "movie" else "tv_results") or []
    return hits[0]["id"] if hits else None


def title_row(imdb_id, ctype, tmdb_id=None):
    """One title from TMDB (TMDB's [tmdb_id], else its kept match), or None if TMDB doesn't know it."""
    kind = "movie" if ctype == "movie" else "tv"
    tmdb_id = tmdb_id or tmdb_find(imdb_id, ctype)
    if not tmdb_id:
        return None
    extras = "videos,keywords," + ("credits,release_dates" if kind == "movie" else "aggregate_credits,content_ratings")
    d = tmdb(f"/{kind}/{tmdb_id}", append_to_response=extras)
    if not d:
        cache.drop(f"found:{imdb_id}")  # (TMDB's match is gone: it's looked for again next time.)
        return None
    kw = (d.get("keywords") or {}).get("keywords" if kind == "movie" else "results") or []
    credits = d.get("credits" if kind == "movie" else "aggregate_credits") or {}
    cast = sorted(credits.get("cast") or [], key=lambda c: c.get("order", 999))[:5]
    creators = ([{"id": c["id"], "name": c["name"]} for c in credits.get("crew") or [] if c.get("job") == "Director"]
                if kind == "movie" else [{"id": c["id"], "name": c["name"]} for c in d.get("created_by") or []])
    runtime = d.get("runtime") if kind == "movie" else next(iter(d.get("episode_run_time") or []), None) \
        or ((d.get("last_episode_to_air") or {}).get("runtime"))
    coll = d.get("belongs_to_collection")
    videos = [v for v in (d.get("videos") or {}).get("results", []) if v.get("site") == "YouTube"]
    videos.sort(key=lambda v: (v.get("type") != "Trailer", not v.get("official"), v.get("type") != "Teaser"))
    # Age rating in each country that has one.
    if kind == "movie":
        ratings = {r["iso_3166_1"]: next((x["certification"] for x in r.get("release_dates") or [] if x.get("certification")), None)
                   for r in (d.get("release_dates") or {}).get("results") or []}
    else:
        ratings = {r["iso_3166_1"]: r.get("rating") for r in (d.get("content_ratings") or {}).get("results") or []}
    certification = {c: r for c, r in ratings.items() if r}
    return {
        "imdb_id": imdb_id, "type": ctype, "tmdb_id": tmdb_id,
        "name": d.get("title") or d.get("name"),
        "language": d.get("original_language"),
        "genres": [g["id"] for g in d.get("genres") or []],
        "poster": f"{TMDB_IMG}/w342{d['poster_path']}" if d.get("poster_path") else None,
        "backdrop": f"{TMDB_IMG}/w1280{d['backdrop_path']}" if d.get("backdrop_path") else None,
        "overview": d.get("overview") or None,
        "rating": round(d["vote_average"], 1) if d.get("vote_average") else None,
        "trailer": videos[0]["key"] if videos else None,
        "keywords": [k["name"] for k in kw], "keyword_ids": [k["id"] for k in kw],
        "cast": Jsonb([{"id": c["id"], "name": c["name"]} for c in cast]),
        "creators": Jsonb(creators),
        "vote_count": d.get("vote_count"),
        "popularity": round(d["popularity"], 3) if d.get("popularity") is not None else None,
        "release_date": d.get("release_date") or d.get("first_air_date") or None,
        "status": d.get("status"),
        "runtime_min": runtime,
        "seasons": d.get("number_of_seasons"),
        "episode_count": d.get("number_of_episodes"),
        "origin_country": d.get("origin_country") or [c["iso_3166_1"] for c in d.get("production_countries") or []],
        "collection": Jsonb({"id": coll["id"], "name": coll["name"]}) if coll else None,
        "certification": Jsonb(certification) if certification else None,
    }


def episode_rows(imdb_id, tmdb_id):
    """A show's episodes in Cinemeta's numbering, with TMDB's details where the numbers match."""
    videos = [v for v in cinemeta("series", imdb_id).get("videos") or [] if v.get("id") and v.get("season") is not None]
    seasons = sorted({v["season"] for v in videos})
    tmdb_eps = {}
    if tmdb_id:
        with ThreadPoolExecutor(max_workers=4) as pool:
            for s in pool.map(lambda n: tmdb(f"/tv/{tmdb_id}/season/{n}") or {}, seasons):
                for e in s.get("episodes") or []:
                    tmdb_eps[(e.get("season_number"), e.get("episode_number"))] = e
    rows = []
    for v in videos:
        n = v.get("episode") or v.get("number")
        t = tmdb_eps.get((v["season"], n), {})
        released = t.get("air_date") or (v.get("released") or v.get("firstAired") or "")[:10] or None
        rows.append({
            "video_id": v["id"], "imdb_id": imdb_id, "season": v["season"], "episode": n,
            "name": t.get("name") or v.get("name") or v.get("title"),
            "overview": t.get("overview") or v.get("overview") or v.get("description") or None,
            "still": f"{TMDB_IMG}/w300{t['still_path']}" if t.get("still_path") else None,
            "released": released,
            "rating": round(t["vote_average"], 1) if t.get("vote_average") else None,
        })
    return rows


_filling = threading.Lock()


def fill_titles(items, rechecks=False):
    """Adds titles (and a show's episodes) to the shared cache; [items] is [(imdb_id, type)]. One that
    TMDB doesn't know is kept without details (looked up again only as a saved one is, below). With
    [rechecks], looks again at saved ones (claimed: see store.claim_rechecks), with TMDB's match asked
    afresh: what TMDB doesn't answer (it fails, or no longer knows the title) stays as it was, and the
    first failure ends the round (TMDB may be down)."""
    for imdb_id, ctype in items:
        try:
            if rechecks:
                tmdb_id = fresh_match(imdb_id, ctype)
                t = title_row(imdb_id, ctype, tmdb_id) if tmdb_id else None
                if not t:
                    continue
            else:
                t = title_row(imdb_id, ctype)
            eps = episode_rows(imdb_id, t and t["tmdb_id"]) if ctype == "series" else []
        except Exception:
            log.exception("Couldn't look up %s", imdb_id)
            if rechecks:
                return
            continue
        before = (store.title(imdb_id) or {}).get("tmdb_id") if rechecks else None
        if rechecks and ctype == "series" and not eps and before is not None and before != t["tmdb_id"]:
            continue  # (Another TMDB title now, but without its episodes: not half of each.)
        try:
            store.save_title(t or store.blank_title(imdb_id, ctype), eps)
        except Exception:
            if not rechecks:
                raise
            log.exception("Couldn't save %s", imdb_id)
            continue
        if rechecks and before != t["tmdb_id"]:
            cache.drop(f"found:{imdb_id}")  # (Everything else now takes TMDB's new match too.)
        log.info("Saved %s (%s) in the titles", imdb_id, (t or {}).get("name"))


_rechecking = threading.Lock()


def recheck_titles():
    """Looks again at a few saved titles watched since their details were saved a week or more ago
    (TMDB's get fixed and added to); none if it's already being done."""
    if not _rechecking.acquire(blocking=False):
        return
    try:
        fill_titles(store.claim_rechecks(C.title_recheck_days, C.title_rechecks_at_once), rechecks=True)
    except Exception:
        log.exception("Couldn't look again at saved titles")
    finally:
        _rechecking.release()


def fill_missing_titles():
    """Every watched title has a name and poster: fills the ones that are missing (Home waits for
    those), then looks again at a few saved ones in the background. Returns how many were missing."""
    with _filling:
        missing = store.missing_titles()
        fill_titles(missing)
    threading.Thread(target=recheck_titles, name="title-recheck", daemon=True).start()
    return len(missing)


def genre_lists():
    """{kind: {id: name}} for movie and tv."""
    return cached("genres", lambda: {
        kind: {g["id"]: g["name"] for g in (tmdb(f"/genre/{kind}/list") or {}).get("genres", [])}
        for kind in ("movie", "tv")}, ttl=C.genre_lists_days * 86400)  # (not kept: its keys are numbers, JSON would make them text)


def genre_names():
    return {**genre_lists()["movie"], **genre_lists()["tv"]}


def imdb_id_for(kind, tmdb_id):
    return cached(f"imdb:{kind}:{tmdb_id}", lambda: (tmdb(f"/{kind}/{tmdb_id}/external_ids") or {}).get("imdb_id"),
                  ttl=C.imdb_ids_days * 86400, none_ttl=C.no_match_hours * 3600)


def title_extras(imdb_id, ctype):
    """Backdrop, trailer and basic details for one title, from TMDB (kept a day)."""
    return cached(f"extras:{imdb_id}", lambda: _title_extras(imdb_id, ctype), ttl=C.title_details_hours * 3600)


def _title_extras(imdb_id, ctype):
    kind = "movie" if ctype == "movie" else "tv"
    tmdb_id = tmdb_find(imdb_id, ctype)
    if not tmdb_id:
        # (No picture: Cinemeta's address for one answers 404 for titles TMDB doesn't know.)
        return {}
    original = original_language(imdb_id, ctype)
    # The trailers in its own language, English and none, for every profile; a profile that wants
    # another language asks for that one too (trailer_for). (TMDB takes at most 5 languages at once.)
    d = tmdb(f"/{kind}/{tmdb_id}", append_to_response="videos",
             include_video_language=",".join(dict.fromkeys([original, "en", "null"]))) or {}
    videos = youtube_videos(d.get("videos"))
    return {
        "name": d.get("title") or d.get("name"),
        "year": (d.get("release_date") or d.get("first_air_date") or "")[:4],
        "rating": round(d.get("vote_average") or 0, 1),
        "overview": d.get("overview") or "",
        "poster": f"{TMDB_IMG}/w342{d['poster_path']}" if d.get("poster_path") else None,
        # (TMDB's or none: Cinemeta's address answers 404 when TMDB has no picture for a title.)
        "backdrop": f"{TMDB_IMG}/w1280{d['backdrop_path']}" if d.get("backdrop_path") else None,
        # For anyone (this is shared by every profile): see trailer_for for a profile's own.
        "trailer": pick_trailer(videos, None, original),
        "videos": videos,
        "genres": [g["id"] for g in d.get("genres") or []],
        "language": d.get("original_language"),
        "released": d.get("release_date") or d.get("first_air_date") or None,
        "status": d.get("status"),
    }


def not_out(release_date, status, today=None):
    """Whether a film isn't out yet: its release date is still to come, or it has none and TMDB doesn't
    say it's released (announced, in production)."""
    today = today or time.strftime("%Y-%m-%d")
    return release_date > today if release_date else status not in (None, "Released")


def film_releases(imdb_id):
    """When a film that isn't out yet comes out ("2026-11-04"; "" when not known), or None once it's out."""
    try:
        x = title_extras(imdb_id, "movie")
    except Exception:
        # (TMDB not answering mustn't stop a play: its sources are still looked for.)
        log.warning("Couldn't look up whether %s is out", imdb_id)
        return None
    # (A kept entry without a status: it's played, until it's looked up again within a day.)
    if "status" not in x:
        return None
    return (x.get("released") or "") if not_out(x.get("released"), x.get("status")) else None


def youtube_videos(found):
    """A TMDB videos answer's YouTube videos: what picking a trailer needs."""
    return [{"key": v["key"], "type": v.get("type"), "official": bool(v.get("official")), "lang": v.get("iso_639_1")}
            for v in (found or {}).get("results") or [] if v.get("site") == "YouTube" and v.get("key")]


def pick_trailer(videos, wanted, original):
    """The trailer to show: in the [wanted] language (a profile's audio language), else the title's
    [original] one, else English, else one in no language. Trailers and teasers in any of those go
    before other videos (clips, featurettes); within a language: official trailers, any
    trailer, then teasers."""
    order = list(dict.fromkeys(([wanted] if wanted else []) + ([original] if original else []) + ["en", None]))
    def rank(v):
        lang = v.get("lang")
        return (v.get("type") not in ("Trailer", "Teaser"),
                order.index(lang) if lang in order else len(order),
                v.get("type") != "Trailer", not v.get("official"), v.get("type") != "Teaser")
    best = min(videos, key=rank, default=None)
    return best["key"] if best else None


# A profile's audio language, read once a minute at most (a page asks for it once per card).
_wanted = {}
WANTED_S = 60


def wanted_language():
    """The current profile's audio language as a code ("hi"), or None (English, or no profile)."""
    try:
        profile = me()
    except NoProfile:
        return None
    hit = _wanted.get(profile)
    if hit and time.time() - hit[0] < WANTED_S:
        return hit[1]
    from .playback import LANGUAGE_FOR_AUDIO
    code = LANGUAGE_FOR_AUDIO.get(store.profile_settings(profile).get("audio_language") or "English")
    _wanted[profile] = (time.time(), code)
    return code


def forget_wanted(profile_id):
    _wanted.pop(profile_id, None)


def trailer_for(imdb_id, ctype, extras):
    """[extras]' trailer for the current profile: in its audio language when TMDB has one."""
    videos = extras.get("videos")
    # (A kept entry without the list: its one trailer, until it's looked up again within a day.)
    if videos is None:
        return extras.get("trailer")
    original = extras.get("language")
    wanted = wanted_language()
    if wanted and wanted not in (original, "en"):
        videos = videos + other_language_videos(imdb_id, ctype, wanted)
    return pick_trailer(videos, wanted, original)


def other_language_videos(imdb_id, ctype, lang):
    """A title's YouTube videos in [lang] alone (shared by every profile that wants it; kept a week)."""
    def load():
        tmdb_id = tmdb_find(imdb_id, ctype)
        if not tmdb_id:
            return []
        return youtube_videos(tmdb(f"/{'movie' if ctype == 'movie' else 'tv'}/{tmdb_id}/videos", include_video_language=lang))
    try:
        return cached(f"extras:videos:{lang}:{imdb_id}", load, ttl=C.trailers_days * 86400)
    except Exception:
        log.warning("Couldn't look up the %s videos of %s", lang, imdb_id)
        return []


def feed_item(imdb_id, ctype, **fields):
    x = title_extras(imdb_id, ctype)
    item = {"id": imdb_id, "type": ctype, "name": x.get("name"), "year": x.get("year"),
            "rating": x.get("rating"), "poster": x.get("poster"), "backdrop": x.get("backdrop"),
            "trailer": trailer_for(imdb_id, ctype, x), "overview": x.get("overview", "")[:280]}
    item.update({k: v for k, v in fields.items() if v not in (None, "")})
    return {k: v for k, v in item.items() if v not in (None, "")}
