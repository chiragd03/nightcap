"""Home: Continue watching, the rows, and the Browse pages."""

import logging
import itertools
import json
import random
import re
import time
import tomllib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import Request, urlopen

from . import accounts, store
from .cache import cached
from .config import S
from .context import for_me, me
from .episodes import airtimes, due_now, episode_out, is_out, next_episode, next_unwatched, waiting_episodes
from .http import SSL_CONTEXT, cinemeta, tmdb
from .languages import ANIME, ANIME_KEYWORD, COUNTRY_NAMES, LANGUAGE_ROWS, NOT_STORIES, home_settings, in_language_row, language_filter, tmdb_languages
from .playback import waiting_for_sources
from .catalogue import REGION
from .recommend import fetch_library, recs
from .titles import feed_item, genre_names, imdb_id_for, title_extras
from .widgets import widgets

log = logging.getLogger(__name__)


def continue_watching(limit=S.home.continue_watching):
    """In-progress titles, most recent first; shows with episodes waiting come to the front."""
    profile = me()
    watching = [r for r in store.library(profile)
                if ((r["type"] == "movie" and r["position_ms"] and not r["watched"])
                    or (r["type"] == "series" and r["current_video_id"]))
                # "Not for me" on leaving: out of the row until it's played again.
                and not (r["continue_hidden_at"] and (not r["last_watched_at"] or r["last_watched_at"] <= r["continue_hidden_at"]))]
    # Look further back than the row shows: a show with new episodes comes to the front.
    picked = watching[:limit * 3]
    ticks = {r["imdb_id"]: store.ticks(profile, r["imdb_id"]) for r in picked if r["type"] == "series"}

    # Shows you follow whose next episode is due about now: its exact air time, then whether it
    # can be played yet.
    def due(r):
        if r["type"] != "series" or not r["notify"]:
            return None
        try:
            nxt = next_unwatched(r["imdb_id"], r["current_video_id"], ticks.get(r["imdb_id"], set()))
            if nxt and due_now(nxt):
                airtimes(r["imdb_id"])
            return nxt
        except Exception:
            log.exception("Next episode due for %s", r["imdb_id"])
            return None
    with ThreadPoolExecutor(max_workers=6) as pool:
        upcoming = list(pool.map(for_me(due), picked))
        pending = [waiting_for_sources(v) for v in upcoming]
        # (As the profile: whether an episode is out early depends on its household's sources.)
        fresh = list(pool.map(for_me(lambda r: waiting_episodes(r, ticks.get(r["imdb_id"], set()))
                                     if r["type"] == "series" and r["notify"] else 0), picked))
    # An episode that's out but can't be played yet doesn't count as new.
    fresh = [0 if pending[i] else n for i, n in enumerate(fresh)]

    # A show you're caught up on (its episode watched or not out yet, nothing new) leaves the row
    # until one comes out.
    def caught_up(i):
        r = picked[i]
        return (r["type"] == "series" and not fresh[i] and not r["position_ms"]
                and (r["current_video_id"] in ticks.get(r["imdb_id"], set()) or not episode_out(r["current_video_id"])
                     or (pending[i] and upcoming[i]["id"] == r["current_video_id"])))
    keep = [i for i in range(len(picked)) if not caught_up(i)]
    # New episodes first (most recently watched first among them), then the rest by recency.
    order = sorted(keep, key=lambda i: (not fresh[i], i))[:limit]
    rows = []
    for r, n_new in ((picked[i], fresh[i]) for i in order):
        vid = r["current_video_id"] or ""
        nxt = None
        if r["type"] == "series" and vid:
            try:
                nxt = next_episode(vid)
                # On a watched episode (new ones out): the card shows the next one to play.
                if not r["position_ms"] and vid in ticks.get(r["imdb_id"], set()) and nxt:
                    vid, nxt = nxt["id"], next_episode(nxt["id"])
            except Exception:
                log.exception("Next episode for %s", r["imdb_id"])
        parts = vid.split(":")
        dur, off = r["duration_ms"], r["position_ms"]
        rows.append((r["imdb_id"], r["type"], {
            "newEpisodes": n_new or None,
            "name": r["name"],
            "poster": r["poster"],
            "videoId": vid or None,
            "episode": f"S{parts[1]} E{parts[2]}" if len(parts) == 3 else None,
            "progress": round(off / dur, 3) if dur and vid == r["current_video_id"] else None,
            "muted": True if not r["notify"] else None,
            # So the TV can reorder and move on at once, before the server confirms.
            "lastWatched": r["last_watched_at"].isoformat() if r["last_watched_at"] else None,
            "nextVideoId": nxt["id"] if nxt else None,
            "nextEpisode": f"S{nxt['season']} E{nxt['episode']}" if nxt else None,
        }))
    return rows


def trending(limit=20):
    rows = []
    for r in (tmdb("/trending/all/week") or {}).get("results", []):
        if r.get("media_type") not in ("movie", "tv"):
            continue
        tt = imdb_id_for(r["media_type"], r["id"])
        if tt:
            rows.append((tt, "movie" if r["media_type"] == "movie" else "series", {}))
        if len(rows) >= limit:
            break
    return rows


def title_name(name):
    """A seed name as stored (the IMDb id when the title was unknown)."""
    if re.fullmatch(r"tt\d+", name or ""):
        return (store.title(name) or {}).get("name") or name
    return name


def split_reason(meta):
    first, _, rest = (meta.get("description") or "").partition("\n\n")
    return first.split(": ", 1)[1] if first.startswith("Because you watched ") else first, rest


