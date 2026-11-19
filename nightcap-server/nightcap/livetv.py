"""Live TV: channels from the household's own channel lists (M3U playlists), shown as rows like Home's.

The household's admin adds a list's address (Settings); the server reads it, and every profile gets:
- the Live TV page: the channel this profile watched last, "My channels" (its favourites), then a row
  per kind of channel (News, Music…), only channels from the places the household picked;
- Browse all: every channel, with filters (kind, country, language) and a search.

A list's address and its channels' stream addresses are the household's secrets (a paid list carries
its account in them): kept encrypted (like the add-ons, see sources.py), never in a log or an error,
and never sent to the apps. A device plays a channel through a playback link (playlinks.py), as it
plays a title. The apps get a channel's id, name, logo and kind.

A list is read when it's added, then again when someone opens Live TV and it's older than
S.livetv.refresh_hours (no job runs to keep it fresh). The same channel in several qualities or
lists ("DW News (720p)", "DW News HD") is one channel, its streams tried best first.

A channel that fails to play S.livetv.fails_to_hide times in a row on a device is hidden on that
device (a channel blocked where one TV is may play on another, elsewhere), then shown again after
S.livetv.hidden_days, needing as many failures again to be hidden; one that plays is back at once.

A list may say more about its items (a household's own list: its matches, family videos, cameras).
There's no standard for these, so each is a role (ROLES) that a list's settings map to the attribute
its list uses (Settings › the list › Advanced); unmapped, a role reads its default attribute:
- row (x-row="Cricket"): the item is in a row of that name, at the top of the page (rows in the
  list's order), whatever the household's places;
- start / end (x-start, x-end: ISO times, with their offset, or epoch seconds or ms; without an
  offset, the household's timezone): upcoming before its start (shown, not played), live until its
  end, then left out; no times: 24/7;
- status (x-status: live, upcoming, 24/7): said instead of what the times say (a match running late);
- about (x-about): a line under its name; id (x-id): the item's own id, kept when its name changes;
- group (x-event-id) and channel (x-channel): items of one event, each a channel of it;
- country and language (tvg-country, tvg-language): the channel's countries and languages, which
  the household's places and the filters go by;
- kind (group-title, or #EXTGRP when that's the tag): the channel's category.
One tag may play several roles, and a role set to "-" (NO_FIELD) reads nothing: a list whose
group-title says each channel's country, not its category, has country "group-title" and kind "-".
An optional extension (nightcap/private/, not in the repository) may say how some items' streams are
opened: it reads that from the list, and the device that plays one gets it at play time. Without it,
such items are left out. Like the lists themselves, it's for streams the household has the right to
watch.

How often a list is read again: what its settings say, else S.livetv.refresh_hours (at least
S.livetv.min_refresh_hours).
"""

import hashlib
import json
import logging
import re
import threading
import time
import zlib
from datetime import datetime
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from . import playlinks, store
from .config import DEFAULT_COUNTRY, DEFAULT_TIMEZONE, S
from .context import me
from .errors import NotFound
from .http import get_text
from .livetv_places import COUNTRIES, INTERNATIONAL, LANGUAGES, country_code, language_code

try:
    from .private import livetv_extension as extension      # (optional: see above)
except ImportError:
    extension = None

log = logging.getLogger(__name__)

L = S.livetv
LIST_TIMEOUT_S = S.advanced.timeouts.livetv_list_seconds
STREAMS_KEPT = 5            # a channel's streams kept, best first
MEMORY_S = 300              # the household's channels kept in memory this long (then loaded again: another copy of the server may have read the lists again)

# ---------- Reading a list ----------

_ATTR = re.compile(r'([A-Za-z0-9_-]+)=(?:"([^"]*)"|\'([^\']*)\'|([^\s,"\']+))')
_RESOLUTION = re.compile(r"\((\d{3,4})p\)", re.I)
_TAGS = re.compile(r"\s*\[[^\]]*\]")      # [Geo-blocked], [Not 24/7]
_QUALITY = re.compile(r"\s*\(\d{3,4}p\)|\s+(?:FHD|UHD|HD|SD|4K|HEVC|H265)\b", re.I)
_ID_COUNTRY = re.compile(r"\.([a-z]{2})(?:@|$)")


class NotAList(ValueError):
    """What was read isn't a channel list (or has no channel in it)."""


