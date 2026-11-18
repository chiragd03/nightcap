"""Profiles: who's watching, their settings, and adding or removing them."""

import logging
import re
from concurrent.futures import ThreadPoolExecutor

from . import accounts, cache, recommend, store
from .config import S
from .ai import available as ai_available, usage_summary
from .context import me, scoped
from .errors import Forbidden, NotFound
from .home import language_titles, top10
from .languages import COUNTRY_NAMES, LANGUAGE_ROWS, home_settings
from .titles import feed_item, forget_wanted
from .widgets import widget_settings

log = logging.getLogger(__name__)


AVATAR = re.compile(r"^[a-z0-9_]{1,40}$")


def profile_json(p):
    return {"id": str(p["id"]), "name": p["name"], "avatar": p["avatar"], "isAdmin": p["is_admin"]}


def profile_list(account_id, profile_id=None):
    """Who's watching: the account's profiles, and which one this request is for (if it named one)."""
    return {"profiles": [profile_json(p) for p in store.profiles(account_id)],
            "me": str(profile_id) if profile_id else None}


# Player choices kept with the profile. The TV applies the audio and subtitle tracks; the server
# uses quality and the audio language to put the right versions first.
PLAYER_SETTINGS = ("audio_language", "subtitles", "quality")
QUALITIES = ("best", "4K", "1080p", "720p")


def profile_page():
    """The current profile for its settings page: who it is, its settings, and the choices."""
    p = store.profile(me())
    raw = p["settings"] or {}
    city = (accounts.location() or {}).get("city")
    ai = ai_available()
    return {**profile_json(p), "still": settings_still(), "weatherCity": city, "aiAvailable": ai,
            # The admin sees what the AI costs, each profile's share, and the account's own settings.
            "usage": usage_summary() if p["is_admin"] and ai else None,
            "account": accounts.settings() if p["is_admin"] else None,
            "settings": {**home_settings(), **widget_settings(p), **{k: raw[k] for k in PLAYER_SETTINGS if k in raw}},
            "options": {"languages": [{"code": c, "name": n} for c, n in LANGUAGE_ROWS.items()],
                        "countries": [{"code": c, "name": n} for c, n in COUNTRY_NAMES.items()]}}


def settings_still():
    """A backdrop for the subtitles preview: what you're watching, else today's featured title
    (from the Home last built; none if it hasn't been yet)."""
    hit = cache.get(scoped("launcher"))
    if not hit:
        return None
    feed = hit[1]
    rows = {r["id"]: r["items"] for r in feed.get("rows", [])}
    for item in [*rows.get("continue", []), *feed.get("featured", [])]:
        if item.get("backdrop"):
            return item["backdrop"]
    return None


def settings_preview(key):
    """Posters for a setting's preview: a language row's titles (lang:hi) or a country's top 6 (top10:IN)."""
    kind, _, arg = key.partition(":")
    if kind == "lang" and arg in LANGUAGE_ROWS:
        rows, count = language_titles(arg), 6
    elif kind == "top10" and arg in COUNTRY_NAMES:
        # Six: the top two are often the same everywhere (each chart's #1 show and #1 film).
        rows, count = [(tt, t) for tt, t, _ in top10(arg)], 6
    else:
        return None
    with ThreadPoolExecutor(max_workers=6) as pool:
        cards = list(pool.map(lambda r: feed_item(r[0], r[1]), rows[:count + 4]))
    return {"posters": [c["poster"] for c in cards if c.get("poster")][:count]}


def check_settings(settings):
    """Only known settings, with sensible values (ValueError otherwise)."""
    out = {}
    for k, v in settings.items():
        if k == "languages":
            if not isinstance(v, list) or not all(c in LANGUAGE_ROWS for c in v):
                raise ValueError("Unknown language")
            out[k] = list(dict.fromkeys(v))
        elif k == "top10_countries":
            if not isinstance(v, list) or not v or not all(c in COUNTRY_NAMES for c in v):
                raise ValueError("Unknown country")
            out[k] = list(dict.fromkeys(v))
        elif k == "quality":
            if v not in QUALITIES:
                raise ValueError("Unknown quality")
            out[k] = v
        elif k in ("show_weather", "show_ai"):
            if not isinstance(v, bool):
                raise ValueError(f"Bad {k}")
            out[k] = v
        elif k in PLAYER_SETTINGS:
            if not isinstance(v, str) or len(v) > 30:
                raise ValueError(f"Bad {k}")
            out[k] = v
        else:
            raise ValueError(f"Unknown setting {k}")
    return out


def forget_profile(profile_id):
    """Drops a profile's cached pages and recommendations (after its settings change or it's removed)."""
    cache.drop_prefix(f"{profile_id}|")
    recommend.forget(profile_id)
    # (Its audio language picks its trailers.)
    forget_wanted(profile_id)


def clean_change(body):
    """(name, avatar, settings) from a request, checked (ValueError otherwise); None where not given."""
    name = body.get("name")
    if name is not None:
        name = " ".join(str(name).split())
        if not 1 <= len(name) <= S.names.profile:
            raise ValueError(f"A name needs 1 to {S.names.profile} characters")
    avatar = body.get("avatar")
    if avatar is not None and not AVATAR.match(str(avatar)):
        raise ValueError("Unknown avatar")
    settings = body.get("settings")
    if settings is not None:
        if not isinstance(settings, dict) or len(settings) > 40:
            raise ValueError("Settings must be a small object")
        settings = check_settings(settings)
    return name, avatar, settings


def admin():
    """The current profile, which must be the account's admin (Forbidden otherwise)."""
    mine = store.profile(me())
    if not mine["is_admin"]:
        raise Forbidden("Only the admin profile can do that")
    return mine


def in_my_account(profile_id):
    """Another profile of the current profile's account (NotFound for any other)."""
    mine = store.profile(me())
    target = store.profile(profile_id)
    if not target or target["account_id"] != mine["account_id"]:
        raise NotFound("No such profile")
    return mine, target


def add_profile(body):
    """A new profile (admin only)."""
    mine = admin()
    name, avatar, _ = clean_change(body)
    if not name:
        raise ValueError("A new profile needs a name")
    return profile_json(store.create_profile(mine["account_id"], name, avatar))


def remove_profile(profile_id):
    """Removes a profile (admin only; never the admin profile)."""
    admin()
    _, target = in_my_account(profile_id)
    if target["is_admin"]:
        raise ValueError("The admin profile can't be removed")
    store.delete_profile(target["id"])
    forget_profile(target["id"])


def change_profile(body):
    """Changes your own profile, or anyone's in the account as the admin."""
    name, avatar, settings = clean_change(body)
    mine, target = in_my_account(body.get("id") or me())
    if target["id"] != mine["id"] and not mine["is_admin"]:
        raise Forbidden("Only the admin profile can change other profiles")
    updated = store.update_profile(target["id"], name, avatar, settings)
    forget_profile(target["id"])
    return profile_json(updated)


def change_account(body):
    """The account's own settings (admin only): time zone, country, location, AI limit."""
    admin()
    if isinstance(body.get("home_defaults"), dict):
        defaults = body["home_defaults"]
        if set(defaults) - {"languages", "top10_countries"}:
            raise ValueError("home_defaults takes languages and top10_countries")
        body = {**body, "home_defaults": check_settings(defaults)}
    settings = accounts.update_settings(body)
    # Pages built with the old ones (Top 10 country, release region, weather) are built again.
    for p in store.profiles(accounts.account_id()):
        forget_profile(p["id"])
    return settings