# A language page's New rows: out in the last four months.
P = S.advanced.pages
NEW_DAYS = P.new_days
# Few people vote on TMDB for many languages, so a language's lists don't ask for votes, except
# Highly rated (a rating means little without some): it takes the well-voted first, then fills up from the less voted.
RATED_VOTES = {"movie": tuple(P.rated_film_votes), "tv": tuple(P.rated_series_votes)}
# Series that aren't stories, or are daily serials (TMDB doesn't tag most of those as soaps).
NOT_SHOWS = "10762|10766"   # kids, soap
SERIAL_EPISODES = P.serial_episodes   # a season longer than this is a daily serial
IGNORED_AFTER_DAYS = P.ignored_after_days




def row_stats():
    return store.row_stats(me())


def note_row_opened(row, imdb_id=None):
    """The TV reports which Home row a title was opened from; rows nobody opens rotate out."""
    if not re.match(r"^[a-z0-9:_-]{1,40}$", row):
        return
    store.note_row_opened(me(), row)
    if imdb_id and re.match(r"^tt\d+$", imdb_id):
        store.interaction(me(), imdb_id, "opened", origin="row", row_key=row)


def note_rows_shown(keys, page=None):
    store.note_rows_shown(me(), keys, page)


def ignored(key, stats):
    st = stats.get(key) or {}
    since, opened = st.get("shown_since"), st.get("opened") or 0
    return bool(since) and time.time() - since > IGNORED_AFTER_DAYS * 86400 and opened < since


def daily_pick(pool, n, key):
    """n items from the pool, a different mix each day but stable within the day; best first."""
    rng = random.Random(f"{time.strftime('%Y-%m-%d')}:{key}")
    top = pool[:max(n * 2, n)]
    chosen = set(rng.sample(range(len(top)), min(n, len(top))))
    return [x for i, x in enumerate(top) if i in chosen]


def discover(kind, pages=1, wanted=None, **params):
    """TMDB discover results as (imdb id, type) pairs: [pages] pages of them, only those [wanted]
    keeps (given TMDB's results, it returns the ones to keep). Cached for six hours."""
    key = f"discover:{kind}:{json.dumps(params, sort_keys=True)}"
    if pages > 1 or wanted:
        key += f":{pages}:{wanted.__name__ if wanted else ''}"

    def fetch():
        results = []
        for page in range(1, pages + 1):
            data = tmdb(f"/discover/{kind}", page=page, **params) or {}
            results += data.get("results", [])
            if page >= (data.get("total_pages") or 0):
                break
        if wanted:
            results = wanted(results)
        # Only as many as a row can show (some will be in rows above it): each is a TMDB call once.
        with ThreadPoolExecutor(max_workers=4) as pool:
            ids = list(pool.map(lambda r: imdb_id_for(kind, r["id"]), results[:P.convert_titles]))
        return [(tt, "movie" if kind == "movie" else "series") for tt in ids if tt]
    # (Pairs come back from the database as lists; rows put them in sets, so they're pairs again.)
    return [tuple(x) for x in cached(key, fetch, ttl=S.advanced.cache.discover_hours * 3600)]


def interleave(*lists):
    out = []
    for group in itertools.zip_longest(*lists):
        out.extend(x for x in group if x)
    return out


def days_ago(n):
    return time.strftime("%Y-%m-%d", time.gmtime(time.time() - n * 86400))




def with_poster(results):
    return [r for r in results if r.get("poster_path")]


def season_length(tmdb_id):
    """A series' episodes per season (kept in memory only: it's asked again when its list is)."""
    def fetch():
        info = tmdb(f"/tv/{tmdb_id}") or {}
        return (info.get("number_of_episodes") or 0) / max(info.get("number_of_seasons") or 1, 1)
    return cached(f"seasonlength:{tmdb_id}", fetch, ttl=S.advanced.cache.season_length_days * 86400)


def not_serials(results):
    """Series with a poster that aren't daily serials."""
    results = with_poster(results)
    with ThreadPoolExecutor(max_workers=8) as pool:
        lengths = list(pool.map(lambda r: season_length(r["id"]), results))
    return [r for r, n in zip(results, lengths) if n <= SERIAL_EPISODES]


def language_split(code, sort="popularity.desc", since_days=P.popular_years * 365, shows=True):
    """A language row's films and series, apart: out already, with a poster; series streaming (in the
    household's country for English, the language's own otherwise) and not daily serials (anime's
    long seasons aren't serials). [shows]: False for the films only (the series come back empty)."""
    best = sort.startswith("vote_average")
    anime_like = code in (ANIME, "ja")

    def titles(kind, date_field, **filters):
        params = {"sort_by": sort, f"{date_field}.gte": days_ago(since_days), f"{date_field}.lte": days_ago(0),
                  **filters, "without_genres": filters.get("without_genres", NOT_STORIES)}
        wanted = with_poster
        if kind == "tv":
            params["without_genres"] += f"|{NOT_SHOWS}"
            # Streaming in the language's own country (Hindi: India), where its shows are; English in
            # the household's.
            region = accounts.country() if code == "en" else REGION.get(code, accounts.country())
            params.update(watch_region=region, with_watch_monetization_types="flatrate")
            wanted = with_poster if anime_like else not_serials
        if not best:
            return discover(kind, pages=P.language_pages, wanted=wanted, **params)[:P.list_size]
        many, few = RATED_VOTES[kind]
        out = discover(kind, pages=2, wanted=wanted, **params, **{"vote_count.gte": many})[:P.list_size]
        if len(out) < P.list_size:
            out = list(dict.fromkeys(out + discover(kind, pages=2, wanted=wanted, **params,
                                                    **{"vote_count.gte": few, "vote_count.lte": many - 1})))[:P.list_size]
        return out

    want_shows = shows
    films = titles("movie", "primary_release_date", **language_filter(code, "movie"))
    shows = titles("tv", "first_air_date", **language_filter(code, "tv")) if want_shows else []
    if code == ANIME:
        # The anime tag finds the ones not in Japanese; new ones may not be tagged yet, hence both.
        films = list(dict.fromkeys(interleave(films, titles("movie", "primary_release_date",
                                                            with_keywords=ANIME_KEYWORD))))[:P.list_size]
        if want_shows:
            shows = list(dict.fromkeys(interleave(shows, titles("tv", "first_air_date",
                                                                with_keywords=ANIME_KEYWORD))))[:P.list_size]
    return films, shows


