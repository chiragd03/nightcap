"""The For You and Because you watched rows: candidates from TMDB, ranked by the AI."""

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from . import catalogue, store
from .cache import cached
from .ai import AIUnavailable, ask_ai, save_picks
from .config import BECAUSE_ROWS, MAX_AGE_HOURS, MIN_REBUILD_HOURS, S
from .context import me
from .http import tmdb
from .languages import LANGUAGE_ROWS, home_settings
from .titles import genre_names, imdb_id_for, title_extras, tmdb_find

log = logging.getLogger(__name__)
R = S.advanced.recommendations


def fetch_library():
    """Watched titles (any amount), most recently watched first, as {"id", "type", "name"}."""
    return [{"id": r["imdb_id"], "type": r["type"], "name": r["name"]} for r in store.history(me())]


def merged_history():
    """(movies, series, seeds) from the profile's history, most recently watched first."""
    library = fetch_library()
    movies = [m for m in library if m["type"] == "movie"]
    series = [m for m in library if m["type"] == "series"]
    return movies, series, library[:BECAUSE_ROWS]


def to_candidate(item, kind, via):
    title = item.get("title") or item.get("name")
    date = item.get("release_date") or item.get("first_air_date") or ""
    if not title or not item.get("poster_path"):
        return None
    return {
        "key": f"{kind[0]}{item['id']}",
        "kind": kind,
        "tmdb_id": item["id"],
        "title": title,
        "year": date[:4],
        "released": date,
        "lang": item.get("original_language", ""),
        "rating": round(item.get("vote_average") or 0, 1),
        "votes": item.get("vote_count") or 0,
        "popularity": round(item.get("popularity") or 0),
        "genre_ids": item.get("genre_ids") or [],
        "overview": (item.get("overview") or "")[:300],
        "poster": f"https://image.tmdb.org/t/p/w500{item['poster_path']}",
        "via": [via] if via else [],
    }


def related(tmdb_id, kind, via):
    """TMDB recommendations plus similar titles for one movie or show."""
    results = []
    for endpoint in ("recommendations", "similar"):
        data = tmdb(f"/{kind}/{tmdb_id}/{endpoint}") or {}
        results += [(r, kind, via) for r in data.get("results", [])]
    return results


# Genres a "same kind" list leaves out unless the title is one: talk shows and documentaries are
# tagged Reality too on TMDB.
NOT_SAME_KIND = (10767, 99)


def same_kind(kind, x):
    """Popular titles in [x]'s own language and genres (TMDB's related lists lean English, and are
    nearly all English for an Indian reality show): its first two genres together, by popularity and
    by votes (an older big show can have little popularity left). Only for a title not in English."""
    lang, genres = x.get("language"), (x.get("genres") or [])[:2]
    if not lang or lang == "en" or not genres:
        return []
    leave_out = "|".join(str(g) for g in NOT_SAME_KIND if g not in (x.get("genres") or []))
    raw = []
    for sort in ("popularity.desc", "vote_count.desc"):
        found = tmdb(f"/discover/{kind}", with_original_language=lang, with_genres=",".join(map(str, genres)),
                     sort_by=sort, **({"without_genres": leave_out} if leave_out else {})) or {}
        raw += [(r, kind, "same language and genre") for r in found.get("results", [])]
    return raw


def merge_candidates(raw, skip=()):
    pool = {}
    for item, kind, via in raw:
        cand = to_candidate(item, kind, via)
        if not cand or cand["key"] in skip:
            continue
        if cand["key"] in pool:
            if via and via not in pool[cand["key"]]["via"]:
                pool[cand["key"]]["via"].append(via)
        else:
            pool[cand["key"]] = cand
    return pool