def parse(text, tz=None, fields=None):
    """The channels in an M3U list, as written there: [{"name", "url", "logo", "group", "countries",
    "languages", "tvgId", "height", "limited", "x"}] ("x": the item's own fields by role, see above,
    read from the attributes [fields] maps them to; its times as epoch seconds, ones without an offset
    in [tz]). Raises NotAList when it isn't one."""
    mapping = roles_for(fields)
    lines = text.lstrip("﻿").splitlines()
    if not lines or not lines[0].strip().upper().startswith("#EXTM3U"):
        raise NotAList("That isn't a channel list (an M3U file starts with #EXTM3U)")
    found, info, group = [], None, None
    for raw in lines[1:]:
        line = raw.strip()
        if not line:
            continue
        if line.upper().startswith("#EXTINF"):
            info, group = _extinf(line, mapping), None
        elif line.upper().startswith("#EXTGRP:"):
            group = line[8:].strip()
        elif line.startswith("#"):
            continue            # #EXTVLCOPT, #KODIPROP, comments
        elif info is not None:
            p = urlparse(line)
            if p.scheme in ("http", "https") and p.hostname and len(line) <= 2000:
                x = info["x"]
                for field in ("start", "end"):
                    if field in x:
                        x[field] = _epoch(x[field], tz)
                # #EXTGRP is group-title's other way of saying it: only read when that's the kind's tag.
                found.append({**info, "url": line,
                              "group": info["group"] or (group if mapping["kind"] == ROLES["kind"] else None)})
            info, group = None, None
            if len(found) >= L.max_channels:
                break
    if not found:
        raise NotAList("There's no channel in that list")
    return found


def _extinf(line, mapping=None):
    """One #EXTINF line: its attributes, and the channel's name (after the first comma outside quotes,
    so a name may have commas of its own). [mapping]: role -> attribute (roles_for())."""
    head, name, quoted = line, "", None
    for i, c in enumerate(line):
        if quoted:
            quoted = None if c == quoted else quoted
        elif c in "\"'":
            quoted = c
        elif c == ",":
            head, name = line[:i], line[i + 1:]
            break
    attrs = _attributes(head)
    name = (name.strip() or attrs.get("tvg-name") or "").strip()
    tvg_id = (attrs.get("tvg-id") or "").strip()
    mapping = mapping or ROLES
    countries = [c for c in (country_code(x) for x in re.split(r"[;,|]", attrs.get(mapping["country"]) or "")) if c]
    id_country = (m := _ID_COUNTRY.search(tvg_id.lower())) and country_code(m.group(1))
    if not countries and id_country:
        countries = [id_country]
    languages = [c for c in (language_code(x) for x in re.split(r"[;,|]", attrs.get(mapping["language"]) or "")) if c]
    height = _RESOLUTION.search(name)
    logo = (attrs.get("tvg-logo") or "").strip()
    opened = {"how": extension.FIELD} if extension else {}
    x = {role: " ".join(attrs[a].split())[:200] for role, a in {**mapping, **opened}.items()
         if role not in _CHANNEL_ROLES and (attrs.get(a) or "").strip()}
    if x.get("status") not in (None, *STATES):
        x.pop("status")
    return {"name": name[:120], "tvgId": tvg_id[:120], "idCountry": id_country or None,
            "logo": logo if urlparse(logo).scheme == "https" and len(logo) <= 1000 else None,
            "group": (attrs.get(mapping["kind"]) or "").strip() or None,
            "countries": list(dict.fromkeys(countries)), "languages": list(dict.fromkeys(languages)),
            "height": int(height.group(1)) if height else None,
            "limited": bool(re.search(r"\[(geo-blocked|not 24/7)\]", name, re.I)), "x": x}


def _attributes(head):
    """An #EXTINF line's attributes (before its name), their names in lower case."""
    return {m.group(1).lower(): m.group(2) if m.group(2) is not None else m.group(3) if m.group(3) is not None else m.group(4)
            for m in _ATTR.finditer(head)}


# The roles an item's own fields play, and the attribute each reads unless the list's settings say another.
ROLES = {"row": "x-row", "start": "x-start", "end": "x-end", "status": "x-status", "about": "x-about",
         "id": "x-id", "group": "x-event-id", "channel": "x-channel",
         "country": "tvg-country", "language": "tvg-language", "kind": "group-title"}
ROLE_NAMES = {"row": "Row", "start": "Starts", "end": "Ends", "status": "Live, upcoming or 24/7",
              "about": "Line under the name", "id": "Its own id", "group": "Group into one card",
              "channel": "Channel name in a group", "country": "Country", "language": "Language",
              "kind": "Category"}
# Read into what every channel has (its countries, languages, kind), not into an item's own fields.
_CHANNEL_ROLES = ("country", "language", "kind")
NO_FIELD = "-"          # a role a list's settings say it doesn't have (no attribute has this name)
_FIELD_NAME = re.compile(r"^[a-z0-9_-]{1,60}$")
LIVE, UPCOMING, ALWAYS, ENDED = "live", "upcoming", "24/7", "ended"
STATES = (LIVE, UPCOMING, ALWAYS)


def roles_for(fields):
    """Role -> attribute for a list: its settings' [fields] over the defaults."""
    return {**ROLES, **{r: a.lower() for r, a in (fields or {}).items() if r in ROLES and a}}


def field_names(text, most=60):
    """The attributes a list's items have, most used first: [{"name", "count"}] (names only, never
    a value: Settings offers them to map roles to)."""
    counts = {}
    for raw in text.lstrip("\ufeff").splitlines():
        if raw.lstrip().upper().startswith("#EXTINF"):
            for name in _attributes(_head(raw)):
                counts[name] = counts.get(name, 0) + 1
    return [{"name": n, "count": c} for n, c in sorted(counts.items(), key=lambda x: (-x[1], x[0]))[:most]]


