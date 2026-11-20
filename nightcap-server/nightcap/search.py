"""Search: as-you-type from TMDB, and the smart search the AI answers."""

import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from difflib import SequenceMatcher
from itertools import zip_longest
from urllib.parse import quote
from datetime import datetime
from zoneinfo import ZoneInfo

from . import accounts, cache, store
from .config import S
from .cache import cached
from .context import scoped
from .ai import AIUnavailable, ask_ai, save_picks
from .http import get_json, tmdb
from .recommend import PICKS, candidate_line, merge_candidates, to_metas
from .titles import TMDB_IMG, genre_lists, genre_names, imdb_id_for, title_extras

log = logging.getLogger(__name__)


TITLE = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "year": {"type": "string"},
        "type": {"type": "string", "enum": ["movie", "series"]},
        "reason": {"type": "string"},
    },
    "required": ["title", "year", "type", "reason"],
    "additionalProperties": False,
}
SEARCH_SCHEMA = {
    "type": "object",
    "properties": {
        "plain_title": {"type": "boolean"},
        "titles": {"type": "array", "items": TITLE},
        "filters": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": ["movie", "series", "any"]},
                "people": {"type": "array", "items": {"type": "string"}},
                "language": {"type": "string"},
                "genres": {"type": "array", "items": {"type": "string"}},
                "year_from": {"type": "integer"},
                "year_to": {"type": "integer"},
                "sort": {"type": "string", "enum": ["popular", "rating", "newest"]},
            },
            "required": ["type", "people", "language", "genres", "year_from", "year_to", "sort"],
            "additionalProperties": False,
        },
    },
    "required": ["plain_title", "titles", "filters"],
    "additionalProperties": False,
}

SEARCH_SYSTEM = """You turn a TV viewer's search into movie and series results. Today is {today}.

The query may be a plain title ("inception"), or a description ("hindi movies where Salman Khan plays the villain", "slow-burn korean thrillers", "anime like Death Note").

plain_title: true when the query is just the name of a title (possibly misspelt).

titles: up to 25 specific titles that answer the query, best match first, each with release year, type and a one-line reason (under 80 characters) saying how it fits. For a plain title query, return that title first, then close matches. Include close fits too (for "plays the villain", grey or anti-hero roles count) - every title gets checked against a catalogue afterwards. Never invent titles.

filters: a catalogue search that would also turn up answers - people (actors or directors, full names), language (ISO 639-1 code like "hi", or "" for any), genres (plain names like "Thriller"; leave empty unless the query names a genre), year range (0 when open), type and sort. These catch recent releases you may not know about."""

PICKS_SCHEMA = {
    "type": "object",
    "properties": {"picks": PICKS},
    "required": ["picks"],
    "additionalProperties": False,
}

PICK_SYSTEM = """You answer a TV viewer's search from a pool of candidate titles. Today is {today}.

Candidates have a key (m<id> movie, t<id> series), title, year, genres, language, rating, notes (a suggested reason, or the role a searched person plays) and a plot snippet. Choose the ones that genuinely answer the search, best match first, up to 30, using exact keys. Use what you know about these titles together with the plot and role notes; drop cameos, guest spots and titles that don't fit. When the search asks for new or recent titles, put the latest releases (this year and last) first. Each reason is one short line (under 80 characters) saying how it fits the search, e.g. "Salman plays the ruthless antagonist Raghu"."""


def tmdb_search_title(t):
    kind = "movie" if t["type"] == "movie" else "tv"
    year_param = "primary_release_year" if kind == "movie" else "first_air_date_year"
    params = {"query": t["title"]}
    if t["year"].isdigit():
        params[year_param] = t["year"]
    results = (tmdb(f"/search/{kind}", **params) or {}).get("results") or []
    if not results and year_param in params:
        results = (tmdb(f"/search/{kind}", query=t["title"]) or {}).get("results") or []
    return (results[0], kind) if results else (None, kind)