PICK = {
    "type": "object",
    "properties": {"key": {"type": "string"}, "reason": {"type": "string"}},
    "required": ["key", "reason"],
    "additionalProperties": False,
}
PICKS = {"type": "array", "items": PICK}
BECAUSE = {
    "type": "object",
    "properties": {"seed": {"type": "string"}, "picks": PICKS},
    "required": ["seed", "picks"],
    "additionalProperties": False,
}
THEME = {
    "type": "object",
    "properties": {"title": {"type": "string"}, "picks": {"type": "array", "items": {"type": "string"}}},
    "required": ["title", "picks"],
    "additionalProperties": False,
}
SCHEMA = {
    "type": "object",
    "properties": {
        "taste_summary": {"type": "string"},
        "for_you": PICKS,
        "because": {"type": "array", "items": BECAUSE},
        "themes": {"type": "array", "items": THEME},
        "shows": PICKS,
        "show_themes": {"type": "array", "items": THEME},
        "movies": PICKS,
        "movie_themes": {"type": "array", "items": THEME},
    },
    "required": ["taste_summary", "for_you", "because", "themes", "shows", "show_themes", "movies", "movie_themes"],
    "additionalProperties": False,
}

SYSTEM = """You are a sharp, well-read film and TV curator building one person's personal rows for their TV, the way Netflix's Home is built.

You get their watch history (most recent first; marked LOVED, LIKED or NOT FOR THEM where they said so, and quitting a title early as not to their taste counts as NOT FOR THEM) and a pool of candidate titles. Each candidate has a key: m<id> is a movie, t<id> is a series. Pick only from the pool, using exact keys.

Many candidates are recent releases or regional titles you may not know, often with few votes; judge those from their genres, language and plot snippet, not their rating, and include them where they fit.

Work out what this person actually enjoys - genres, tone, languages, formats (reality, competition, comedy, crime...), eras, mainstream vs niche - weighting recent watches and LOVED ones most, and steering away from what's like the NOT FOR THEM ones. Their taste may span several cultures and languages; reflect that mix rather than flattening it to whatever is most popular. Skip sequels or follow-ups to things they haven't started, and anything plainly the same title as something in their history.

Use at most one title per franchise in each row. Never pick anything in their watch history.

They have three pages: Home (everything), Shows (series only) and Movies (films only).

Home's rows (movies and series mixed freely, in whatever proportion suits this person):
- for_you: about 30 titles, best matches first: "Top picks for you".
- because: one row per title in BECAUSE YOU WATCHED, in the same order, with seed set to that title's name and about 12 picks that follow from it: its kind (format, tone) and mostly its language (about 9 of 12 when the pool has enough that fit, the rest the closest matches in other languages).
- themes: 8 to 10 rows like Netflix's, each 10 to 12 titles from the pool that genuinely share what its name says - a mood, genre, setting, language or format, or a mix ("Gritty Hindi crime thrillers", "Feel-good Korean romances", "Short, sharp workplace comedies", "Reality shows with high stakes"). Name each plainly and honestly in under 40 characters; base them on what this person watches, and make them differ from each other.

The Shows page's own rows, series (t keys) only:
- shows: about 25 series, best matches first: its "Top picks for you".
- show_themes: 6 rows like the themes above, series only, 10 to 12 each ("Gritty Hindi crime series", "Short comedy shows").
The Movies page's own rows, films (m keys) only:
- movies: about 25 films, best matches first.
- movie_themes: 6 rows of films only, 10 to 12 each ("Heist and con films", "Bollywood family entertainers").

On each page a title appears in one row only. The Shows and Movies pages are for finding more: their picks and themes don't repeat Home's for_you, and their themes differ from Home's themes.

Each reason (for_you and because) is one short line under 70 characters a viewer would find useful, e.g. "Same deadpan workplace humour as The Office"."""