def reality_titles(code):
    """A language page's reality and talk shows from the last three years (not on Home's row)."""
    return discover("tv", pages=2, wanted=with_poster, sort_by="popularity.desc", with_genres="10764|10767",
                    with_original_language="ja" if code == "ja" else code,
                    **{"first_air_date.gte": days_ago(P.popular_years * 365), "first_air_date.lte": days_ago(0)})[:P.list_size]


def language_titles(code, sort="popularity.desc", since_days=P.popular_years * 365):
    films, shows = language_split(code, sort, since_days)
    return interleave(shows, films)


def genre_titles(genre_id, sort="popularity.desc", since_days=P.popular_years * 365, languages="en", kind=None):
    """A genre's films and series, alternating, or one [kind] only ("movie" or "tv": its own genre id)."""
    if kind == "movie":
        return discover("movie", with_genres=genre_id, sort_by=sort, with_original_language=languages, **{
            "primary_release_date.gte": days_ago(since_days), "vote_count.gte": P.genre_best_votes[0] if sort.startswith("vote_average") else P.genre_votes[0]})
    if kind == "tv":
        return discover("tv", with_genres=genre_id, sort_by=sort, with_original_language=languages, **{
            "first_air_date.gte": days_ago(since_days), "vote_count.gte": P.genre_best_votes[1] if sort.startswith("vote_average") else P.genre_votes[1]})
    tv_genre = {28: 10759, 12: 10759, 878: 10765, 14: 10765, 10752: 10768}.get(genre_id, genre_id)
    best = sort.startswith("vote_average")
    films = discover("movie", with_genres=genre_id, sort_by=sort, with_original_language=languages, **{
        "primary_release_date.gte": days_ago(since_days), "vote_count.gte": P.genre_best_votes[0] if best else P.genre_votes[0]})
    shows = discover("tv", with_genres=tv_genre, sort_by=sort, with_original_language=languages, **{
        "first_air_date.gte": days_ago(since_days), "vote_count.gte": P.genre_best_votes[1] if best else P.genre_votes[1]})
    return interleave(films, shows)


def new_releases(languages):
    """Films out digitally in the last ~2 months and series that premiered recently."""
    langs = "|".join(["en", *languages])
    films = discover("movie", with_original_language=langs, sort_by="popularity.desc", region=accounts.country(),
                     with_release_type="4|5", **{"release_date.gte": days_ago(P.new_release_days[0]), "vote_count.gte": P.new_release_votes[0]})
    shows = discover("tv", with_original_language=langs, sort_by="popularity.desc",
                     **{"first_air_date.gte": days_ago(P.new_release_days[1]), "vote_count.gte": P.new_release_votes[1]})
    return interleave(films, shows)


def coming_soon(languages):
    langs = "|".join(["en", *languages])
    films = discover("movie", with_original_language=langs, sort_by="popularity.desc", region=accounts.country(),
                     **{"primary_release_date.gte": days_ago(-1), "primary_release_date.lte": days_ago(-P.coming_soon_days)})
    shows = discover("tv", with_original_language=langs, sort_by="popularity.desc",
                     **{"first_air_date.gte": days_ago(-1), "first_air_date.lte": days_ago(-P.coming_soon_days)})
    return interleave(films, shows)


NETFLIX_TOP10 = "https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv"


def netflix_top10():
    """{country code: [(title, "Films"|"TV", rank)]} for the latest week of Netflix's public charts."""
    def fetch():
        req = Request(NETFLIX_TOP10, headers={"User-Agent": "Mozilla/5.0"})
        charts, latest = {}, ""
        with urlopen(req, timeout=S.advanced.timeouts.netflix_seconds, context=SSL_CONTEXT) as r:
            next(r)
            for line in r:
                fields = line.decode("utf-8", "replace").rstrip("\n").split("\t")
                # The file has the odd broken line (a title with a line break in it): skip those.
                if len(fields) < 6 or not fields[4].isdigit():
                    continue
                country, iso, week, category, rank, title, *_ = fields
                if week > latest:
                    latest, charts = week, {}
                if week == latest:
                    charts.setdefault(iso, []).append((title, category, int(rank)))
        log.info("Netflix Top 10 for week %s: %d countries", latest, len(charts))
        return charts
    return cached("netflix_top10", fetch, ttl=S.advanced.cache.netflix_top10_hours * 3600)


def tmdb_lookup(title, category):
    """A Netflix chart title -> (imdb id, type)."""
    def find():
        # (Netflix's TV chart has the odd one-off TMDB has as a film, e.g. a wrestling event or a short
        # documentary: looked for there when TMDB has no show by that name.)
        kinds = ["movie"] if category == "Films" else ["tv", "movie"]
        for kind in kinds:
            hits = (tmdb(f"/search/{kind}", query=title) or {}).get("results") or []
            if hits:
                tt = imdb_id_for(kind, hits[0]["id"])
                return (tt, "movie" if kind == "movie" else "series") if tt else None
        return None
    return cached(f"lookup:{category}:{title.lower()}", find, ttl=S.advanced.cache.netflix_lookup_days * 86400,
                  none_ttl=S.advanced.cache.no_match_hours * 3600)