def genre_ids(kind, names):
    table = genre_lists()[kind]
    ids = []
    for name in names:
        n = name.lower()
        ids += [gid for gid, g in table.items() if n in g.lower() or g.lower() in n]
    return ids


def filter_results(f):
    """Run the AI's filters against TMDB."""
    kinds = {"movie": ["movie"], "series": ["tv"]}.get(f["type"], ["movie", "tv"])
    sort_key = {"popular": "popularity", "rating": "vote_average", "newest": "date"}[f["sort"]]
    out = []
    if f["people"]:
        for name in f["people"][:2]:
            people = (tmdb("/search/person", query=name) or {}).get("results") or []
            if not people:
                continue
            credits = tmdb(f"/person/{people[0]['id']}/combined_credits") or {}
            for r in credits.get("cast", []) + credits.get("crew", []):
                kind = r.get("media_type")
                if kind not in kinds:
                    continue
                if f["language"] and r.get("original_language") != f["language"]:
                    continue
                wanted = genre_ids(kind, f["genres"])
                if wanted and not set(wanted) & set(r.get("genre_ids") or []):
                    continue
                year = int((r.get("release_date") or r.get("first_air_date") or "0")[:4] or 0)
                if (f["year_from"] and year < f["year_from"]) or (f["year_to"] and year > f["year_to"]):
                    continue
                role = r.get("character") or r.get("job")
                out.append((r, kind, f"{name} as {role}" if role else name))
        date = lambda r: r.get("release_date") or r.get("first_air_date") or ""
        key = {"popularity": lambda r: r.get("popularity") or 0, "vote_average": lambda r: r.get("vote_average") or 0,
               "date": date}[sort_key]
        out.sort(key=lambda x: key(x[0]), reverse=True)
        return out
    for kind in kinds:
        params = {"vote_count.gte": S.advanced.search.filter_min_votes}
        if f["language"]:
            params["with_original_language"] = f["language"]
        if f["genres"]:
            params["with_genres"] = "|".join(map(str, genre_ids(kind, f["genres"])))
        date_field = "primary_release_date" if kind == "movie" else "first_air_date"
        if f["year_from"]:
            params[f"{date_field}.gte"] = f"{f['year_from']}-01-01"
        if f["year_to"]:
            params[f"{date_field}.lte"] = f"{f['year_to']}-12-31"
        params["sort_by"] = f"{date_field if sort_key == 'date' else sort_key}.desc"
        if sort_key == "date":
            params["vote_count.gte"] = 0
            params[f"{date_field}.lte"] = params.get(f"{date_field}.lte", today())
        out += [(r, kind, "") for r in (tmdb(f"/discover/{kind}", **params) or {}).get("results", [])]
    return out


def today():
    """Today's date where the household is, for the prompts."""
    return datetime.now(ZoneInfo(accounts.timezone())).strftime("%Y-%m-%d")


def ai_search(query):
    """{"metas": the results, "requestId": the AI's picks as saved in ai_picks (None when it named
    the titles itself, or they couldn't be saved)}."""
    plan = ask_ai(SEARCH_SYSTEM.format(today=today()), query, SEARCH_SCHEMA, effort="low", max_tokens=S.ai.max_tokens.search_plan,
                      purpose="search")
    log.info("Search %r: %d titles, filters=%s", query, len(plan["titles"]), plan["filters"])
    with ThreadPoolExecutor(max_workers=8) as pool:
        found = list(pool.map(tmdb_search_title, plan["titles"]))
    raw = [(item, kind, t["reason"]) for t, (item, kind) in zip(plan["titles"], found) if item]
    if plan["plain_title"]:
        pool = merge_candidates(raw)
        return {"metas": to_metas([{"key": k, "reason": c["via"][0]} for k, c in pool.items()], pool,
                                  limit=S.advanced.search.ai_results), "requestId": None}
    raw += filter_results(plan["filters"])[:80]
    pool = merge_candidates(raw)
    genres = genre_names()
    prompt = f"SEARCH: {query}\n\nCANDIDATE POOL:\n" + "\n".join(candidate_line(c, genres) for c in pool.values())
    picks = ask_ai(PICK_SYSTEM.format(today=today()), prompt, PICKS_SCHEMA, effort="low", max_tokens=S.ai.max_tokens.search_picks,
                       purpose="search")["picks"]
    request_id = save_picks("search", list(pool), [p["key"] for p in picks], query=query)
    return {"metas": to_metas(picks, pool, limit=S.advanced.search.ai_results), "requestId": request_id}



