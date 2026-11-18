"""The current profile's account (household): its time zone, country, location, AI limit, and
the Home settings its profiles start from (home_defaults).

Each account sets these itself; one that hasn't uses the server's defaults (config.py), except
the location, which is never guessed (the server may be nowhere near the household).
"""

import hashlib
import hmac
import os
import re
import secrets
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import cache, store, tries
from .cache import cached
from .config import DEFAULT_COUNTRY, DEFAULT_TIMEZONE, S
from .context import me
from .errors import NotFound

SETTINGS_TTL = S.advanced.cache.account_settings_seconds


def account_id():
    """The id of the account the current profile belongs to (a profile never changes account)."""
    profile_id = me()
    return cached(f"account-of:{profile_id}", lambda: store.account_of(profile_id),
                  ttl=S.advanced.cache.account_of_hours * 3600)


def settings():
    aid = account_id()
    return cached(f"account:{aid}", lambda: (store.account(aid) or {}).get("settings") or {}, ttl=SETTINGS_TTL)


def timezone():
    return settings().get("timezone") or DEFAULT_TIMEZONE


def country():
    """Where the household is, as a two-letter code: its region for release dates, and Home's Top 10."""
    return settings().get("country") or DEFAULT_COUNTRY


def location():
    """{"lat", "lon", "city", "countryCode"} for the weather, or None if the account hasn't set one."""
    return settings().get("location")


def monthly_limit():
    """The most the AI may cost the account in a month (USD), or None for no limit."""
    return settings().get("ai_monthly_limit_usd")


# Invites: a join code each, easy to type with a remote (no 0/O, 1/I), and far too many to guess.
# One joins a single device, then stops working; unused, it stops after INVITE_S. Only its keyed
# hash is kept (so the code is seen once, as it's made). A household has at most MOST_OPEN open.
CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_LENGTH = S.household.invite_code_length
INVITE_S = S.household.invite_hours * 3600
MOST_OPEN = S.household.max_open_invites
LONGEST_LABEL = S.names.invite_label


def new_code():
    return "".join(secrets.choice(CODE_LETTERS) for _ in range(CODE_LENGTH))


def code_hash(code):
    # Keyed, so a copy of the database alone can't be tried against every possible code.
    return hmac.new(os.environ["SECRETS_KEY"].encode(), code.encode(), hashlib.sha256).hexdigest()


def label(value):
    """Who or what an invite is for (it names the device that joins with it): None, or 1 to
    LONGEST_LABEL characters."""
    if value is None:
        return None
    text = " ".join(str(value).split())
    if len(text) > LONGEST_LABEL:
        raise ValueError(f"An invite's name is at most {LONGEST_LABEL} characters")
    return text or None


TooManyInvites = store.TooManyInvites


def new_invite(account, name=None, made_by="owner"):
    """A new one-time invite for the account, named [name] (see label): (code, its row), or None
    for no such account. Raises TooManyInvites when MOST_OPEN are open already."""
    code = new_code()
    row = store.add_invite(account, code_hash(code), label(name), made_by, INVITE_S, MOST_OPEN)
    return (code, row) if row else None


def new_device_code(account, device_id):
    """A one-time code for one of the account's devices to join again as itself (see
    store.join_with_invite): (code, its row), or None if it isn't one of the account's devices.
    Raises TooManyInvites as new_invite does."""
    found = next((d for d in store.devices(account) if str(d["id"]) == str(device_id)), None)
    if not found:
        return None
    code = new_code()
    row = store.add_invite(account, code_hash(code), found["name"], "admin", INVITE_S, MOST_OPEN, for_device=str(found["id"]))
    return (code, row) if row else None


def invites(account):
    """The account's invites, newest first, as the owner and the admin see them: never the code."""
    return [{"id": str(i["id"]), "label": i["label"], "madeBy": i["made_by"], "created": i["created_at"].isoformat(),
             "expiresAt": i["expires_at"].isoformat(),
             "state": "used" if i["used_at"] else "expired" if i["expired"] else "open",
             "usedAt": i["used_at"] and i["used_at"].isoformat(),
             "device": {"id": str(i["device_id"]), "name": i["device_name"]} if i["device_id"] else None,
             # (A device's own code: for it to join again as itself.)
             "for": {"id": str(i["for_device"]), "name": i["for_name"]} if i["for_device"] else None}
            for i in store.invites(account)]


def cancel_invite(account, invite_id):
    if not store.cancel_invite(account, invite_id):
        raise NotFound("No such open invite")


def remove_invite(account, invite_id):
    """Takes a used or expired invite off the list."""
    if not store.remove_invite(account, invite_id):
        raise NotFound("No such used or expired invite")


def clear_finished_invites(account):
    """Takes every used and expired invite off the list: {"removed": how many}."""
    return {"removed": store.clear_finished_invites(account)}


TooManyTries = tries.TooMany


def join_hash(code, who):
    """The hash to look a typed code up by, or None if it can't be a code (counted as a wrong one).
    Raises TooManyTries when wrong codes keep coming from [who] (see tries.py), or from everywhere."""
    code = re.sub(r"[\s-]", "", str(code or "")).upper()
    tries.check("join", who)
    if re.fullmatch(f"[{CODE_LETTERS}]{{{CODE_LENGTH}}}", code):
        return code_hash(code)
    tries.failed("join", who)
    return None


def wrong_code(who):
    tries.failed("join", who)


def check_settings(body):
    """Only known account settings, with sensible values (ValueError otherwise); None clears one."""
    out = {}
    for k, v in body.items():
        if v is None and k in ("timezone", "country", "location", "ai_monthly_limit_usd", "home_defaults"):
            out[k] = None
        elif k == "home_defaults":
            # Checked like a profile's own settings, by profiles.change_account.
            if not isinstance(v, dict):
                raise ValueError("home_defaults is an object")
            out[k] = v
        elif k == "timezone":
            try:
                ZoneInfo(str(v))
            except (ZoneInfoNotFoundError, ValueError):
                raise ValueError("Unknown time zone")
            out[k] = str(v)
        elif k == "country":
            if not re.fullmatch(r"[A-Z]{2}", str(v)):
                raise ValueError("A country is a two-letter code like CA")
            out[k] = v
        elif k == "location":
            if not isinstance(v, dict):
                raise ValueError("A location is {lat, lon, city, countryCode}")
            try:
                lat, lon = float(v["lat"]), float(v["lon"])
            except (KeyError, TypeError, ValueError):
                raise ValueError("A location needs lat and lon")
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                raise ValueError("lat or lon out of range")
            out[k] = {"lat": lat, "lon": lon, "city": str(v.get("city") or "")[:60],
                      "countryCode": str(v.get("countryCode") or "")[:2].upper()}
        elif k == "ai_monthly_limit_usd":
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 <= v <= S.ai.monthly_limit_max_usd:
                raise ValueError(f"The monthly limit is a number of dollars from 0 to {S.ai.monthly_limit_max_usd}")
            out[k] = round(float(v), 2)
        else:
            raise ValueError(f"Unknown account setting {k}")
    return out


def update_settings(body):
    aid = account_id()
    row = store.update_account_settings(aid, check_settings(body))
    cache.drop(f"account:{aid}")
    return row["settings"]
