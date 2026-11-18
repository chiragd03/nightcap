"""The TVs and browsers in a household. Each joined with a code (or, on a server at home, by
picking the household) and got its own key, which it sends with every request. (Managing the
household, its devices among it, is for its admin profile, from any of them.)
"""

import hashlib
import logging
import secrets
import threading
import time
from datetime import datetime, timezone

from . import accounts, cache, store
from .cache import cached
from .config import OPEN_JOIN, S
from .errors import Forbidden, NotFound
from .titles import title_extras

log = logging.getLogger(__name__)

# How often a device's "last used" is saved (it's a database write).
USED_EVERY_S = S.advanced.devices.last_used_save_minutes * 60
_used = {}
_used_lock = threading.Lock()


def _hash(key):
    return hashlib.sha256(key.encode()).hexdigest()


def households():
    """The households a device may join without a code ([] unless this server allows that)."""
    return [{"id": str(h["id"]), "name": h["name"]} for h in store.households()] if OPEN_JOIN else []


def join(household=None, code=None, name=None, kind="tv", install=None, who=""):
    """Adds a device to a household, by an invite's code (used up as it joins: see accounts.py) or,
    on a server that allows it, by the household's id. Returns ({"id", "name"}, the device's key);
    the key is shown this once and only its hash kept. The invite's name, if it has one, is the
    device's name. [install]: an id the device keeps (the TV's survives reinstalling the app);
    joining again with it replaces the device's old entry, whose key stops working. [who]: the
    address asking (wrong codes are counted by it)."""
    key = secrets.token_urlsafe(32)
    name = " ".join(str(name or "").split())[:S.names.device] or None
    install_hash = _hash(f"install:{install}") if install else None
    try:
        found, old = _join(household, code, key, name, kind, install_hash, who)
    except store.TooManyDevices as e:
        # (The invite isn't used up: it was taken back with the device.)
        raise Forbidden(f"This household has its most devices ({e.args[0]}): the admin can remove one in Settings")
    except store.OtherKind as e:
        # (Nor here: a device's own code, typed on another kind of device, still works on its own.)
        raise Forbidden(f"This code is for a {'TV' if e.args[0] == 'tv' else 'browser'}: use it there")
    if old:
        cache.drop(f"device:{old}")
    return {"id": str(found["id"]), "name": found["name"]}, key


def _join(household, code, key, name, kind, install_hash, who):
    if code:
        h = accounts.join_hash(code, who)
        joined = h and store.join_with_invite(h, _hash(key), name, kind, install_hash)
        if not joined:
            if h:
                accounts.wrong_code(who)
            raise NotFound("That invite doesn't work: it was used already, it expired, or it's mistyped")
        return joined
    if OPEN_JOIN:
        found = store.account(household)
        if not found:
            raise NotFound("No such household")
        _, old = store.add_device(found["id"], _hash(key), name, kind, install_hash)
        return found, old
    raise Forbidden("This server needs a join code")


def for_key(key):
    """{"id", "account_id"} of the device with this key, or None (kept a few minutes);
    notes that it was used."""
    if not key:
        return None
    h = _hash(key)
    device = cached(f"device:{h}", lambda: store.device_by_key(h), ttl=S.advanced.cache.device_key_seconds)
    if device:
        _note_used(h)
    return device


def _note_used(h):
    now = time.time()
    with _used_lock:
        if now - _used.get(h, 0) < USED_EVERY_S:
            return
        _used[h] = now
    store.device_used(h)


def _forget(key_hash):
    """A device changed or was removed: its key is looked up again (or refused) at once."""
    cache.drop(f"device:{key_hash}")
    with _used_lock:
        _used.pop(key_hash, None)


# A device's player reports where it's up to every 30 seconds, playing or paused: one that reported
# this recently is open on it; watching if its position also moved this recently, else paused.
WATCHING_S = S.advanced.devices.watching_seconds


def listing(account_id, me, activity=False):
    """The household's devices, for the Devices page; [me] is the asking device's id. With [activity]
    (the admin asking), each device's latest play: what it's watching now, or watched last."""
    plays, ok = {}, True
    if activity:
        try:
            plays = store.device_activity(account_id)
        except Exception:
            # (Said, not hidden: the page shows what's playing couldn't be loaded.)
            log.exception("Couldn't read what the devices are playing")
            ok = False
    return [{"id": str(d["id"]), "name": d["name"] or ("TV" if d["kind"] == "tv" else "Browser"),
             "kind": d["kind"], "joined": d["joined_at"].isoformat(),
             "lastUsed": d["last_used_at"] and d["last_used_at"].isoformat(), "thisDevice": str(d["id"]) == str(me),
             **({"activity": _activity(plays.get(str(d["id"])))} if activity and ok else {})}
            for d in store.devices(account_id)], ok


def _activity(r):
    """A device's latest play as the Devices page shows it, or None if it hasn't played anything."""
    if not r:
        return None
    series = ":" in r["video_id"]
    x = title_extras(r["imdb_id"], "series" if series else "movie") if not r["title"] else {}
    episode = f"S{r['season']} E{r['episode']}" if r["season"] is not None else (
        "S{} E{}".format(*r["video_id"].split(":")[1:3]) if series else None)
    now = datetime.now(timezone.utc)
    open_now = (now - r["ended_at"]).total_seconds() < WATCHING_S and not r["finished"]
    moving = r["moved_at"] is not None and (now - r["moved_at"]).total_seconds() < WATCHING_S
    return {k: v for k, v in {
        "watching": open_now and moving, "paused": open_now and not moving,
        "id": r["video_id"], "type": "series" if series else "movie",
        "title": r["title"] or x.get("name") or r["imdb_id"],
        "episode": episode, "episodeName": r["episode_name"],
        # A wide picture: the episode's still, else the title's backdrop; and its poster.
        "picture": r["still"] or r["backdrop"] or x.get("backdrop"), "poster": r["poster"] or x.get("poster"),
        "position": r["position_ms"], "duration": r["duration_ms"], "finished": r["finished"],
        "at": r["ended_at"].isoformat(),
        # When it began, and when its position last moved (paused since then, if it's paused).
        "started": r["started_at"].isoformat(), "movedAt": r["moved_at"] and r["moved_at"].isoformat(),
        "profile": {"id": str(r["profile_id"]), "name": r["profile_name"], "avatar": r["avatar"]},
    }.items() if v is not None}


def rename(account_id, device_id, name):
    """Gives a device a name of its own (an invite's name, or "Office Mac"): 1 to S.names.device characters."""
    name = " ".join(str(name or "").split())
    if not 1 <= len(name) <= S.names.device:
        raise ValueError(f"A device's name needs 1 to {S.names.device} characters")
    if not store.rename_device(account_id, device_id, name):
        raise NotFound("No such device")


def remove(account_id, device_id):
    """Removes a device: its key stops working at once."""
    key_hash = store.remove_device(account_id, device_id)
    if not key_hash:
        raise NotFound("No such device")
    _forget(key_hash)