def candidate_line(c, genres):
    # Genres and a plot snippet let the AI judge titles released after its training cutoff.
    via = "; ".join(c["via"][:3])
    g = ", ".join(genres.get(i, "") for i in c["genre_ids"][:3])
    plot = c["overview"][:160].replace("\n", " ")
    return (f'{c["key"]} | {c["title"]} ({c["year"]}) | {g} | lang {c["lang"]} | '
            f'{c["rating"]}/10, {c["votes"]} votes, pop {c["popularity"]} | via: {via} | {plot}')



def history_line(h, genres):
    g = ", ".join(genres.get(i, "") for i in (h["x"].get("genres") or [])[:3])
    mark = {2: " | LOVED", 1.3: " | LIKED", -1: " | NOT FOR THEM"}.get(h["weight"], "")
    return (f'{h["name"]} ({h["x"].get("year") or "?"}, {"film" if h["kind"] == "movie" else "series"}, '
            f'lang {h["x"].get("language") or "?"}) - {g}{mark}')


def seed_line(s, genres):
    """A Because row's title as the AI sees it: its genres, language and plot (many titles share a name)."""
    x = s["x"]
    g = ", ".join(genres.get(i, "") for i in (x.get("genres") or [])[:3])
    plot = (x.get("overview") or "")[:200].replace("\n", " ")
    return f'{s["name"]} ({s["type"]}, {x.get("year") or "?"}) | {g} | lang {x.get("language") or "?"} | {plot}'


def short_line(c, genres):
    """A candidate as the rebuild shows it: what's needed to judge it, in few tokens (the pool is
    hundreds long, and every token of it is paid for)."""
    g = ", ".join(genres.get(i, "") for i in c["genre_ids"][:3])
    plot = c["overview"][:R.plot_chars].replace("\n", " ")
    return f'{c["key"]}|{c["title"]} ({c["year"]})|{"film" if c["kind"] == "movie" else "series"}|{c["lang"]}|{g}|{plot}'


def rank_with_ai(history, seeds, candidates):
    genres = genre_names()
    prompt = ("WATCH HISTORY (most recent first):\n" + "\n".join(history_line(h, genres) for h in history[:R.history_titles])
              + "\n\nBECAUSE YOU WATCHED:\n" + "\n".join(f"{i + 1}. {seed_line(s, genres)}" for i, s in enumerate(seeds))
              + "\n\nCANDIDATE POOL (key|title (year)|kind|language|genres|plot):\n"
              + "\n".join(short_line(c, genres) for c in candidates))
    declined = store.not_interested_names(me())
    if declined:
        prompt += ("\n\nNOT INTERESTED (the viewer turned these down; avoid them and close lookalikes):\n"
                   + "\n".join(declined[-R.not_interested_titles:]))
    return ask_ai(SYSTEM, prompt, SCHEMA, effort=R.ai_effort, think=R.ai_thinking)


LANGUAGE_NAMES = {"en": "English", "ja": "Japanese", **LANGUAGE_ROWS}


def rank_in_code(shortlist, by_seed, seeds, t):
    """The rows without the AI (a household with no AI key, or over its monthly limit): For You by
    how well each title fits the profile's taste, each Because row its title's own slice (mostly in
    its language), no themed rows. As rank_with_ai's answer."""
    def reason(c):
        seen = [v for v in c["via"] if v not in ("trending this week", "popular in its language")]
        if seen:
            return f"Like {seen[0]}"
        if "trending this week" in c["via"]:
            return "Trending this week"
        return f"Popular in {LANGUAGE_NAMES.get(c['lang'], c['lang'].upper())}"
    ranked = sorted(shortlist, key=lambda c: -catalogue.fit(c, t))
    because = []
    for s in seeds:
        own = by_seed.get(s["name"]) or []
        same = [c for c in own if c["lang"] == s["x"].get("language")]
        other = [c for c in own if c["lang"] != s["x"].get("language")]
        row = same[:R.because_same_language] + other
        because.append({"seed": s["name"], "picks": [{"key": c["key"], "reason": reason(c)} for c in row[:R.because_size]]})
    top = ranked[:R.for_you_size]
    on_home = {c["key"] for c in top}
    # Each page's picks: the best of its kind not already in Home's.
    page = lambda kind: [{"key": c["key"], "reason": reason(c)} for c in ranked
                         if c["kind"] == kind and c["key"] not in on_home][:R.page_picks]
    return {"taste_summary": "", "for_you": [{"key": c["key"], "reason": reason(c)} for c in top],
            "because": because, "themes": [], "shows": page("tv"), "show_themes": [], "movies": page("movie"),
            "movie_themes": []}