def top10(country, category=None):
    """Ten titles from this week's chart in [country]: its shows ("TV") or films ("Films"), or both
    alternating (None)."""
    try:
        chart = sorted(netflix_top10().get(country) or [], key=lambda x: x[2])
    except Exception:
        log.exception("Netflix Top 10 unavailable; using TMDB trending")
        chart = []
    if not chart:
        # Still a ranked Top 10 (numbers and all), just from TMDB's weekly trending instead.
        found = [x for x in trending(30) if category is None or x[1] == ("series" if category == "TV" else "movie")]
        return [(tt, t, {"rank": i + 1}) for i, (tt, t, _) in enumerate(found[:10])]
    shows = [x for x in chart if x[1] == "TV" and category in (None, "TV")]
    films = [x for x in chart if x[1] == "Films" and category in (None, "Films")]
    with ThreadPoolExecutor(max_workers=8) as pool:
        found = list(pool.map(lambda x: tmdb_lookup(x[0], x[1]), interleave(shows, films)))
    rows, seen = [], set()
    for hit in found:
        if hit and hit[0] not in seen:
            seen.add(hit[0])
            rows.append(hit)
    return [(tt, t, {"rank": i + 1}) for i, (tt, t) in enumerate(rows[:10])]


def taste(library):
    """How much of the recent watching is in each language, genre and kind ("movie"/"tv"), recent
    watches counting more."""
    langs, genres, kinds = {}, {}, {}
    recent = library[:P.taste_titles]
    with ThreadPoolExecutor(max_workers=8) as pool:
        extras = list(pool.map(lambda m: title_extras(m["id"], m["type"]), recent))
    for i, (m, x) in enumerate(zip(recent, extras)):
        weight = P.taste_decay ** i
        if x.get("language"):
            langs[x["language"]] = langs.get(x["language"], 0) + weight
        kind = "movie" if m["type"] == "movie" else "tv"
        kinds[kind] = kinds.get(kind, 0) + weight
        for g in x.get("genres") or []:
            genres[g] = genres.get(g, 0) + weight
    total = sum(P.taste_decay ** i for i in range(len(recent))) or 1
    return tuple({k: v / total for k, v in d.items()} for d in (langs, genres, kinds))


def by_taste(pool, genre_taste):
    """Re-orders a popularity-sorted pool so titles in the genres you watch come first."""
    with ThreadPoolExecutor(max_workers=4) as ex:
        genres = list(ex.map(lambda r: title_extras(r[0], r[1]).get("genres") or [], pool))
    score = lambda i: (0.3 + sum(genre_taste.get(g, 0) for g in genres[i])) / (1 + i * 0.06)
    return [pool[i] for i in sorted(range(len(pool)), key=score, reverse=True)]


# ---------- Home's rows ----------

THEMES = tomllib.load(open(Path(__file__).with_name("themes.toml"), "rb"))["theme"]
LANGUAGE_NAMES = {**LANGUAGE_ROWS, "en": "English"}
H = S.advanced.home_rows


def theme_titles(theme, languages):
    """A themed row's titles (shared, cached as TMDB's lists are): in its language, or else in the
    profile's languages and English."""
    params = dict(theme["params"])
    if theme.get("lang"):
        params = {**language_filter(theme["lang"], theme["kind"]), **params}
    else:
        params.setdefault("with_original_language", "|".join(["en", *tmdb_languages(languages)]))
    params.setdefault("sort_by", "popularity.desc")
    return discover(theme["kind"], pages=2, wanted=with_poster, **params)


def theme_fit(theme, lang_taste, genre_taste, kind_taste):
    """How well a themed row fits what the profile watches."""
    g = sum(genre_taste.get(x, 0) for x in theme["genres"]) / len(theme["genres"]) ** 0.5
    lang = (lang_taste.get(tmdb_languages([theme["lang"]])[0], 0) + 0.05) if theme.get("lang") else 1
    return (0.03 + g) * (kind_taste.get(theme["kind"], 0) + 0.2) * lang


def latest_shows(code):
    """A language's latest shows (not English: see latest_rows), newest first among the popular: as
    far back as it takes for a full row (TMDB knows few shows of most languages, and in which
    country they stream for even fewer), reality
    and competition shows included (talk, news and documentaries aren't), daily serials left out."""
    # (One genre exclusion: the language's own, as Japanese leaves out animation, with Latest's.)
    lang = dict(language_filter(code, "tv"))
    leave_out = "|".join(filter(None, [lang.pop("without_genres", None), f"99|10402|10763|10767|{NOT_SHOWS}"]))
    found = []
    for days in H.latest_days:
        found = discover("tv", pages=P.language_pages, wanted=not_serials, sort_by="popularity.desc",
                         without_genres=leave_out, **lang,
                         **{"first_air_date.gte": days_ago(days), "first_air_date.lte": days_ago(0)})
        if len(found) >= P.list_size:
            break
    return found[:P.list_size]