def _head(line):
    """An #EXTINF line up to its name (the first comma outside quotes)."""
    quoted = None
    for i, c in enumerate(line):
        if quoted:
            quoted = None if c == quoted else quoted
        elif c in "\"'":
            quoted = c
        elif c == ",":
            return line[:i]
    return line


def _epoch(value, tz):
    """A time as epoch seconds: ISO (one without an offset: in [tz]), or epoch seconds or ms; None if
    it isn't one."""
    v = value.strip()
    if v.isdigit():
        n = int(v)
        return n // 1000 if n > 10 ** 11 else n
    try:
        t = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if t.tzinfo is None:
            t = t.replace(tzinfo=ZoneInfo(tz or DEFAULT_TIMEZONE))
        return int(t.timestamp())
    except (ValueError, KeyError):
        return None


# ---------- Kinds of channel ----------

KINDS = {"news": "News", "sports": "Sports", "movies": "Movies", "music": "Music", "kids": "Kids",
         "entertainment": "Entertainment", "series": "Series", "documentary": "Documentary", "religious": "Religious",
         "business": "Business", "education": "Education", "comedy": "Comedy", "lifestyle": "Lifestyle",
         "cooking": "Cooking", "travel": "Travel", "science": "Science", "culture": "Culture", "classic": "Classic",
         "weather": "Weather", "legislative": "Legislative", "shop": "Shopping", "outdoor": "Outdoor", "auto": "Auto",
         "family": "Family", "general": "General"}
_KIND_ALIASES = {"sport": "sports", "film": "movies", "films": "movies", "movie": "movies", "cinema": "movies",
                 "children": "kids", "kid": "kids", "cartoon": "kids", "cartoons": "kids", "animation": "kids",
                 "documentaries": "documentary", "docs": "documentary", "religion": "religious", "shopping": "shop",
                 "food": "cooking", "tv shows": "series", "shows": "series", "economy": "business",
                 "finance": "business", "cars": "auto", "radio": "music"}
OTHER = "other"
# Last on the page: they say little about a channel.
_LAST = ("general", OTHER)


def kind_of(group):
    """A list's group ("News;General") as one kind id: a known one, else the group's own name
    (lower case), else "other"."""
    for part in re.split(r"[;|/]", group or ""):
        g = part.strip().lower()
        if not g or g in ("undefined", "uncategorized", "uncategorised", "other", "others", "general"):
            continue
        g = _KIND_ALIASES.get(g, g)
        return g if g in KINDS else re.sub(r"\s+", " ", g)[:30]
    return "general" if re.search(r"general", group or "", re.I) else OTHER


def kind_name(kind):
    return KINDS.get(kind) or ("Other" if kind == OTHER else kind.title())


# ---------- One channel from all its lines ----------

def clean_name(name):
    """A channel's name as shown: its list's notes and quality taken out ("DW News (720p) [Geo-blocked]": "DW News")."""
    return _QUALITY.sub("", _TAGS.sub("", name)).strip(" -|") or name.strip()


def _same(name):
    """What two lines for the same channel share: the name without quality, case or punctuation."""
    return re.sub(r"[^0-9a-zÀ-￿]+", "", clean_name(name).lower())


def monogram(name):
    """What the tile shows without a logo: the name's own short form ("DW News": "DW"), else its
    initials ("Al Jazeera English": "AJE", "France 24": "F24")."""
    words = [w for w in re.split(r"[\s\-_/.:&+]+", name) if w]
    if not words:
        return "TV"
    if re.fullmatch(r"[A-Z0-9]{2,4}", words[0]):
        return words[0]
    if len(words) == 1:
        return words[0][:3].upper()
    out = ""
    for w in words[:3]:
        out += w if w.isdigit() else w[0].upper()
    return out[:4]


def merge(lines):
    """[lines] (parse(), from every list in turn) as channels, the same one in several lines once:
    {"id", "name", "logo", "mono", "hue", "kind", "countries", "languages", "streams": [url…]}, in the
    order they first appear."""
    channels = {}
    for line in lines:
        same = _same(line["name"])
        if not same:
            continue
        x = line.get("x") or {}
        # Where it's from, for which lines are the same channel: its tvg-id's country first, the same in
        # every line of it (a list by country has a channel once per country it's in).
        where = line.get("idCountry") or (line["countries"][0] if line["countries"] else INTERNATIONAL)
        # An item with its own id is itself (two matches of the same name are two), whatever its name.
        cid = hashlib.sha256((f"x:{x['id']}" if x.get("id") else f"{same}|{where}").encode()).hexdigest()[:12]
        ch = channels.get(cid)
        if ch is None:
            name = clean_name(line["name"]) if not x else " ".join(line["name"].split())
            ch = channels[cid] = {"id": cid, "name": name, "logo": line["logo"], "mono": monogram(name),
                                  "hue": int(cid[:4], 16) % 360, "kind": kind_of(line["group"]),
                                  "countries": list(line["countries"]), "languages": list(line["languages"]),
                                  **{k: x[k] for k in ("row", "start", "end", "status", "about", "group", "channel") if x.get(k) is not None},
                                  "_streams": []}
        else:
            ch["logo"] = ch["logo"] or line["logo"]
            if ch["kind"] in _LAST:
                ch["kind"] = kind_of(line["group"])
            ch["countries"] = list(dict.fromkeys(ch["countries"] + line["countries"]))
            ch["languages"] = list(dict.fromkeys(ch["languages"] + line["languages"]))
        ch["_streams"].append(line)
    for ch in channels.values():
        # Best first: one that's always on and everywhere, then the sharpest (unsaid: as a 720p one), then
        # in the lists' order.
        best = sorted(enumerate(ch.pop("_streams")), key=lambda x: (x[1]["limited"], -(x[1]["height"] or 720), x[0]))
        # (One the extension says how to open: {"u", "r"}.)
        streams = {s["url"]: {"u": s["url"], "r": s["x"]["how"]} if (s.get("x") or {}).get("how") else s["url"]
                   for _, s in best}
        ch["streams"] = list(streams.values())[:STREAMS_KEPT]
    return list(channels.values())


