"""The titles recommendations are picked from: a deep list per language, shared by every household,
and a profile's own shortlist cut from it and from what it watched.

TMDB's related lists ("recommendations", "similar") lean English, and barely know the titles of
many countries' streaming services (they have few votes), so they rarely lead to them. TMDB's lists
of a language's titles most voted and most popular on its country's streaming services, gone through
deep, find far more of them. So each language the profiles watch has its deep list (worked out once
a day, kept, shared), and a profile's shortlist takes slices of it, as Netflix's rows do: titles related to its recent watches, its languages' best fits for its
taste, and what's trending. The AI, or without one the code here, ranks the shortlist.
"""

import logging
import math
from concurrent.futures import ThreadPoolExecutor

from .cache import cached
from .config import S
from .http import tmdb
from .languages import ANIME, language_filter

log = logging.getLogger(__name__)
C = S.advanced.catalogue

# Each language's own country, whose streaming services tell which of its titles people watch.
REGION = {"hi": "IN", "ta": "IN", "te": "IN", "ml": "IN", "ko": "KR", "ja": "JP", ANIME: "JP", "es": "ES",
          "fr": "FR", "tr": "TR", "zh": "TW", "en": "US"}
# Not stories: soaps (daily serials), kids', talk and news shows.
NOT_STORIES_TV = "10766|10762|10767|10763"


def candidate(item, kind, via):
    """A TMDB result as a candidate (the shape recommend.py and the AI use), or None without a poster."""
    title = item.get("title") or item.get("name")
    date = item.get("release_date") or item.get("first_air_date") or ""
    if not title or not item.get("poster_path") or not item.get("id"):
        return None
    return {
        "key": f"{kind[0]}{item['id']}", "kind": kind, "tmdb_id": item["id"], "title": title,
        "year": date[:4], "released": date, "lang": item.get("original_language", ""),
        "rating": round(item.get("vote_average") or 0, 1), "votes": item.get("vote_count") or 0,
        "popularity": round(item.get("popularity") or 0), "genre_ids": item.get("genre_ids") or [],
        "overview": (item.get("overview") or "")[:300],
        "poster": f"https://image.tmdb.org/t/p/w500{item['poster_path']}",
        "via": [via] if via else [],
    }


def _pages(kind, n, via, **params):
    out = []
    for page in range(1, n + 1):
        data = tmdb(f"/discover/{kind}", page=page, **params) or {}
        out += [c for c in (candidate(r, kind, via) for r in data.get("results", [])) if c]
        if page >= (data.get("total_pages") or 0):
            break
    return out


def language_list(code, kind):
    """A language's deep list of films or series (anime: Japanese animation): its titles most voted
    and most popular on its country's streaming services, and most popular anywhere. Worked out once
    a day and shared by every household. About 35 TMDB calls for each language and kind."""
    def fetch():
        deep = C.english_pages if code == "en" else C.language_pages
        base = language_filter(code, kind)
        if kind == "tv":
            base = {**base, "without_genres": "|".join(filter(None, [base.get("without_genres"), NOT_STORIES_TV]))}
        streaming = {"watch_region": REGION.get(code, "US"), "with_watch_monetization_types": "flatrate"}
        label = "popular in its language"
        found = {}
        for c in (_pages(kind, deep, label, sort_by="vote_count.desc", **streaming, **base)
                  + _pages(kind, deep, label, sort_by="popularity.desc", **streaming, **base)
                  + _pages(kind, C.anywhere_pages, label, sort_by="popularity.desc", **base)):
            found.setdefault(c["key"], c)
        log.info("Catalogue %s %s: %d titles", code, kind, len(found))
        return list(found.values())
    return cached(f"pool:{code}:{kind}", fetch, ttl=C.list_hours * 3600)


def related(tmdb_id, kind, via):
    """TMDB's recommended and similar titles for one title."""
    out = []
    for endpoint in ("recommendations", "similar"):
        data = tmdb(f"/{kind}/{tmdb_id}/{endpoint}") or {}
        out += [c for c in (candidate(r, kind, via) for r in data.get("results", [])) if c]
    return out


def same_kind(kind, x, via):
    """Popular titles in [x]'s own language and first two genres, by popularity and by votes (an older
    big show can have little popularity left): what TMDB's related lists miss for a title not in
    English. Talk shows and documentaries (tagged Reality too) only for one of them."""
    lang, genres = x.get("language"), (x.get("genres") or [])[:2]
    if not lang or lang == "en" or not genres:
        return []
    leave_out = "|".join(str(g) for g in (10767, 99) if g not in (x.get("genres") or []))
    out = []
    for sort in ("popularity.desc", "vote_count.desc"):
        out += _pages(kind, 1, via, with_original_language=lang, with_genres=",".join(map(str, genres)), sort_by=sort,
                      **({"without_genres": leave_out} if leave_out else {}))
    return out