def latest_rows(languages, lang_taste):
    """Latest shows and films in each of the profile's languages and English (anime as one row), the
    languages it watches most first: (id, title, titles)."""
    codes = sorted(dict.fromkeys([*languages, "en"]), key=lambda c: -lang_taste.get(tmdb_languages([c])[0], 0))
    out = []
    for code in codes:
        try:
            own = code not in ("en", ANIME)   # (its Latest shows from latest_shows, not language_split's)
            films, shows = language_split(code, since_days=NEW_DAYS, shows=not own)
            if own:
                shows = latest_shows(code)
        except Exception:
            log.exception("Latest rows for %s", code)
            continue
        if code == ANIME:
            out.append((f"latest:{code}", "Latest anime", interleave(shows, films)))
            continue
        name = LANGUAGE_NAMES.get(code, code.upper())
        out += [(f"latest:{code}:tv", f"Latest {name} shows", shows), (f"latest:{code}:movie", f"Latest {name} movies", films)]
    return out


ANILIST = "https://graphql.anilist.co"
# AniList's anime trending now and still airing (what anime watchers are watching this week; TMDB's
# popularity puts decades-long kids' shows on top).
ANILIST_TRENDING = ("query { Page(page: 1, perPage: 30) { media(type: ANIME, sort: TRENDING_DESC, isAdult: false, "
                    "status_in: [RELEASING]) { title { english romaji } format } } }")
# "Season 2", "2nd Season", "Part 2", "Cour 2", "Final Season…": AniList lists each season apart,
# TMDB has the show once.
SEASON = re.compile(r"[\s:-]*((\d+(st|nd|rd|th)\s+)?season(\s+\d+)?|part\s+\d+|cour\s+\d+|final\s+season.*)$", re.I)


def anime_title(title, fmt):
    """An AniList title -> (IMDb id, type) by TMDB's search: Japanese results first, the name without
    its season. Kept a month."""
    kind = "movie" if fmt == "MOVIE" else "tv"
    name = SEASON.sub("", title).strip()

    def find():
        for query in dict.fromkeys([name, name.split(":")[0].strip()]):
            hits = (tmdb(f"/search/{kind}", query=query) or {}).get("results") or []
            hit = next((h for h in hits if h.get("original_language") == "ja"), None)
            if hit:
                tt = imdb_id_for(kind, hit["id"])
                return [tt, "movie" if kind == "movie" else "series"] if tt else None
        return None
    found = cached(f"lookup:anime:{kind}:{name.lower()}", find, ttl=S.advanced.cache.netflix_lookup_days * 86400,
                   none_ttl=S.advanced.cache.no_match_hours * 3600)
    return tuple(found) if found else None


def top10_anime():
    """Ten anime airing now, ranked as AniList's trending has them; TMDB's most popular airing anime
    (not kids' or family ones) if AniList can't be reached."""
    def fetch():
        body = json.dumps({"query": ANILIST_TRENDING}).encode()
        req = Request(ANILIST, data=body, headers={"Content-Type": "application/json", "Accept": "application/json",
                                                     "User-Agent": "nightcap-server/1.0"})
        with urlopen(req, timeout=S.advanced.timeouts.http_seconds, context=SSL_CONTEXT) as r:
            media = json.load(r)["data"]["Page"]["media"]
        with ThreadPoolExecutor(max_workers=8) as pool:
            found = list(pool.map(lambda m: anime_title(m["title"]["english"] or m["title"]["romaji"], m["format"]), media))
        return [list(x) for x in dict.fromkeys(f for f in found if f)][:10]
    try:
        top = [tuple(x) for x in cached("anime_top:airing", fetch, ttl=H.anime_top_hours * 3600)]
    except Exception:
        log.exception("AniList unavailable; using TMDB for Top 10 anime")
        top = discover("tv", wanted=with_poster, with_original_language="ja", with_genres="16", without_genres="10762|10751",
                       sort_by="popularity.desc", **{"air_date.gte": days_ago(H.anime_airing_days), "air_date.lte": days_ago(0),
                                                     "vote_count.gte": H.anime_min_votes})[:10]
    return [(tt, t, {"rank": i + 1}) for i, (tt, t) in enumerate(top)]


# A page's genres (TMDB's for that kind), and which genres to leave out of its genre rows and picker:
# not stories (news, talk, reality and documentaries have their own rows), or kids' or soaps.
NOT_GENRE_ROWS = {10763, 10764, 10767, 99, 10762, 10766, 10770}


def page_genres(kind):
    """{id: name} of a page's genres (TMDB's list for films or series), ones that aren't stories left out."""
    from .titles import genre_lists
    return {g: n for g, n in genre_lists()["movie" if kind == "movie" else "tv"].items() if g not in NOT_GENRE_ROWS}


def genre_rows(kind, languages, genre_taste):
    """The Shows or Movies page's genre rows: the genres of that kind the profile watches most, each
    its popular titles in its languages and English ("Crime shows", "Comedy movies")."""
    names = page_genres(kind)
    langs = "|".join(["en", *tmdb_languages(languages)])
    picked = sorted((g for g in names if genre_taste.get(g, 0) > 0), key=lambda g: -genre_taste[g])[:H.genre_rows]
    noun = "shows" if kind == "tv" else "movies"
    return [(f"genre:{g}", f"{names[g]} {noun}", lambda g=g: [(tt, t, {}) for tt, t in daily_pick(
        by_taste(genre_titles(g, languages=langs, kind=kind), genre_taste), P.rotating_row_size, f"{kind}:{g}")])
            for g in picked]


def genre_tiles(kind, languages):
    """The Shows or Movies page's row of genres to pick from: each a tile opening that genre's page of
    that kind (Browse: popular, new, top rated), its picture the backdrop of its most popular title."""
    langs = "|".join(["en", *tmdb_languages(languages)])

    def tile(g, name):
        out = {"id": f"genre:{g}:{kind}", "name": name, "kind": "tile", "type": "tile"}
        try:
            first = genre_titles(g, languages=langs, kind=kind)[:1]
            if first:
                out["backdrop"] = title_extras(*first[0]).get("backdrop")
        except Exception:
            log.exception("Genre tile %s", g)
        return {k: v for k, v in out.items() if v}
    with ThreadPoolExecutor(max_workers=4) as pool:
        return list(pool.map(for_me(lambda gn: tile(*gn)), page_genres(kind).items()))