# ---------- The household's lists ----------

def _list_id(url):
    return hashlib.sha256(url.encode()).hexdigest()[:12]


def _masked(url):
    """https://host/…a1b2: enough to tell lists apart, never the whole address."""
    p = urlparse(url)
    tail = re.sub(r"\W", "", p.path + (p.query or ""))[-4:]
    return f"{p.scheme}://{p.hostname}/…{tail}" if tail else f"{p.scheme}://{p.hostname}/"


def check_url(url):
    url = (url or "").strip()
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname or len(url) > 2000:
        raise ValueError("That isn't a channel list's address (it starts with https://)")
    return url


_memory = {}                  # account -> (when, channels): the cards only, no stream addresses
_reading = set()              # list ids being read again in the background
_lock = threading.Lock()


def forget(account):
    """The household's channels as kept in memory are read again (its lists changed)."""
    _memory.pop(str(account), None)


def _sweep():
    """Households not using Live TV lately: their channels leave memory."""
    now = time.monotonic()
    for k, (at, _) in list(_memory.items()):
        if now - at >= MEMORY_S:
            _memory.pop(k, None)


def _pack(value):
    return zlib.compress(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(), 6)


def _unpack(blob):
    return json.loads(zlib.decompress(bytes(blob)))


def _read(url, tz=None, fields=None):
    """The list at [url], its items' roles read as [fields] maps them: (its lines, what the extension
    read from it, the attributes its items have). Errors say what went wrong, never the address. Items
    the extension would open but can't (or, without it, none of them) are left out."""
    try:
        text = get_text(url, most=L.max_list_bytes, timeout=LIST_TIMEOUT_S)
    except ValueError:
        raise
    except Exception as e:
        log.info("A channel list didn't answer: %s", type(e).__name__)
        raise ValueError("The list didn't answer: check its address, or try again later")
    how = extension.read(text) if extension else {}
    lines = [x for x in parse(text, tz, fields) if (x.get("x") or {}).get("how") in (None, *how)]
    if not lines:
        raise NotAList("There's no channel in that list")
    return lines, how, field_names(text)


def _read_and_keep(account, url, saved=True, fields=None):
    """Reads [url], merges its lines into channels (the costly part, done here once a day, not as Live TV
    opens) and keeps them: the cards, and apart from them the streams, which are only unlocked to play.
    Returns the cards. A read that fails is noted for a [saved] list (Settings says why); for one being
    added, nothing is kept. [fields]: the list's mapping of roles (its settings)."""
    lid = _list_id(url)
    try:
        lines, how, found = _read(url, _account_settings(account).get("timezone"), fields)
        merged = merge(lines)
    except ValueError as e:
        if saved:
            store.livetv_list_failed(account, lid, str(e))
        raise
    streams = {c["id"]: c.pop("streams") for c in merged}
    kept = {"v": 2, "streams": streams, "how": how} if how else streams
    store.save_livetv_list(account, lid, _pack(merged), _pack(kept), len(merged), found)
    forget(account)
    return merged


def _read_later(account, url, fields=None):
    """Reads [url] again in the background (once at a time): Live TV opens with what's kept meanwhile."""
    lid = _list_id(url)
    with _lock:
        if lid in _reading:
            return
        _reading.add(lid)

    def run():
        try:
            _read_and_keep(account, url, fields=fields)
        except Exception:
            log.info("A channel list couldn't be read again; its last copy stays")
        finally:
            with _lock:
                _reading.discard(lid)
    threading.Thread(target=run, daemon=True).start()


def _lists(account):
    return store.secrets(account).get("livetv_urls") or []


def _combine(card_lists):
    """Several lists' cards as one: a channel in more than one list is one card."""
    out = {}
    for cards in card_lists:
        for c in cards:
            have = out.get(c["id"])
            if have is None:
                out[c["id"]] = c
                continue
            have["logo"] = have["logo"] or c["logo"]
            if have["kind"] in _LAST:
                have["kind"] = c["kind"]
            have["countries"] = list(dict.fromkeys(have["countries"] + c["countries"]))
            have["languages"] = list(dict.fromkeys(have["languages"] + c["languages"]))
            for k in ("row", "start", "end", "status", "about", "group", "channel"):
                if k in c and k not in have:
                    have[k] = c[k]
    return list(out.values())


