"""Title, More like this, and person pages."""

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from . import cache, store
from .config import S
from .cache import cached
from .ai import ask_ai, save_picks
from .context import me, scoped
from .http import cinemeta, tmdb
from .recommend import PICKS, candidate_line, merge_candidates, recs, related, same_kind
from .titles import TMDB_IMG, genre_names, imdb_id_for, not_out, title_extras, tmdb_find, trailer_for
from .watching import library_state

log = logging.getLogger(__name__)


def nice_date(iso):
    """2026-12-25 -> 25 Dec 2026."""
    try:
        return time.strftime("%d %b %Y", time.strptime(iso[:10], "%Y-%m-%d")).lstrip("0")
    except ValueError:
        return iso


def title_page(ctype, imdb_id):
    """Header, one row per season (episodes) or a Watch card (movies), and the cast."""
    kind = "movie" if ctype == "movie" else "tv"
    tmdb_id = tmdb_find(imdb_id, ctype)
    d = (tmdb(f"/{kind}/{tmdb_id}", append_to_response="credits,aggregate_credits,videos") or {}) if tmdb_id else {}
    meta = cinemeta(ctype, imdb_id)
    x = title_extras(imdb_id, ctype)
    genres = [g["name"] for g in d.get("genres", [])][:2]
    if ctype == "series":
        n_seasons = d.get("number_of_seasons")
        span = meta.get("releaseInfo") or x.get("year") or ""
        facts = [span, f"{n_seasons} season{'s' if n_seasons != 1 else ''}" if n_seasons else None, *genres]
    else:
        runtime = d.get("runtime")
        facts = [x.get("year"), f"{runtime // 60}h {runtime % 60}m" if runtime else None, *genres]
    header = {
        "id": imdb_id, "type": ctype, "name": x.get("name") or meta.get("name") or imdb_id,
        "facts": " · ".join(f for f in facts if f), "rating": x.get("rating"),
        "overview": d.get("overview") or meta.get("description") or "",
        "backdrop": x.get("backdrop"), "trailer": trailer_for(imdb_id, ctype, x), "logo": meta.get("logo"),
    }

    sections, focus = [], None
    today = time.strftime("%Y-%m-%d")
    item = None
    try:
        item = store.entry(me(), imdb_id)
    except Exception:
        log.exception("Couldn't read watch state for %s", imdb_id)
    state = library_state(imdb_id, item)
    header["myRating"] = store.rating(me(), imdb_id)
    header["inList"] = store.in_my_list(me(), imdb_id)
    if ctype == "series":
        watched = store.ticks(me(), imdb_id)
        header["notify"] = item["notify"] if item else True
    else:
        header["watched"] = bool(item and (item["watched"] or item["times_watched"]))
    if ctype == "series":
        seasons = {}
        for v in meta.get("videos") or []:
            seasons.setdefault(v.get("season") or 0, []).append(v)
        # Cinemeta's air dates are unreliable for some shows; TMDB's season lists are not.
        aired = {}
        if tmdb_id:
            with ThreadPoolExecutor(max_workers=6) as ex:
                for sdata in ex.map(lambda n: tmdb(f"/tv/{tmdb_id}/season/{n}") or {}, seasons):
                    for e in sdata.get("episodes", []):
                        aired[(e.get("season_number"), e.get("episode_number"))] = e
        # Real seasons in order, specials last.
        for season in sorted(seasons, key=lambda n: (n == 0, n)):
            eps = sorted(seasons[season], key=lambda v: v.get("episode") or v.get("number") or 0)
            items = []
            for v in eps:
                n = v.get("episode") or v.get("number")
                t = aired.get((season, n), {})
                still = f"{TMDB_IMG}/w300{t['still_path']}" if t.get("still_path") else None
                date = t.get("air_date") or (v.get("released") or v.get("firstAired") or "")[:10]
                name = next((x for x in (v.get("name"), v.get("title"), t.get("name"))
                             if x and x.strip().upper() not in ("TBA", "TBD")), f"Episode {n}")
                rating = v.get("rating") if str(v.get("rating") or "0") not in ("0", "0.0") else None
                items.append({k: val for k, val in {
                    "id": v.get("id"), "name": name, "episode": f"S{season} E{n}",
                    "overview": (v.get("overview") or v.get("description") or t.get("overview") or "")[:400],
                    "thumbnail": v.get("thumbnail") or still, "aired": date, "rating": rating,
                    # Not out yet: the TV shows when it arrives instead of opening Stremio.
                    "upcoming": True if not date or date > today else None,
                    "watched": True if v.get("id") in watched else None,
                    # The episode you're partway through: how far, for the line under its still.
                    "progress": round(state["timeOffset"] / state["duration"], 3)
                    if v.get("id") == state.get("video_id") and state.get("timeOffset") and state.get("duration") else None,
                }.items() if val})
            sid = f"s{season}"
            sections.append({"id": sid, "title": "Specials" if season == 0 else f"Season {season}",
                             "kind": "episodes", "items": items})
            if state.get("video_id"):
                idx = next((i for i, it in enumerate(items) if it.get("id") == state["video_id"]), None)
                if idx is not None:
                    focus = {"section": sid, "index": idx}
    elif d and not_out(d.get("release_date"), d.get("status"), today):
        # Not out yet: the card says when it comes out, and doesn't play (as an episode not aired).
        sections.append({"id": "watch", "title": "Watch", "kind": "episodes", "items": [{k: v for k, v in {
            "id": imdb_id, "name": "Not out yet", "aired": d.get("release_date"), "upcoming": True,
            "overview": header["overview"][:400], "thumbnail": header["backdrop"],
        }.items() if v}]})
    else:
        dur, off = state.get("duration") or 0, state.get("timeOffset") or 0
        sections.append({"id": "watch", "title": "Watch", "kind": "episodes", "items": [{
            "id": imdb_id, "name": "Resume" if off else ("Watch again" if header["watched"] else "Watch now"),
            "episode": f"{round(off / dur * 100)}% watched" if dur and off else header["facts"],
            "watched": True if header["watched"] and not off else None,
            "progress": round(off / dur, 3) if dur and off else None,
            "overview": header["overview"][:400], "thumbnail": header["backdrop"],
        }]})

    credits = (d.get("aggregate_credits") if kind == "tv" else None) or d.get("credits") or {}
    cast = []
    if ctype == "series":
        first = d.get("first_air_date") or ""
        if first > today:
            header["facts"] = " · ".join(f for f in [f"Premieres {nice_date(first)}", *genres] if f)
    elif (d.get("release_date") or "") > today:
        header["facts"] = " · ".join(f for f in [f"Releases {nice_date(d['release_date'])}", *genres] if f)
    if str(header.get("rating") or 0) in ("0", "0.0"):
        header["rating"] = None

    for c in (credits.get("cast") or [])[:20]:
        role = c.get("character") or ((c.get("roles") or [{}])[0].get("character"))
        cast.append({k: v for k, v in {
            "id": str(c["id"]), "name": c.get("name"), "character": role,
            "photo": f"{TMDB_IMG}/w185{c['profile_path']}" if c.get("profile_path") else None,
        }.items() if v})
    if cast:
        sections.append({"id": "cast", "title": "Cast", "kind": "cast", "items": cast})
    return {"header": header, "sections": sections, "focus": focus}