def watch_again_titles(profile):
    """Films and finished shows the profile loved or liked (or watched twice), to watch again."""
    rows = [r for r in store.watch_again(profile) if r["type"] == "movie" or finished_show(r["imdb_id"], profile)]
    return [(r["imdb_id"], r["type"]) for r in rows[:P.list_size]]


def first_home():
    """A profile's very first Home, answered at once (a full one can take most of a minute while
    titles are first looked up, longer than an app waits): Continue watching only, marked as being
    set up and stale, so the app asks for the full one in the background and shows it when it comes.
    Not saved: the refresh saves the full one."""
    try:
        items = continue_watching()
    except Exception:
        log.exception("Couldn't read Continue watching")
        items = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        cards = list(pool.map(for_me(lambda r: feed_item(r[0], r[1], **r[2])), items))
    return {"generated_at": int(time.time()), "featured": [], "widgets": widgets(),
            "rows": [{"id": "continue", "title": "Continue watching", "items": cards}] if cards else [],
            "building": True, "stale": True}


# Which row a title shown in several goes to (lowest first): see launcher_feed. (Not My List: its
# titles stay in the other rows too.)
CLAIMS = (("top10", 0), ("foryou", 2), ("because", 3), ("theme", 4), ("again", 5), ("latest:", 6),
          ("genre:", 7), ("t:", 7), ("soon", 8))


def row_claim(cid):
    return next((n for prefix, n in CLAIMS if cid.startswith(prefix)), 9)


def my_list_titles(profile):
    """The profile's My List as a row's titles, newest first."""
    return [(r["imdb_id"], r["type"]) for r in store.my_list(profile)]