def channels(account):
    """Every channel in the household's lists (their cards: no stream addresses), each list read first
    if it never was, or again in the background if it's old."""
    _sweep()
    hit = _memory.get(str(account))
    if hit:
        return hit[1]
    kept = {r["list_id"]: r for r in store.livetv_lists(account)}
    found = []
    for entry in _lists(account):
        url = entry["url"]
        row = kept.get(_list_id(url))
        if row is None:
            # Never read here (a household brought from another server, say): read now.
            try:
                found.append(_read_and_keep(account, url, fields=entry.get("fields")))
            except ValueError:
                pass
            continue
        # (A list whose last read failed is tried again as often as one that worked is read again.)
        if row["read_at"] is None or time.time() - row["read_at"].timestamp() > every_hours(entry) * 3600:
            _read_later(account, url, entry.get("fields"))
        if row["cards"] is not None:
            found.append(_unpack(row["cards"]))
    every = _combine(found)
    _memory[str(account)] = (time.monotonic(), every)
    return every


def every_hours(entry):
    """How often a list is read again: its settings, else the default."""
    hours = entry["refresh_minutes"] / 60 if entry.get("refresh_minutes") else L.refresh_hours
    return max(L.min_refresh_hours, hours)


def _streams(account, channel_id):
    """A channel's streams, best first, from each list that has it (in the lists' order): [(address,
    what the extension needs to open it, or None)]."""
    order = [_list_id(e["url"]) for e in _lists(account)]
    rows = {r["list_id"]: r["streams"] for r in store.livetv_streams(account)}
    found = {}
    for lid in order:
        if rows.get(lid) is None:
            continue
        kept = _unpack(rows[lid])
        streams, how = (kept["streams"], kept.get("how") or {}) if kept.get("v") == 2 else (kept, {})
        for s in streams.get(channel_id) or []:
            if isinstance(s, str):
                found.setdefault(s, None)
            elif s.get("r") in how:
                found.setdefault(s["u"], how[s["r"]])
    return list(found.items())[:STREAMS_KEPT]


def overview(account, device):
    """What Settings shows: the lists (masked), the places, and what can be picked for them."""
    kept = {r["list_id"]: r for r in store.livetv_lists(account, cards=False)}
    lists = []
    for entry in _lists(account):
        row = kept.get(_list_id(entry["url"])) or {}
        lists.append({"id": _list_id(entry["url"]), "name": entry.get("name"), "address": _masked(entry["url"]),
                      "channels": row.get("count") or 0,
                      "readAt": row["read_at"].isoformat() if row.get("read_at") else None,
                      "error": row.get("error"),
                      # Advanced: how often it's read again, and which of its attributes play which role.
                      "refreshMinutes": entry.get("refresh_minutes"),
                      "everyMinutes": round(every_hours(entry) * 60),
                      "fields": roles_for(entry.get("fields")), "fieldsSet": sorted((entry.get("fields") or {}).keys()),
                      "fieldsFound": row.get("fields") or []})
    every = channels(account)
    hidden = _hidden(account, device)
    p = places(account)
    return {"lists": lists, "maxLists": L.max_lists, "places": p, "hidden": sum(c["id"] in hidden for c in every),
            "languagesSaid": languages_said(_in_countries(every, p["countries"])), "options": _options(every, every),
            "roles": [{"id": r, "name": ROLE_NAMES[r], "default": a} for r, a in ROLES.items()],
            "refreshChoices": list(L.refresh_choices_minutes), "defaultRefreshMinutes": round(L.refresh_hours * 60)}


def add_list(account, url, name=None):
    url = check_url(url)
    s = store.secrets(account)
    have = s.get("livetv_urls") or []
    if any(e["url"] == url for e in have):
        raise ValueError("That list is here already")
    if len(have) >= L.max_lists:
        raise ValueError(f"A household has at most {L.max_lists} channel lists: remove one first")
    name = " ".join((name or "").split())[:S.names.device] or urlparse(url).hostname
    _read_and_keep(account, url, saved=False)      # (refused, with nothing saved, if it isn't a list)
    store.save_secrets(account, {**s, "livetv_urls": have + [{"url": url, "name": name}]}, only={"livetv_urls"})
    forget(account)


def remove_list(account, list_id):
    s = store.secrets(account)
    have = s.get("livetv_urls") or []
    left = [e for e in have if _list_id(e["url"]) != list_id]
    if len(left) == len(have):
        raise NotFound("No such channel list")
    store.save_secrets(account, {**s, "livetv_urls": left}, only={"livetv_urls"})
    store.remove_livetv_list(account, list_id)
    forget(account)


def read_again(account, list_id):
    """Reads a list again now (Settings' "Check now")."""
    for e in _lists(account):
        if _list_id(e["url"]) == list_id:
            _read_and_keep(account, e["url"], fields=e.get("fields"))
            return
    raise NotFound("No such channel list")