# As-you-type search forgives spelling: TMDB's search matches spellings close to a title's, so it's
# asked alongside Cinemeta's (Stremio's own catalogue), which finds "Lock Upp" for "lock up" and
# "Breaking Bad" for "braking bad"; and every title the server knows (any household's, and this
# profile's Home) is matched by likeness, so "big boss" finds Bigg Boss (both services answer with
# films called Big Boss).
QUICK_TITLES = S.advanced.search.quick_titles
CINEMETA_SEARCH = "https://v3-cinemeta.strem.io/catalog/{kind}/top/search={q}.json"
# How alike a household title's name and what was typed must be (0 to 1), and the shortest search
# matched that way (two letters are like too much).
LIKE_ENOUGH = S.advanced.search.like_enough
LIKE_FROM = S.advanced.search.like_from
# At most this many known titles go first ("the" is the start of a great many), after exact matches.
KNOWN_FIRST = S.advanced.search.known_first


def quick_search(q):
    """As-you-type results: titles (with IMDb ids for Stremio) and people. TMDB's and Cinemeta's
    titles, taken in turn (each in its own order, best first), without repeats. The same for everyone
    (kept as "quick:"): the titles the server knows are added after (known_matches)."""
    with ThreadPoolExecutor(max_workers=4) as ex:
        found = ex.submit(lambda: (tmdb("/search/multi", query=q, include_adult="false") or {}).get("results", []))
        stremio = [ex.submit(cinemeta_search, kind, q) for kind in ("series", "movie")]
        results = found.result()
        from_cinemeta = [m for f in stremio for m in f.result()]
    titles = [r for r in results if r.get("media_type") in ("movie", "tv") and r.get("poster_path")][:QUICK_TITLES]
    people = [r for r in results if r.get("media_type") == "person" and r.get("profile_path")][:8]
    with ThreadPoolExecutor(max_workers=8) as ex:
        ids = list(ex.map(lambda r: imdb_id_for(r["media_type"], r["id"]), titles))
    title_cards = [{k: v for k, v in {
        "id": tt, "type": "movie" if r["media_type"] == "movie" else "series",
        "name": r.get("title") or r.get("name"),
        "year": (r.get("release_date") or r.get("first_air_date") or "")[:4],
        "rating": round(r.get("vote_average") or 0, 1) or None,
        "poster": f"{TMDB_IMG}/w342{r['poster_path']}", "overview": (r.get("overview") or "")[:300],
        "backdrop": f"{TMDB_IMG}/w1280{r['backdrop_path']}" if r.get("backdrop_path") else None,
    }.items() if v not in (None, "")} for r, tt in zip(titles, ids) if tt]
    # Cinemeta's, best first: series and films in turn, as its two lists come.
    series, films = ([m for m in from_cinemeta if m["type"] == kind] for kind in ("series", "movie"))
    stremio_order = in_turn(series, films)
    have = {c["id"] for c in title_cards}
    # (Half the answer at most: each is looked up on TMDB for its details.)
    extra = [m for m in dict((m["id"], m) for m in stremio_order).values() if m["id"] not in have][:QUICK_TITLES // 2]
    with ThreadPoolExecutor(max_workers=8) as ex:
        extra_cards = [c for c in ex.map(cinemeta_card, extra) if c]
    people_cards = [{
        "id": str(r["id"]), "name": r.get("name"),
        "character": ", ".join((k.get("title") or k.get("name") or "") for k in (r.get("known_for") or [])[:2]),
        "photo": f"{TMDB_IMG}/w185{r['profile_path']}",
    } for r in people]
    return {"titles": in_turn(title_cards, extra_cards)[:QUICK_TITLES], "people": people_cards}


def in_turn(first, second):
    """[first]'s and [second]'s items one each in turn, [first] leading."""
    return [x for pair in zip_longest(first, second) for x in pair if x is not None]


def cinemeta_search(kind, q):
    """Cinemeta's search for [kind] ("series" or "movie"): its titles, best first; none if it fails."""
    try:
        metas = (get_json(CINEMETA_SEARCH.format(kind=kind, q=quote(q)), retries=0,
                          timeout=S.advanced.timeouts.cinemeta_search_seconds) or {}).get("metas") or []
    except Exception as e:
        log.warning("Cinemeta search unavailable: %s", type(e).__name__)
        return []
    return [{"id": m["id"], "type": kind, "name": m.get("name"), "year": (m.get("releaseInfo") or "")[:4],
             "poster": m.get("poster")} for m in metas if str(m.get("id", "")).startswith("tt") and m.get("name")]


def cinemeta_card(m):
    """A Cinemeta result as a search card, its details from TMDB (kept a day, shared) when it has them."""
    try:
        x = title_extras(m["id"], m["type"])
    except Exception:
        x = {}
    return {k: v for k, v in {
        "id": m["id"], "type": m["type"], "name": x.get("name") or m["name"], "year": x.get("year") or m["year"],
        # (TMDB's poster or none: Cinemeta's own address answers 404 for titles TMDB doesn't know.)
        "rating": x.get("rating") or None, "poster": x.get("poster"),
        "overview": (x.get("overview") or "")[:300], "backdrop": x.get("backdrop"),
    }.items() if v not in (None, "")}


def plain(text):
    """Lower case, an apostrophe dropped ("India's" is "indias"), anything else not a letter or number a space."""
    text = re.sub(r"['’`´]", "", (text or "").lower()).replace("&", " and ")
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


def likeness(q, name):
    """How alike what was typed and a title's name are, 0 to 1: as a whole, or as the start of the
    name (it's typed as you go: "bigg b" is the start of Bigg Boss)."""
    return likeness_plain(plain(q), plain(name))


def likeness_plain(a, b):
    if not a or not b:
        return 0.0
    whole = SequenceMatcher(None, a, b).ratio()
    start = SequenceMatcher(None, a, b[:len(a)]).ratio() if len(b) > len(a) else 0.0
    return max(whole, start)


# Every title the server knows, a few minutes at a time: the names to match a search with.
_known = [0.0, {}]
_known_lock = threading.Lock()
KNOWN_S = S.advanced.search.known_titles_minutes * 60


def known_titles():
    """The shared titles table's titles (any household's: whose isn't said), and this profile's Home."""
    with _known_lock:
        if time.time() - _known[0] > KNOWN_S:
            _known[:] = [time.time(), by_first_letter(store.known_titles())]
        titles = _known[1]
    home = cache.get(scoped("launcher"))
    rows = [i for r in ((home[1] if home else {}).get("rows") or []) for i in r.get("items") or []]
    mine = by_first_letter([{"id": i["id"], "type": i["type"], "name": i.get("name"), "year": i.get("year"),
                             "poster": i.get("poster"), "backdrop": i.get("backdrop"), "overview": i.get("overview"),
                             "rating": i.get("rating")} for i in rows if i.get("id") and i.get("name") and i.get("type")])
    return mine, titles


def by_first_letter(titles):
    """{first letter of the plain name: [(plain name, title)]}, in the titles' order: a search is only
    compared with names that start like it (a slip in the first letter is rare), and each name is made
    plain once."""
    out = {}
    for t in titles:
        b = plain(t.get("name"))
        if b:
            out.setdefault(b[0], []).append((b, t))
    return out


def known_matches(q, found):
    """[found] (quick_search's answer) in this order: a title named exactly [q], then the known titles
    whose names are like it (likest, then the more popular; KNOWN_FIRST at most), then the rest. Not
    kept with the shared answer: this profile's Home is part of it."""
    if len(plain(q)) < LIKE_FROM:
        return found
    try:
        mine, everyone = known_titles()
    except Exception:
        log.exception("Known titles unavailable for search")
        return found
    a = plain(q)
    best = {}
    candidates = mine.get(a[0], []) + everyone.get(a[0], [])
    for order, (b, t) in enumerate(candidates):
        # (Much shorter, or much longer than a name could start like it, can't be alike enough.)
        if len(b) < len(a) * LIKE_ENOUGH:
            continue
        score = likeness_plain(a, b)
        if score >= LIKE_ENOUGH and (t["id"] not in best or score > best[t["id"]][0]):
            best[t["id"]] = (score, order, t)
    if not best:
        return found
    ranked = [t for _, _, t in sorted(best.values(), key=lambda x: (-x[0], x[1]))][:KNOWN_FIRST]
    already = {c["id"]: c for c in found["titles"]}
    like = [already.get(t["id"]) or {k: v for k, v in t.items() if v not in (None, "")} for t in ranked]
    # (One exact match ahead: there can be many of them, "Big Boss" films nobody here watches.)
    exact = [c for c in found["titles"] + like if plain(c.get("name")) == a][:1]
    order, seen = [], set()
    for c in exact + like + found["titles"]:
        if c["id"] not in seen:
            seen.add(c["id"])
            order.append(c)
    return {**found, "titles": order[:QUICK_TITLES]}


def ai_search_cards(q):
    """The Stremio AI search, as launcher cards with the AI's reason for each."""
    try:
        # (Kept for everyone who asks the same, as the AI isn't told who asks: everyone gets the first
        # asker's answer and its request id, which links each one's openings and plays to it.)
        found = cached(f"smart:{q.lower()}", lambda: ai_search(q), ttl=S.advanced.cache.ai_search_hours * 3600)
        metas = found["metas"]
    except AIUnavailable as e:
        if e.reason == "failed":
            # Only this time: an error, so the apps offer to try again and keep Smart Search.
            raise
        # Still an answer: the title search, and a word on why the AI can't be used.
        log.info("Smart search for %r: %s", q, e)
        return {"items": cached(f"quick:{q.lower()}", lambda: quick_search(q),
                                      ttl=S.advanced.cache.quick_search_minutes * 60)["titles"],
                "note": {"limit": "Smart search is off: this month's AI limit is reached",
                         "no_model": "Smart search is off: choose the AI model in Settings",
                         "rejected": "Smart search is off: the AI service refused the key or model (Settings)"}.get(
                             e.reason, "Smart search is off: no AI key is set up")}
    with ThreadPoolExecutor(max_workers=8) as ex:
        backdrops = list(ex.map(lambda m: title_extras(m["id"], m["type"]).get("backdrop"), metas))
    cards = []
    for m, backdrop in zip(metas, backdrops):
        reason, _, overview = (m.get("description") or "").partition("\n\n")
        cards.append({k: v for k, v in {
            "id": m["id"], "type": m["type"], "name": m["name"], "year": m.get("releaseInfo"),
            "rating": m.get("imdbRating") if m.get("imdbRating") not in ("0", "0.0") else None,
            "poster": (m.get("poster") or "").replace("/w500/", "/w342/"), "reason": reason, "overview": overview[:300],
            "backdrop": backdrop,
        }.items() if v})
    return {"items": cards, **({"requestId": found["requestId"]} if found["requestId"] else {})}