def launcher_feed(page=None):
    """Home ([page] None), or the Shows ("tv") or Movies ("movie") page: featured, then rows of titles
    as Netflix's are (each title once on a page, nothing already watched), kinds of row taking turns.
    Home is the profile's own: Continue watching, its My List, its picks, Because you watched, Top 10s, its themed
    rows (the AI's, and those from themes.toml that fit it best), Watch again, Coming soon. The Shows
    and Movies pages have their own rows of that kind: a row of genres to pick from, the page's own
    picks and AI themes (none of Home's picks), its Because rows, Top 10 (and anime on Shows), the
    latest in each of the profile's languages and English, genre rows that fit it, the listed themes
    of that kind. Rows whose titles are mostly in rows above them are left out."""
    settings = home_settings()
    cache = recs() or {"catalogs": {}, "seeds": [], "themes": []}
    stats = row_stats()
    watched = set(cache.get("watched") or [])
    try:
        library = fetch_library()
    except Exception:
        log.exception("Couldn't read the library")
        library = []
    # Watched just now (marked from any row) counts too, and "Not interested" never shows.
    watched |= {m["id"] for m in library} | store.not_interested(me())
    lang_taste, genre_taste, kind_taste = taste(library)
    languages = settings["languages"]
    rng = random.Random(f"{time.strftime('%Y-%m-%d')}:{me()}")

    def personal(cid):
        return [(m["id"], m["type"], {"reason": split_reason(m)[0]}) for m in cache["catalogs"].get(cid, [])]

    def tried(fn, what):
        try:
            return fn()
        except Exception:
            log.exception("Couldn't build %s", what)
            return []

    # (On the Shows or Movies page, only that kind: "series" or "movie" as titles are typed.)
    kind = page
    of_kind = lambda items: [x for x in items if not kind or (x[1] == "movie") == (kind == "movie")]
    continue_row = of_kind(tried(continue_watching, "Continue watching"))
    country = settings["top10_countries"][0]
    where = COUNTRY_NAMES.get(country, country)
    seeds = cache.get("seeds") or []
    seed_kinds = cache.get("seed_kinds") or []
    because = [(f"because{i}", f"Because you watched {title_name(name)}", of_kind(personal(f"because{i}")))
               for i, name in enumerate(seeds) if not kind or (i < len(seed_kinds) and seed_kinds[i] == kind)]
    if kind:
        ai_themes = [(f"theme{i}", name, personal(f"{kind}:theme{i}"))
                     for i, name in enumerate((cache.get("page_themes") or {}).get(kind) or [])]
    else:
        ai_themes = [(f"theme{i}", name, personal(f"theme{i}")) for i, name in enumerate(cache.get("themes") or [])]
    # The themes that fit best today (a little different each day; ones long ignored come up less).
    usable = [t for t in THEMES if (not t.get("lang") or t["lang"] in languages) and (not kind or t["kind"] == kind)]
    row_key = (lambda cid: f"{kind}:{cid}") if kind else (lambda cid: cid)
    scored = sorted(usable, key=lambda t: -theme_fit(t, lang_taste, genre_taste, kind_taste)
                    * (0.2 if ignored(row_key(f"t:{t['id']}"), stats) else 1) * rng.uniform(0.8, 1.25))
    list_themes = [(f"t:{t['id']}", t["name"], lambda t=t: [(tt, ty, {}) for tt, ty in daily_pick(
        by_taste(theme_titles(t, languages), genre_taste), P.rotating_row_size, t["id"])])
        for t in scored[:H.page_list_themes if kind else H.list_themes]]
    top = [("top10:tv", f"Top 10 shows in {where}", lambda: top10(country, "TV")),
           ("top10:movie", f"Top 10 movies in {where}", lambda: top10(country, "Films")),
           ("top10:anime", "Top 10 anime airing now", top10_anime)]
    if kind:
        top = [r for r in top if r[0] == f"top10:{kind}" or (kind == "tv" and r[0] == "top10:anime")]
    # Latest (each language's newest) is the Shows and Movies pages': Home is the profile's own.
    latest = [] if not kind else [
        (cid, title, lambda items=items: [(tt, t, {}) for tt, t in items])
        for cid, title, items in tried(lambda: latest_rows(languages, lang_taste), "Latest rows")
        if cid.endswith(f":{kind}") or (cid == "latest:anime" and kind == "tv")]
    genres = genre_rows(kind, languages, genre_taste) if kind else []

    # The page's order: Netflix-like, kinds of row taking turns down the page.
    lazy = lambda rows: [(cid, title, fn) for cid, title, fn in rows]
    ready = lambda rows: [(cid, title, (lambda items=items: items)) for cid, title, items in rows]
    picks_key = f"{kind}:picks" if kind else "foryou"
    order = [("continue", "Continue watching", lambda: continue_row)]
    if not kind:
        order.append(("mylist", "My List", lambda: my_list_titles(me())))
    if kind:
        order.append(("genres", "Genres", lambda: genre_tiles(kind, languages)))
    order.append(("foryou", "Top picks for you", lambda: personal(picks_key)))
    queues = [ready(because), lazy(top), ready(ai_themes), lazy(latest), lazy(genres), lazy(list_themes)]
    while any(queues):
        for q in queues:
            if q:
                order.append(q.pop(0))
    if "anime" not in languages:
        order = [r for r in order if r[0] != "top10:anime"]
    order += [("again", "Watch again", lambda: of_kind(watch_again_titles(me()))),
              ("soon", "Coming soon", lambda: of_kind([(tt, t, {}) for tt, t in coming_soon(tmdb_languages(languages))]))]

    # The rows' titles, all at once (each list is shared and cached).
    # (A few at a time: a first Home's lookups shouldn't crowd out someone searching meanwhile.)
    with ThreadPoolExecutor(max_workers=H.build_workers) as pool:
        built = list(pool.map(for_me(lambda r: (r[0], r[1], tried(r[2], r[0]))), order))
    # (Titles as (id, type, extra); the genres row's are tiles, kept as they are.)
    built = [(cid, title, items if cid == "genres" else [x if len(x) == 3 else (*x, {}) for x in items])
             for cid, title, items in built]

    # Each title in one row only, nothing already watched or in progress. A title goes to the row that's
    # most the profile's own (row_claim), wherever that row is on the page: a Top 10 keeps its ranks,
    # then the profile's picks, its Because rows and the AI's themes, then Latest and the listed themes.
    # (My List is the profile's own choice: a show it has started stays on it, only not twice on the
    # page while it's in Continue watching. Its titles stay in the other rows too: putting one on it
    # changes nothing else on Home.)
    kept = {}
    in_progress = {tt for tt, _, _ in continue_row}
    used = set(watched) | in_progress
    for cid, title, items in sorted(built, key=lambda r: row_claim(r[0])):
        if cid in ("continue", "genres", "again") or cid.startswith("top10"):
            kept[cid] = items[:P.list_size]
        elif cid == "mylist":
            kept[cid] = [x for x in items if x[0] not in in_progress][:P.list_size]
        else:
            kept[cid] = [x for x in items if x[0] not in used][:P.list_size]
        if cid not in ("continue", "genres", "mylist"):
            used |= {x[0] for x in kept[cid]}
    rows_out = [(cid, title, kept[cid]) for cid, title, _ in built
                if kept[cid] and (cid in ("continue", "mylist")
                                  or len(kept[cid]) >= (1 if cid.startswith("top10") or cid == "genres" else H.min_titles))]
    # At most [home] rows: the least personal go first (the listed themes, then Latest rows, from the
    # bottom of the page up), never Continue watching, My List, Watch again or Coming soon.
    while len(rows_out) > (S.home.page_rows if kind else S.home.rows):
        droppable = [i for i, r in enumerate(rows_out) if r[0].startswith(("t:", "latest:", "genre:", "theme"))]
        if not droppable:
            break
        rows_out.pop(max(droppable, key=lambda i: (row_claim(rows_out[i][0]), i)))

    with ThreadPoolExecutor(max_workers=H.build_workers * 2) as pool:
        rows = [{"id": row_key(cid), "title": title,
                 **({"style": "ranked"} if cid.startswith("top10") else {"style": "tiles"} if cid == "genres" else {}),
                 # (As this profile: its audio language picks the trailers.) The genres row's are tiles already.
                 "items": items if cid == "genres" else list(pool.map(for_me(lambda r: feed_item(r[0], r[1], **r[2])), items))}
                for cid, title, items in rows_out]
    # (A page's rows are kept apart from Home's: each its own streak of days shown.)
    note_rows_shown([r["id"] for r in rows], page)

    # Featured: new episodes of your shows, a couple of your picks, the latest in your languages.
    by_row = {r["id"]: r["items"] for r in rows}
    fresh_eps = [dict(i, label=f"{i['newEpisodes']} new episode{'s' if i['newEpisodes'] > 1 else ''}")
                 for i in by_row.get(row_key("continue"), []) if i.get("newEpisodes")]
    picks = [dict(i, label="Picked for you") for i in by_row.get(row_key("foryou"), []) if i.get("trailer")]
    newest = [dict(i, label="New") for r in rows if r["id"].startswith(row_key("latest:")) for i in r["items"][:3] if i.get("trailer")]
    if not kind:
        newest = [dict(i, label="Top 10") for r in rows if r["id"].startswith("top10") for i in r["items"][:3] if i.get("trailer")]
    featured = interleave(fresh_eps[:2], daily_pick(picks, 2, "featured-picks"),
                          daily_pick(newest, 3, "featured-new"))[:settings["featured"]]

    return {
        "generated_at": int(time.time()),
        "featured": featured,
        "rows": rows,
        "widgets": widgets(),
    }