def set_list_settings(account, list_id, refresh_minutes=None, fields=None):
    """A list's Advanced settings: how often it's read again ([refresh_minutes], one of
    S.livetv.refresh_choices_minutes; None: the default) and which attribute
    plays each role ([fields]: role -> attribute name; a role left out, or empty, reads its default).
    A changed mapping reads the list again now, so the page shows it at once."""
    if refresh_minutes is not None and refresh_minutes not in L.refresh_choices_minutes:
        raise ValueError("Pick one of the times offered")
    clean = {}
    for role, name in (fields or {}).items():
        if role not in ROLES:
            raise ValueError(f"There's no role called {role[:30]}")
        name = (name or "").strip().lower()
        if not name or name == ROLES[role]:
            continue
        if name != NO_FIELD and not _FIELD_NAME.match(name):
            raise ValueError("A field's name has letters, digits, - and _ only")
        clean[role] = name
    s = store.secrets(account)
    have = s.get("livetv_urls") or []
    entry = next((e for e in have if _list_id(e["url"]) == list_id), None)
    if entry is None:
        raise NotFound("No such channel list")
    changed = clean != (entry.get("fields") or {})
    entry = {k: v for k, v in entry.items() if k not in ("refresh_minutes", "fields")}
    if refresh_minutes is not None:
        entry["refresh_minutes"] = refresh_minutes
    if clean:
        entry["fields"] = clean
    store.save_secrets(account, {**s, "livetv_urls": [entry if _list_id(e["url"]) == list_id else e for e in have]}, only={"livetv_urls"})
    forget(account)
    if changed:
        _read_and_keep(account, entry["url"], fields=entry.get("fields"))


# ---------- Where the household's channels come from ----------

def _account_settings(account):
    return (store.account(account) or {}).get("settings") or {}


def places(account):
    """{"countries", "languages"}: the channels shown on the Live TV page (an empty list: any). Not
    set yet: the household's country and international channels, in any language."""
    s = _account_settings(account)
    mine = s.get("livetv") or {}
    countries = mine["countries"] if "countries" in mine else [s.get("country") or DEFAULT_COUNTRY, INTERNATIONAL]
    return {"countries": countries, "languages": mine.get("languages") or []}


def set_places(account, countries, languages):
    countries = list(dict.fromkeys(str(c).upper() for c in countries or []))
    languages = list(dict.fromkeys(str(c).lower() for c in languages or []))
    if len(countries) > 40 or len(languages) > 40:
        raise ValueError("Pick at most 40 countries and 40 languages")
    if bad := [c for c in countries if c not in COUNTRIES]:
        raise ValueError(f"Unknown country {bad[0]}")
    if bad := [c for c in languages if c not in LANGUAGES and c != NOT_SAID]:
        raise ValueError(f"Unknown language {bad[0]}")
    store.update_account_settings(account, {"livetv": {"countries": countries, "languages": languages}})
    from . import cache
    cache.drop(f"account:{account}")


NOT_SAID = "none"     # a language filter's choice for channels whose list doesn't say their language


def _from(ch, countries, languages):
    """Whether a channel is from one of [countries] and in one of [languages] (NOT_SAID: one whose
    language isn't said). An empty list: any."""
    if countries and not set(ch["countries"] or [INTERNATIONAL]) & set(countries):
        return False
    if not languages:
        return True
    return bool(set(ch["languages"]) & set(languages)) if ch["languages"] else NOT_SAID in languages


def languages_said(chs):
    """Whether enough of [chs] say their language for a language filter to mean something
    (S.livetv.languages_said_share): below it, the apps don't show one and languages aren't used."""
    return bool(chs) and sum(bool(c["languages"]) for c in chs) >= L.languages_said_share * len(chs)


def _in_countries(chs, countries):
    return [c for c in chs if _from(c, countries, [])]


def _options(every, filtered):
    """What the filters can pick, each with how many channels it has, most first: countries and
    languages from [every] channel, kinds from the [filtered] ones (after the countries and languages
    asked for), so a kind's count is what picking it shows and a kind with none isn't offered."""
    def counted(values, name):
        n = {}
        for v in values:
            n[v] = n.get(v, 0) + 1
        return [{"id": k, "name": name(k), "count": c} for k, c in sorted(n.items(), key=lambda x: (-x[1], name(x[0])))]
    unsaid = sum(not c["languages"] for c in every)
    return {"kinds": counted([c["kind"] for c in filtered], kind_name),
            "countries": counted([x for c in every for x in (c["countries"] or [INTERNATIONAL])], COUNTRIES.get),
            "languages": counted([x for c in every for x in c["languages"]], LANGUAGES.get)
                         + ([{"id": NOT_SAID, "name": "Not said", "count": unsaid}] if unsaid else [])}


# ---------- Hidden channels ----------

def _hidden(account, device):
    """The channels hidden on [device] (they failed to play there)."""
    return {r["channel"] for r in store.livetv_failures(account, device, L.fails_to_hide, L.hidden_days)}