SIMILAR_SCHEMA = {
    "type": "object",
    "properties": {"picks": PICKS},
    "required": ["picks"],
    "additionalProperties": False,
}

SIMILAR_SYSTEM = """You pick titles similar to one movie or series for a specific viewer.

You get the title, the viewer's taste summary, and a pool of candidates (m<id> is a movie, t<id> a series). Choose up to 15 from the pool that someone who liked the title would enjoy next, best first. Stay close to the title's own genre, tone and format; use the viewer's taste only to order those, never to pull in something from a different genre. Use exact keys. Use at most one entry per franchise. Each reason is one short line (under 80 characters) saying what it shares with the title.

The title's original language and genres come with it. Most picks (about 11 of 15) are in that language when the pool has enough that fit; the rest are the closest matches in other languages."""

SIMILAR_TTL = S.advanced.cache.similar_ai_days * 86400
similar_running = set()
similar_lock = threading.Lock()


def similar_pool(ctype, imdb_id):
    kind = "movie" if ctype == "movie" else "tv"
    tmdb_id = tmdb_find(imdb_id, ctype)
    if not tmdb_id:
        return {}, {}
    x = title_extras(imdb_id, ctype)
    pool = merge_candidates(related(tmdb_id, kind, "") + same_kind(kind, x), skip={f"{kind[0]}{tmdb_id}"})
    # The title's own language first: the order shown before (or without) the AI.
    if x.get("language") and x["language"] != "en":
        pool = dict(sorted(pool.items(), key=lambda kv: kv[1]["lang"] != x["language"]))
    return pool, x


def similar_items(picks, pool, limit=15):
    keys = [p["key"] for p in picks if p["key"] in pool][:limit]
    with ThreadPoolExecutor(max_workers=8) as ex:
        ids = list(ex.map(lambda k: imdb_id_for(pool[k]["kind"], pool[k]["tmdb_id"]), keys))
    reasons = {p["key"]: p.get("reason") for p in picks}
    out = []
    for k, tt in zip(keys, ids):
        c = pool[k]
        if tt:
            out.append({k2: v for k2, v in {
                "id": tt, "type": "movie" if c["kind"] == "movie" else "series", "name": c["title"],
                "year": c["year"], "rating": c["rating"], "poster": c["poster"].replace("/w500/", "/w342/"),
                "reason": reasons.get(k), "overview": c["overview"],
            }.items() if v not in (None, "")})
    return out