def to_metas(picks, by_key, skip=(), prefix="", limit=None):
    """Turn [{key, reason}] into Stremio metas, dropping unknown, duplicate and skipped titles."""
    keys = [p["key"] for p in picks if p["key"] in by_key]
    with ThreadPoolExecutor(max_workers=8) as pool:
        imdb = dict(zip(keys, pool.map(lambda k: imdb_id_for(by_key[k]["kind"], by_key[k]["tmdb_id"]), keys)))
    metas, seen, names = [], set(skip), set()
    for p in picks:
        c, tt = by_key.get(p["key"]), imdb.get(p["key"])
        # (One per name: Big Brother US and UK are one choice.)
        name = " ".join("".join(ch for ch in c["title"].lower() if ch.isalnum() or ch == " ").split()) if c else ""
        if not c or not tt or tt in seen or name in names:
            continue
        seen.add(tt)
        names.add(name)
        metas.append({
            "id": tt,
            "type": "movie" if c["kind"] == "movie" else "series",
            "name": c["title"],
            "poster": c["poster"],
            "releaseInfo": c["year"],
            "description": f"{prefix}{p['reason']}\n\n{c['overview']}",
            "imdbRating": str(c["rating"]),
        })
        if limit and len(metas) >= limit:
            break
    return metas


def tmdb_key(imdb_id, ctype):
    """A title's TMDB key ("m123" / "t456"), or None; kept, as it never changes."""
    tid = tmdb_find(imdb_id, ctype)
    return f"{'m' if ctype == 'movie' else 't'}{tid}" if tid else None


def pick_seeds(history, n):
    """The Because you watched rows' titles: the most recently loved first, then the latest watches,
    never one it didn't like, and each of a different language, kind or genre where it can be."""
    usable = [h for h in history if h["weight"] > 0 and h["tmdb_id"]]
    loved = [h for h in usable[:R.loved_seed_within] if h["weight"] == 2][:R.loved_seeds]
    ordered = loved + [h for h in usable if h not in loved]
    seeds, kinds = [], set()
    for h in ordered:
        sig = (h["x"].get("language"), h["kind"], (h["x"].get("genres") or [None])[0])
        if sig not in kinds:
            kinds.add(sig)
            seeds.append(h)
        if len(seeds) == n:
            return seeds
    return seeds + [h for h in ordered if h not in seeds][:n - len(seeds)]