# ---------- What the apps get ----------

def state(ch, now=None):
    """An item's state now: live, upcoming, 24/7 or ended (from its times, or what it says it is);
    None for a channel that says nothing of the kind (an ordinary one: always on)."""
    if ch.get("status"):
        return ch["status"]
    start, end = ch.get("start"), ch.get("end")
    if start is None and end is None:
        return ALWAYS if ch.get("row") else None
    now = time.time() if now is None else now
    if end is not None and now >= end:
        return ENDED
    if start is not None and now < start:
        return UPCOMING
    return LIVE


def _on(ch, now):
    """Not ended (an ended one is left out everywhere)."""
    return state(ch, now) != ENDED


def _card(ch, favourites, now=None):
    card = {"id": ch["id"], "name": ch["name"], "logo": ch["logo"], "mono": ch["mono"], "hue": ch["hue"],
            "kind": ch["kind"], "kindName": kind_name(ch["kind"]),
            "countries": [{"id": c, "name": COUNTRIES[c]} for c in ch["countries"]],
            "languages": [{"id": c, "name": LANGUAGES[c]} for c in ch["languages"]],
            "favourite": ch["id"] in favourites}
    st = state(ch, now)
    if st:
        card["state"] = st
    if ch.get("start") is not None:
        card["startsAt"] = ch["start"] * 1000
    if ch.get("end") is not None:
        card["endsAt"] = ch["end"] * 1000
    if ch.get("about"):
        card["about"] = ch["about"]
    return card


def row_key(name):
    return "row:" + hashlib.sha256(name.encode()).hexdigest()[:8]


def _grouped(chs, favourites, now):
    """[chs] as cards, the items of one event (group) as one card where its first item is: the event's
    card (its first item's, its id the one played first) with "channels" [{"id", "name"}], each a
    channel of the event (its channel name, else its own name). An event with one item: a plain card."""
    cards, at = [], {}
    for c in chs:
        g = c.get("group")
        member = {"id": c["id"], "name": c.get("channel") or c["name"]}
        if g and g in at:
            cards[at[g]]["channels"].append(member)
            continue
        card = _card(c, favourites, now)
        if g:
            at[g] = len(cards)
            card["channels"] = [member]
        cards.append(card)
    for card in cards:
        if len(card.get("channels", ())) < 2:
            card.pop("channels", None)
    return cards


def _in_row(chs, now):
    """A row's items: live ones first (started last first), then 24/7 ones (in the list's order), then
    upcoming ones (soonest first)."""
    order = {LIVE: 0, ALWAYS: 1, None: 1, UPCOMING: 2}
    return sorted(chs, key=lambda c: (order.get(state(c, now), 1),
                                      -(c.get("start") or 0) if state(c, now) == LIVE else c.get("start") or 0))


def _rows_of(every, now):
    """The household's own rows (x-row), in the lists' order: {name: [items not ended]}."""
    rows = {}
    for c in every:
        if c.get("row") and _on(c, now):
            rows.setdefault(c["row"], []).append(c)
    return rows


def _ranked(chs, seconds):
    """Watched most in the household first, then the ones with a logo, then by name."""
    return sorted(chs, key=lambda c: (-seconds.get(c["id"], 0), not c["logo"], c["name"].lower()))


def page(account, device):
    """The Live TV page for the current profile."""
    if not _lists(account):
        return {"lists": 0, "hero": None, "rows": [], "shown": 0, "total": 0, "hidden": 0}
    now = time.time()
    every = [c for c in channels(account) if _on(c, now)]
    hidden = _hidden(account, device)
    by_id = {c["id"]: c for c in every}
    favourites = store.livetv_favourites(me())
    seconds = store.livetv_household_seconds(account)
    p = places(account)
    # The household's own rows first, whatever its places (theirs, not a country's).
    own = _rows_of(every, now)
    rows = []
    for name, chs in own.items():
        cards = _grouped(_in_row(chs, now), favourites, now)
        rows.append({"key": row_key(name), "row": name, "title": name, "channels": cards[:L.row_size], "count": len(cards)})
    plain = [c for c in every if not c.get("row")]
    near = [c for c in _in_countries(plain, p["countries"]) if c["id"] not in hidden]
    shown = [c for c in near if _from(c, [], p["languages"])] if languages_said(near) else near
    rows.append({"key": "mine", "title": "My channels",
                 "channels": [_card(by_id[f], favourites, now) for f in favourites if f in by_id]})
    kinds = {}
    for c in shown:
        kinds.setdefault(c["kind"], []).append(c)
    order = sorted(kinds, key=lambda k: (k in _LAST, -len(kinds[k]), kind_name(k)))
    for k in order[:L.rows]:
        rows.append({"key": f"kind:{k}", "kind": k, "title": kind_name(k),
                     "channels": [_card(c, favourites) for c in _ranked(kinds[k], seconds)[:L.row_size]]})
    last = next((by_id[c] for c in store.livetv_last_watched(me())
                 if c in by_id and c not in hidden and state(by_id[c], now) != UPCOMING), None)
    return {"lists": len(_lists(account)), "hero": _card(last, favourites, now) if last else None, "rows": rows,
            "shown": len(shown) + sum(len(x) for x in own.values()), "total": len(every),
            "hidden": sum(c["id"] in hidden for c in every)}