def trending():
    out = []
    for kind in ("movie", "tv"):
        data = tmdb(f"/trending/{kind}/week") or {}
        out += [c for c in (candidate(r, kind, "trending this week") for r in data.get("results", [])) if c]
    return out


# ---------- Taste, and ranking by it (without the AI) ----------

def taste(history):
    """{"lang", "genre", "kind"}: how much of the profile's watching is in each, recent watches
    counting more, loved ones more again and ones it didn't like against. [history]: most recent
    first, each {"kind", "language", "genres", "weight"} (weight: 2 loved, 1.3 liked, 1, -1 disliked)."""
    lang, genre, kind = {}, {}, {}
    for i, h in enumerate(history[:C.taste_titles]):
        w = C.taste_decay ** i * h.get("weight", 1)
        if h.get("language"):
            lang[h["language"]] = lang.get(h["language"], 0) + w
        kind[h["kind"]] = kind.get(h["kind"], 0) + w
        for g in h.get("genres") or []:
            genre[g] = genre.get(g, 0) + w / max(1, len(h["genres"]))
    total = sum(abs(v) for v in kind.values()) or 1
    return {name: {k: max(v, 0) / total for k, v in d.items()} for name, d in (("lang", lang), ("genre", genre), ("kind", kind))}


def fit(c, t):
    """How well a candidate fits the profile's taste (higher is better)."""
    g = sum(t["genre"].get(x, 0) for x in c["genre_ids"]) / math.sqrt(max(1, len(c["genre_ids"])))
    return ((t["lang"].get(c["lang"], 0) + 0.03) * (0.05 + g) * (t["kind"].get(c["kind"], 0) + 0.1)
            * (1 + 0.15 * len(c["via"])) * (1 + math.log1p(c["popularity"])) ** 0.5)


# ---------- A profile's shortlist ----------

def shortlist(seeds, recent, languages, t, skip):
    """The profile's shortlist, as slices: for each Because seed, its related and same-language
    titles; titles related to the other recent watches; for each language (its own and English) the
    best fits for its taste in that language's deep list; and what's trending. [seeds] and [recent]:
    {"name", "kind", "tmdb_id", "x" (title_extras)}; [skip]: TMDB keys (m123/t456) never to offer.
    Returns (shortlist, {seed name: its own slice in order}), at most C.shortlist titles."""
    with ThreadPoolExecutor(max_workers=8) as pool:
        seed_lists = list(pool.map(lambda s: related(s["tmdb_id"], s["kind"], s["name"]) + same_kind(s["kind"], s["x"], s["name"]), seeds))
        recent_lists = list(pool.map(lambda s: related(s["tmdb_id"], s["kind"], s["name"]), recent))
        langs = list(dict.fromkeys([*languages, "en"]))
        lang_lists = list(pool.map(lambda lk: language_list(*lk), [(code, kind) for code in langs for kind in ("movie", "tv")]))
    by_seed = {}
    slices = []
    for s, found in zip(seeds, seed_lists):
        own = _merge(found, skip)
        # Its own language first (most of a Because row), then the rest, each by how often it came up.
        own.sort(key=lambda c: (c["lang"] != s["x"].get("language"), -len(c["via"]), -c["popularity"]))
        by_seed[s["name"]] = own[:C.seed_slice]
        slices.append(by_seed[s["name"]])
    for found in recent_lists:
        slices.append(sorted(_merge(found, skip), key=lambda c: -c["popularity"])[:C.recent_slice])
    for found in lang_lists:
        slices.append(sorted(_merge(found, skip), key=lambda c: -fit(c, t))[:C.language_slice])
    slices.append(_merge(trending(), skip)[:C.trending_slice])
    # Round robin, so every slice has its best in before any has its tail.
    out, seen = [], set()
    for group in _zip_all(slices):
        for c in group:
            if c["key"] not in seen and len(out) < C.shortlist:
                seen.add(c["key"])
                out.append(c)
    # Every title's "via" from all slices (it counts towards how related it is).
    vias = {}
    for sl in slices:
        for c in sl:
            vias.setdefault(c["key"], set()).update(c["via"])
    for c in out:
        c["via"] = sorted(vias.get(c["key"], set()))
    return out, by_seed


def _merge(found, skip):
    out = {}
    for c in found:
        if c["key"] in skip:
            continue
        if c["key"] in out:
            out[c["key"]]["via"] = sorted(set(out[c["key"]]["via"]) | set(c["via"]))
        else:
            out[c["key"]] = dict(c, via=list(c["via"]))
    return list(out.values())


def _zip_all(lists):
    for i in range(max((len(x) for x in lists), default=0)):
        yield [x[i] for x in lists if i < len(x)]