def warm_browse_pages(keys):
    """Builds the Browse pages for [keys] ahead of time (asked for by the TV after Home), so opening
    a tile is instant."""
    for key in keys:
        try:
            cached(f"browse:{key}", lambda: browse_page(key), ttl=S.advanced.cache.browse_hours * 3600)
        except Exception:
            log.exception("Warming Browse page %s", key)


def browse_page(key):
    """A Browse tile's page: a language, a genre, another country's Top 10, or Coming soon."""
    settings = home_settings()
    kind, _, arg = key.partition(":")
    if kind == "lang":
        name = LANGUAGE_ROWS.get(arg, arg.upper())
        kinds = (("new", "New", {"since_days": NEW_DAYS}), ("popular", "Popular", {}),
                 ("best", "Highly rated", {"sort": "vote_average.desc", "since_days": P.best_years * 365}))
        # (All at once: a cold page asks TMDB about each series, so one after another is slow.)
        with ThreadPoolExecutor(max_workers=4) as pool:
            splits = [pool.submit(for_me(lambda kw=kw: language_split(arg, **kw))) for _, _, kw in kinds]
            reality = pool.submit(for_me(lambda: reality_titles(arg))) if arg != ANIME else None
            sections = []
            for (sid, title, _), split in zip(kinds, splits):
                films, shows = split.result()
                sections += [(f"{sid}-films", f"{title} films", films), (f"{sid}-series", f"{title} series", shows)]
            if reality:
                sections.append(("reality", "Reality & talk shows", reality.result()))
    elif kind == "genre" and arg.split(":")[0].isdigit():
        # genre:80 (films and series), or genre:80:tv / genre:28:movie (the Shows or Movies page's).
        gid, _, only = arg.partition(":")
        only = only if only in ("tv", "movie") else None
        name = genre_names().get(int(gid), "Genre") + {"tv": " shows", "movie": " movies"}.get(only, "")
        langs = "|".join(["en", *tmdb_languages(settings["languages"])])
        sections = [("popular", "Popular", genre_titles(int(gid), languages=langs, kind=only)),
                    ("new", "New", genre_titles(int(gid), since_days=NEW_DAYS, languages=langs, kind=only)),
                    ("best", "Highly rated", genre_titles(int(gid), sort="vote_average.desc", since_days=P.best_years * 365,
                                                          languages=langs, kind=only))]
    elif kind == "top10":
        name = f"Top 10 in {COUNTRY_NAMES.get(arg, arg)}"
        sections = [("top10", "This week", [(tt, t) for tt, t, _ in top10(arg)])]
    elif kind == "soon":
        name = "Coming soon"
        sections = [("soon", "Coming soon", coming_soon(tmdb_languages(settings["languages"])))]
    else:
        return None
    with ThreadPoolExecutor(max_workers=12) as pool:
        out = []
        for sid, title, items in sections:
            cards = list(pool.map(lambda r: feed_item(r[0], r[1]), items[:P.list_size]))
            if kind == "top10":
                cards = [dict(c, rank=i + 1) for i, c in enumerate(cards)]
            out.append({"id": sid, "title": title, "kind": "posters", "items": [
                {k: c.get(k) for k in ("id", "type", "name", "year", "rating", "poster", "backdrop", "overview", "rank")
                 if c.get(k)} for c in cards]})
    first = next((c for sec in out for c in sec["items"] if c.get("backdrop")), {})
    return {"header": {"id": key, "type": "browse", "name": name, "facts": "", "overview": "",
                       "backdrop": first.get("backdrop")},
            "sections": [s for s in out if s["items"]], "focus": None}


def browse_for_me(page, key):
    """A (shared, cached) Browse page for this profile: without what it has watched or isn't
    interested in, and on a language page, a last row of its own favourites to watch again."""
    profile = me()
    skip = store.not_interested(me()) | store.watched_ids(profile)
    sections = [{**sec, "items": [i for i in sec["items"] if i["id"] not in skip]} for sec in page["sections"]]
    kind, _, code = key.partition(":")
    if kind == "lang":
        again = [r for r in store.watch_again(profile) if in_language_row(r, code)
                 and (r["type"] == "movie" or finished_show(r["imdb_id"], profile))][:P.list_size]
        if again:
            with ThreadPoolExecutor(max_workers=8) as pool:
                cards = list(pool.map(lambda r: feed_item(r["imdb_id"], r["type"]), again))
            sections.append({"id": "again", "title": "Watch again", "kind": "posters", "items": [
                {k: c.get(k) for k in ("id", "type", "name", "year", "rating", "poster", "backdrop", "overview")
                 if c.get(k)} for c in cards]})
    return {**page, "sections": [sec for sec in sections if sec["items"]]}


def finished_show(imdb_id, profile):
    """Whether a show is over and every episode is watched: nothing listed still to come."""
    videos = [v for v in cinemeta("series", imdb_id).get("videos") or [] if (v.get("season") or 0) > 0 and v.get("id")]
    if not videos or any(not is_out(v) for v in videos):
        return False
    return {v["id"] for v in videos} <= store.ticks(profile, imdb_id)