def _many(value):
    return [v for v in (value or "").split(",") if v]


def browse(account, device, kind=None, countries=None, languages=None, q=None, offset=0, limit=60, row=None):
    """Browse all: channels with the filters given ([countries], [languages]: comma-separated ids,
    "any" for any; not given: the household's places), or one of the household's own rows ([row]: its
    key, the places don't apply). Hidden and ended ones aren't in it."""
    now = time.time()
    if row:
        favourites = store.livetv_favourites(me())
        found = next((chs for name, chs in _rows_of(channels(account), now).items() if row_key(name) == row), [])
        cards = _grouped(_in_row(found, now), favourites, now)
        limit = max(1, min(int(limit), 200))
        offset = max(0, int(offset))
        return {"channels": cards[offset:offset + limit], "count": len(cards),
                "total": len(cards), "offset": offset, "filters": {"row": row}, "languagesSaid": False,
                "hidden": 0, "options": {"kinds": [], "countries": [], "languages": []}}
    every = [c for c in channels(account) if _on(c, now) and not c.get("row")]
    hidden = _hidden(account, device)
    favourites = store.livetv_favourites(me())
    p = places(account)
    countries = p["countries"] if countries is None else [] if countries == "any" else [c.upper() for c in _many(countries)]
    languages = p["languages"] if languages is None else [] if languages == "any" else [c.lower() for c in _many(languages)]
    words = _same(q or "")
    near = [c for c in _in_countries(every, countries) if c["id"] not in hidden]
    said = languages_said(near)
    if not said:
        languages = []
    found = [c for c in near if (not kind or c["kind"] == kind) and _from(c, [], languages)
             and (not words or words in _same(c["name"]))]
    found = _ranked(found, store.livetv_household_seconds(account))
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    return {"channels": [_card(c, favourites, now) for c in found[offset:offset + limit]], "count": len(found),
            "total": len(every), "offset": offset,
            "filters": {"kind": kind, "countries": countries, "languages": languages, "q": q or ""},
            "languagesSaid": said, "hidden": sum(c["id"] in hidden for c in every),
            "options": _options([c for c in every if c["id"] not in hidden],
                                [c for c in near if _from(c, [], languages)])}


def hidden_channels(account, device):
    """The channels hidden on [device] now (they failed to play there), to try again: one that plays
    is back at once."""
    rows = {r["channel"]: r for r in store.livetv_failures(account, device, L.fails_to_hide, L.hidden_days)}
    favourites = store.livetv_favourites(me())
    found = [c for c in channels(account) if c["id"] in rows]
    found.sort(key=lambda c: rows[c["id"]]["last_failed"], reverse=True)
    return {"channels": [{**_card(c, favourites), "failedAt": rows[c["id"]]["last_failed"].isoformat(),
                          "shownAgainAt": (rows[c["id"]]["last_failed"].timestamp() + L.hidden_days * 86400) * 1000}
                         for c in found]}


def _channel(account, channel_id):
    for c in channels(account):
        if c["id"] == channel_id:
            return c
    raise NotFound("No such channel")


def favourite(account, channel_id, on):
    _channel(account, channel_id)
    store.set_livetv_favourite(me(), channel_id, on)


def _hls(url):
    """Whether a stream is HLS (its address ends in .m3u8): the player is told, as its playback link
    doesn't say."""
    return urlparse(url).path.lower().endswith((".m3u8", ".m3u"))


def play(account, channel_id, device_id, base):
    """A channel's play answer, with this device's playback links (playlinks.py) for its streams. One
    the extension says how to open comes with what it adds for the device, and its link goes straight
    to the stream (the server doesn't open it: the device does)."""
    ch = _channel(account, channel_id)
    st = state(ch)
    if st == UPCOMING:
        raise ValueError("This hasn't started yet")
    if st == ENDED:
        raise NotFound("This has ended")
    streams = []
    for url, how in _streams(account, ch["id"]):
        if how is None:
            streams.append({"url": url, "name": ch["name"], "hls": _hls(url)})
        elif extension:
            streams.append({"url": url, "name": ch["name"], "hls": True, "direct": True, **extension.for_play(how)})
    answer = {"live": True, "channel": _card(ch, store.livetv_favourites(me())), "streams": streams, "subtitles": []}
    return playlinks.issue(answer, account, device_id, base)


def failed(account, device, channel_id):
    """None of the channel's streams played on [device]."""
    _channel(account, channel_id)
    store.livetv_failed(account, device, channel_id, L.failure_gap_minutes, L.hidden_days)


def watching(account, device, channel_id, seconds):
    """The player says the channel played [seconds] more (it reports as it plays)."""
    _channel(account, channel_id)
    tz = _account_settings(account).get("timezone") or DEFAULT_TIMEZONE
    store.livetv_watched(account, device, me(), channel_id, max(0, min(int(seconds), 600)), tz)