def rank_similar(ctype, imdb_id):
    """The AI's picks for More like this, worked out now (the TV asks for them once it has shown
    TMDB's list) and kept. Two at once for the same title: the second gets TMDB's list."""
    key = scoped(f"similar:{imdb_id}")
    hit = cache.get(key, SIMILAR_TTL)
    if hit:
        return hit[1]
    with similar_lock:
        if key in similar_running:
            return similar_page(ctype, imdb_id)
        similar_running.add(key)
    try:
        started = time.time()
        pool, x = similar_pool(ctype, imdb_id)
        if not pool:
            return {"ai": False, "items": []}
        taste = (recs() or {}).get("taste_summary", "unknown")
        genres = genre_names()
        kinds = ", ".join(genres.get(g, "") for g in (x.get("genres") or [])[:3])
        prompt = (f"TITLE: {x.get('name')} ({x.get('year')}) | {kinds} | lang {x.get('language') or '?'}\n"
                  f"{x.get('overview', '')[:300]}\n\n"
                  f"VIEWER TASTE: {taste}\n\n"
                  "CANDIDATE POOL:\n" + "\n".join(candidate_line(c, genres) for c in pool.values()))
        picks = ask_ai(SIMILAR_SYSTEM, prompt, SIMILAR_SCHEMA, effort="low", max_tokens=S.ai.max_tokens.similar,
                       purpose="similar")["picks"]
        # (The title as the AI's keys are: m123 a film, t456 a series.)
        tmdb_id = tmdb_find(imdb_id, ctype)
        seed = f"{'m' if ctype == 'movie' else 't'}{tmdb_id}" if tmdb_id else None
        request_id = save_picks("similar", list(pool), [p["key"] for p in picks], seed=seed)
        page = {"ai": True, "items": similar_items(picks, pool), **({"requestId": request_id} if request_id else {})}
        cache.put(key, page, started)
        return page
    finally:
        with similar_lock:
            similar_running.discard(key)


def similar_page(ctype, imdb_id):
    """The AI's picks if they've been worked out (see rank_similar); otherwise TMDB's own list."""
    hit = cache.get(scoped(f"similar:{imdb_id}"), SIMILAR_TTL)
    if hit:
        return hit[1]
    pool, _ = cached(f"similarpool:{imdb_id}", lambda: similar_pool(ctype, imdb_id),
                     ttl=S.advanced.cache.similar_pool_hours * 3600)
    return {"ai": False, "items": similar_items([{"key": k} for k in pool], pool)}


def person_page(person_id):
    d = tmdb(f"/person/{person_id}", append_to_response="combined_credits") or {}
    credits = [c for c in (d.get("combined_credits") or {}).get("cast", [])
               if c.get("media_type") in ("movie", "tv") and c.get("poster_path")]
    # Best known first: popular titles where they had a leading part (top-billed film role,
    # or a show they were in for a while) beat blockbusters where they had a cameo.
    def weight(c):
        lead = c.get("episode_count", 0) >= 10 if c["media_type"] == "tv" else (c.get("order") if c.get("order") is not None else 99) <= 4
        return (c.get("vote_count") or 0) * (1.0 if lead else 0.2)
    credits.sort(key=weight, reverse=True)
    seen, picked = set(), []
    for c in credits:
        if c["id"] not in seen and (c.get("episode_count") or 99) >= 3:
            seen.add(c["id"])
            picked.append(c)
        if len(picked) >= 24:
            break
    with ThreadPoolExecutor(max_workers=8) as ex:
        ids = list(ex.map(lambda c: imdb_id_for(c["media_type"], c["id"]), picked))
    items = [{k: v for k, v in {
        "id": tt, "type": "movie" if c["media_type"] == "movie" else "series",
        "name": c.get("title") or c.get("name"),
        "year": (c.get("release_date") or c.get("first_air_date") or "")[:4],
        "rating": round(c.get("vote_average") or 0, 1),
        "poster": f"{TMDB_IMG}/w342{c['poster_path']}", "reason": f"as {c['character']}" if c.get("character") else None,
    }.items() if v not in (None, "")} for c, tt in zip(picked, ids) if tt]
    born = d.get("birthday", "")[:4]
    facts = [d.get("known_for_department"), f"born {born}" if born else None, d.get("place_of_birth")]
    return {
        "header": {"id": str(person_id), "type": "person", "name": d.get("name", ""),
                   "facts": " · ".join(f for f in facts if f), "overview": (d.get("biography") or "")[:600],
                   "backdrop": f"{TMDB_IMG}/h632{d['profile_path']}" if d.get("profile_path") else None},
        "sections": [{"id": "known", "title": "Known for", "kind": "posters", "items": items}],
        "focus": None,
    }