def build_catalogs():
    library = fetch_library()
    movies = [m for m in library if m["type"] == "movie"]
    series = [m for m in library if m["type"] == "series"]
    signals = store.taste_signals(me())
    recent = library[:max(R.history_titles, catalogue.C.taste_titles)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        extras = list(pool.map(lambda m: title_extras(m["id"], m["type"]), recent))
        keys = list(pool.map(lambda m: tmdb_key(m["id"], m["type"]), library[:R.skip_titles]))
    weight = lambda tt: 2 if tt in signals["loved"] else 1.3 if tt in signals["liked"] else -1 if tt in signals["disliked"] else 1
    history = [{"id": m["id"], "name": m["name"], "type": m["type"], "kind": "movie" if m["type"] == "movie" else "tv",
                "language": x.get("language"), "genres": x.get("genres") or [], "x": x, "weight": weight(m["id"]),
                "tmdb_id": int(k[1:]) if k else None}
               for m, x, k in zip(recent, extras, keys)]
    t = catalogue.taste(history)
    seeds = pick_seeds(history, BECAUSE_ROWS)
    related_to = [h for h in history if h["weight"] > 0 and h["tmdb_id"] and h not in seeds][:R.related_titles]
    # (Watched ones by their TMDB key here; Not interested, by IMDb id as the rows are made.)
    skip = {k for k in keys if k}
    shortlist, by_seed = catalogue.shortlist(seeds, related_to, home_settings()["languages"], t, skip)
    log.info("History: %d movies, %d series; shortlist %d; because-rows for %s", len(movies), len(series),
             len(shortlist), [s["name"] for s in seeds])
    picks, by_ai = None, False
    try:
        # (Now and then an answer comes back nearly empty: it's asked once more, then ranked in code.)
        for _ in range(2):
            answer = rank_with_ai(history, seeds, shortlist)
            sizes = [len(answer.get(k) or []) for k in ("for_you", "shows", "movies")]
            if min(sizes) >= R.min_ai_picks:
                picks, by_ai = answer, True
                break
            log.warning("The AI's answer was thin (for you, shows, movies: %s)", sizes)
    except AIUnavailable as e:
        log.info("Ranking in code: %s", e)
    if picks is None:
        picks = rank_in_code(shortlist, by_seed, seeds, t)
    log.info("Taste: %s", picks["taste_summary"])

    by_key = {c["key"]: c for c in shortlist}
    for own in by_seed.values():
        for c in own:
            by_key.setdefault(c["key"], c)
    watched = {m["id"] for m in library} | store.not_interested(me())
    # The AI picks the For You titles; the row shows them newest first.
    newest_first = sorted((p for p in picks["for_you"] if p["key"] in by_key),
                          key=lambda p: by_key[p["key"]]["released"], reverse=True)
    catalogs = {"foryou": to_metas(newest_first, by_key, skip=watched)}
    # Netflix-style: a title shows up in one row only.
    used = watched | {m["id"] for m in catalogs["foryou"]}
    seed_names = []
    # (Which row each of the AI's Because and theme lists became, if any: see save_picks.)
    rows_of = {}
    for i, (seed, b) in enumerate(zip(seeds, picks["because"])):
        metas = to_metas(b["picks"], by_key, skip=used, prefix=f"Because you watched {seed['name']}: ")
        if not metas:
            continue
        catalogs[f"because{len(seed_names)}"] = metas
        rows_of["because", i] = f"because{len(seed_names)}"
        seed_names.append(seed["name"])
        used |= {m["id"] for m in metas}
    themes = []
    for i, th in enumerate(picks["themes"]):
        metas = to_metas([{"key": k, "reason": ""} for k in th["picks"]], by_key, skip=used)
        if len(metas) >= R.theme_min_titles:
            catalogs[f"theme{len(themes)}"] = metas
            rows_of["themes", i] = f"theme{len(themes)}"
            themes.append(th["title"].strip()[:60])
            used |= {m["id"] for m in metas}
    # The Shows and Movies pages' own: picks and themes of their kind, none of Home's picks, a title
    # once per page. (Because rows are shared: each shows on its title's page too.)
    pages = {}
    for page, kind, picks_key, themes_key in (("tv", "tv", "shows", "show_themes"), ("movie", "movie", "movies", "movie_themes")):
        own = lambda ps: [p for p in ps if p["key"] in by_key and by_key[p["key"]]["kind"] == kind]
        taken = watched | {m["id"] for m in catalogs["foryou"]}
        catalogs[f"{page}:picks"] = to_metas(own(picks[picks_key]), by_key, skip=taken)
        taken |= {m["id"] for m in catalogs[f"{page}:picks"]}
        names = []
        for i, th in enumerate(picks[themes_key]):
            metas = to_metas(own([{"key": k, "reason": ""} for k in th["picks"]]), by_key, skip=taken)
            if len(metas) >= R.theme_min_titles:
                catalogs[f"{page}:theme{len(names)}"] = metas
                rows_of[themes_key, i] = f"{page}:theme{len(names)}"
                names.append(th["title"].strip()[:60])
                taken |= {m["id"] for m in metas}
        pages[page] = names
    for cid, metas in catalogs.items():
        log.info("Row %s: %d titles", cid, len(metas))
    request_id = None
    if by_ai:
        keys = lambda ps: [p["key"] for p in ps]
        seed_key = lambda s: f"{'m' if s['kind'] == 'movie' else 't'}{s['tmdb_id']}" if s["tmdb_id"] else s["id"]
        listed = lambda name: [{"title": th["title"], "row": rows_of.get((name, i)), "picks": th["picks"]}
                               for i, th in enumerate(picks[name])]
        request_id = save_picks("home", [c["key"] for c in shortlist], {
            "for_you": keys(picks["for_you"]),
            "because": [{"seed": seed_key(seeds[i]) if i < len(seeds) else None, "row": rows_of.get(("because", i)),
                         "picks": keys(b["picks"])} for i, b in enumerate(picks["because"])],
            "themes": listed("themes"),
            "shows": keys(picks["shows"]), "show_themes": listed("show_themes"),
            "movies": keys(picks["movies"]), "movie_themes": listed("movie_themes"),
        })

    return {
        "version": VERSION,
        "built_at": time.time(),
        "history_fingerprint": fingerprint(movies, series),
        "taste_summary": picks["taste_summary"],
        "by_ai": by_ai,
        # (The AI's answer these rows came from, as saved in ai_picks: goes out with them.)
        "request_id": request_id,
        "seeds": seed_names,
        "seed_kinds": [next(("movie" if s["kind"] == "movie" else "tv") for s in seeds if s["name"] == n) for n in seed_names],
        "themes": themes,
        "page_themes": pages,
        "watched": sorted(watched),
        "catalogs": catalogs,
    }


def fingerprint(movies, series):
    n = R.fingerprint_titles
    return "|".join(m["id"] for m in movies[:n] + series[:n])


_recs = {}  # profile id -> its saved recommendations (or None), read from the database once
_rebuilding = threading.Lock()  # one rebuild at a time (each is a paid AI call)


def recs():
    """The current profile's recommendations (For You and Because you watched), or None."""
    profile_id = me()
    if profile_id not in _recs:
        _recs[profile_id] = store.recommendations(profile_id)
    return _recs[profile_id]


def forget(profile_id):
    """Reads the profile's recommendations again next time (after it changes or is removed)."""
    _recs.pop(profile_id, None)


# What a rebuild makes, as a number: saved recommendations from an older one are rebuilt at the next
# refresh rather than kept for their days.
VERSION = 3


def refresh_if_needed(force=False):
    cache = recs()
    if cache and (cache.get("version") or 1) < VERSION:
        log.info("Rebuilding: saved by an older version")
        force = True
    if not force and cache:
        age_h = (time.time() - cache["built_at"]) / 3600
        movies, series, _ = merged_history()
        changed = fingerprint(movies, series) != cache["history_fingerprint"]
        # A rebuild is a paid AI call (and TMDB's lists): rebuild for new watches at most once per
        # MIN_REBUILD_HOURS, and otherwise only when the cache gets stale. Without the AI the rows
        # are ranked in code, and kept the same way (so its lookups aren't made on every refresh).
        if not (changed and age_h >= MIN_REBUILD_HOURS) and age_h < MAX_AGE_HOURS:
            log.info("Skipping rebuild (new watches: %s, cache age %.1fh)", changed, age_h)
            return
        log.info("Rebuilding: %s", "new watches found" if changed else f"cache is {age_h:.0f}h old")
    with _rebuilding:
        new = build_catalogs()
        store.save_recommendations(me(), new)
        _recs[me()] = new
