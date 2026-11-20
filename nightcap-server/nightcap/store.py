"""Nightcap's database: profiles, what they watch, and the account's secrets.

Every function takes the profile (or account) it's for; nothing assumes there is only one.
"""

import json
import os
import re
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import psycopg
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row, tuple_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from .config import S

_pool = None
_pool_lock = threading.Lock()
# setup_lock's first key (schema.py's lock is 7171001).
SETUP_LOCK = 7171002


def conninfo():
    """DATABASE_URL, allowing a password with characters that aren't URL-safe (split at the last "@")."""
    v = os.environ["DATABASE_URL"].strip().strip('"\'')
    rest = v.split("://", 1)[1]
    creds, _, hostpart = rest.rpartition("@")
    user, _, password = creds.partition(":")
    hostport, _, db = hostpart.partition("/")
    host, _, port = hostport.partition(":")
    return make_conninfo(host=host, port=int(port or 5432), user=user, password=password,
                         dbname=db.split("?")[0], connect_timeout=S.advanced.timeouts.database_connect_seconds)


def pool():
    global _pool
    with _pool_lock:
        if _pool is None:
            # Each connection is checked as it's taken (a quick query; one that fails is replaced): a
            # database or its pooler closes idle ones, and the next request on
            # one would fail. Ones unused a while are closed first.
            _pool = ConnectionPool(conninfo(), min_size=1, max_size=S.advanced.pools.database_connections,
                                   kwargs={"row_factory": dict_row}, check=ConnectionPool.check_connection,
                                   max_idle=S.advanced.pools.database_idle_seconds, open=True)
        return _pool


def q(sql, params=(), one=False):
    """Runs a query and returns its rows (or the first row, or None)."""
    with pool().connection() as c:
        cur = c.execute(sql, params)
        rows = cur.fetchall() if cur.description else []
    return (rows[0] if rows else None) if one else rows


@contextmanager
def setup_lock(account, wait=True):
    """Held while the household's AIOStreams setup is made or changed, so plays at once on several
    copies of the server make one setup, not one each, and a change of sources isn't lost to it.
    Gives its connection (read and save on it: one connection a setup), or None when [wait] is False
    and another holds it. (A transaction's lock: it works through a connection pooler.)"""
    with pool().connection() as c, c.transaction():
        if wait:
            c.execute("SELECT pg_advisory_xact_lock(%s, hashtext(%s))", (SETUP_LOCK, str(account)))
        elif not c.execute("SELECT pg_try_advisory_xact_lock(%s, hashtext(%s)) AS got",
                           (SETUP_LOCK, str(account))).fetchone()["got"]:
            yield None
            return
        yield c


def configured():
    return bool(os.environ.get("DATABASE_URL"))


# ---------- Account and profiles ----------

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def account(account_id):
    """{"id", "name", "settings"}, or None for an unknown id."""
    if not _UUID.match(str(account_id or "")):
        return None
    return q("SELECT id, name, settings FROM accounts WHERE id = %s", (account_id,), one=True)


def update_account_settings(account_id, settings):
    """Merges [settings] into the account's; a None value removes that setting."""
    keep = {k: v for k, v in settings.items() if v is not None}
    drop = [k for k, v in settings.items() if v is None]
    return q("""UPDATE accounts SET settings = (settings || %s) - %s::text[] WHERE id = %s
                RETURNING id, name, settings""", (Jsonb(keep), drop, account_id), one=True)


def accounts():
    return q("SELECT id, name, settings FROM accounts ORDER BY created_at")


def households():
    """Every account, for a device joining a server at home (MODE=home), where any may be picked."""
    return q("SELECT id, name FROM accounts ORDER BY created_at")


def add_device(account_id, key_hash, name, kind, install_hash=None, label=None):
    """Adds a device; one that joined this household before (same [install_hash] and kind) gets
    its entry back with the new key instead. [label]: the name its invite gave it, over its own (and
    over one it was given before; without one, an entry it gets back keeps the name it has).
    Returns (its id, the key hash it had before or None)."""
    with pool().connection() as c:
        return _add_device(c, account_id, key_hash, name, kind, install_hash, label)


def _add_device(c, account_id, key_hash, name, kind, install_hash, label):
    one = lambda sql, params: c.execute(sql, params).fetchone()
    if install_hash:
        old = one("""SELECT id, key_hash FROM devices WHERE account_id = %s AND install_hash = %s AND kind = %s
                     ORDER BY joined_at LIMIT 1""", (account_id, install_hash, kind))
        # (Entries from before devices sent an id: the oldest one with this name is taken as its
        # own, once; from then on it has the id.)
        old = old or one("""SELECT id, key_hash FROM devices WHERE account_id = %s AND install_hash IS NULL
                            AND kind = %s AND name IS NOT DISTINCT FROM %s ORDER BY joined_at LIMIT 1""",
                         (account_id, kind, name))
        if old:
            c.execute("""UPDATE devices SET key_hash = %s, name = coalesce(%s, name, %s), install_hash = %s,
                                last_used_at = now() WHERE id = %s""", (key_hash, label, name, install_hash, old["id"]))
            return old["id"], old["key_hash"]
    # (One at a time per household, so two joining at once can't both slip under the limit.)
    c.execute("SELECT id FROM accounts WHERE id = %s FOR UPDATE", (account_id,))
    most = S.household.max_devices
    if one("SELECT count(*) AS n FROM devices WHERE account_id = %s", (account_id,))["n"] >= most:
        raise TooManyDevices(most)
    row = one("""INSERT INTO devices (account_id, key_hash, name, kind, last_used_at, install_hash)
                 VALUES (%s, %s, %s, %s, now(), %s) RETURNING id""", (account_id, key_hash, label or name, kind, install_hash))
    return row["id"], None


class TooManyDevices(Exception):
    """The household has its most devices (S.household.max_devices) already."""


class OtherKind(Exception):
    """A device's own code ("tv" or "browser", args[0]) used on another kind of device."""


def join_with_invite(code_hash, key_hash, name, kind, install_hash=None):
    """A device joins with an invite, which is used up in the same go: two devices with the same code
    at once, and only one gets in. Returns ({"id", "name"} of the household, the key hash its entry had
    before or None), or None if no open invite has this code. An invite for one device (for_device)
    gives that device the new key, its name and all kept, instead of adding one; used on another kind
    of device, it raises OtherKind (and isn't used up)."""
    with pool().connection() as c:
        invite = c.execute("""UPDATE invites SET used_at = now() WHERE code_hash = %s AND used_at IS NULL
                              AND expires_at > now() RETURNING id, account_id, label, for_device""", (code_hash,)).fetchone()
        if not invite:
            return None
        if invite["for_device"]:
            own = c.execute("""SELECT id, key_hash, kind FROM devices WHERE id = %s AND account_id = %s FOR UPDATE""",
                            (invite["for_device"], invite["account_id"])).fetchone()
            if not own:
                return None
            if own["kind"] != kind:
                # (Raised inside the transaction: the invite's use is taken back with it.)
                raise OtherKind(own["kind"])
            c.execute("""UPDATE devices SET key_hash = %s, install_hash = coalesce(%s, install_hash), last_used_at = now()
                         WHERE id = %s""", (key_hash, install_hash, own["id"]))
            device, old = own["id"], own["key_hash"]
        else:
            device, old = _add_device(c, invite["account_id"], key_hash, name, kind, install_hash, invite["label"])
        c.execute("UPDATE invites SET used_by = %s WHERE id = %s", (device, invite["id"]))
        return c.execute("SELECT id, name FROM accounts WHERE id = %s", (invite["account_id"],)).fetchone(), old


def device_by_key(key_hash):
    """{"id", "account_id"} for a device's key, or None."""
    return q("SELECT id, account_id FROM devices WHERE key_hash = %s", (key_hash,), one=True)


def devices(account_id):
    return q("""SELECT id, name, kind, joined_at, last_used_at FROM devices
                WHERE account_id = %s ORDER BY joined_at""", (account_id,))


def device_activity(account_id):
    """Each of the account's devices' latest play session: {device id: {video, title, episode, pictures,
    position, duration, finished, at, profile}}. Devices that haven't played anything aren't in it."""
    rows = q("""SELECT DISTINCT ON (w.device_id) w.device_id, w.video_id, w.imdb_id, w.position_ms, w.duration_ms,
                       w.finished, w.started_at, w.ended_at, w.moved_at, p.id AS profile_id, p.name AS profile_name, p.avatar,
                       t.name AS title, t.type, t.poster, t.backdrop, e.season, e.episode, e.name AS episode_name, e.still
                FROM watch_events w
                JOIN devices d ON d.id = w.device_id AND d.account_id = %s
                JOIN profiles p ON p.id = w.profile_id AND p.account_id = d.account_id
                LEFT JOIN titles t ON t.imdb_id = w.imdb_id
                LEFT JOIN episodes e ON e.video_id = w.video_id
                ORDER BY w.device_id, w.ended_at DESC""", (account_id,))
    return {str(r["device_id"]): r for r in rows}


def admin_session_live(token_hash, device_id, profile_id):
    """Whether this device has a live admin session for this profile, without renewing it (for
    reading pages that ask again by themselves, which mustn't keep admin unlocked)."""
    return bool(q("""SELECT 1 FROM admin_sessions WHERE token_hash = %s AND device_id = %s AND profile_id = %s
                     AND expires_at > now()""", (token_hash, device_id, profile_id), one=True))


def device_used(key_hash):
    q("UPDATE devices SET last_used_at = now() WHERE key_hash = %s", (key_hash,))


def rename_device(account_id, device_id, name):
    """Renames one of the account's devices; False if there's no such device."""
    if not _UUID.match(str(device_id or "")):
        return False
    return bool(q("UPDATE devices SET name = %s WHERE account_id = %s AND id = %s RETURNING id",
                  (name, account_id, device_id), one=True))


def remove_device(account_id, device_id):
    """Removes one of the account's devices; returns its key's hash (None if there's no such device)."""
    r = q("DELETE FROM devices WHERE account_id = %s AND id = %s RETURNING key_hash", (account_id, device_id), one=True)
    return r and r["key_hash"]


# ---------- Households, for the server's owner ----------

def household_list():
    """Every household with its admin and how many profiles and devices it has, oldest first."""
    return q("""SELECT a.id, a.name, a.created_at,
                       (SELECT count(*) FROM invites i WHERE i.account_id = a.id AND i.used_at IS NULL
                        AND i.expires_at > now()) AS open_invites,
                       (SELECT p.id FROM profiles p WHERE p.account_id = a.id AND p.is_admin LIMIT 1) AS admin_id,
                       (SELECT p.name FROM profiles p WHERE p.account_id = a.id AND p.is_admin LIMIT 1) AS admin_name,
                       (SELECT count(*) FROM profiles p WHERE p.account_id = a.id) AS profiles,
                       (SELECT count(*) FROM devices d WHERE d.account_id = a.id) AS devices
                FROM accounts a ORDER BY a.created_at""")


def create_household(name, admin_name, admin_avatar):
    """A new household and its admin profile; returns the household's id."""
    with pool().connection() as c, c.transaction():
        account = c.execute("INSERT INTO accounts (name) VALUES (%s) RETURNING id", (name,)).fetchone()["id"]
        c.execute("INSERT INTO profiles (account_id, name, avatar, is_admin) VALUES (%s, %s, %s, true)",
                  (account, admin_name, admin_avatar))
    return account


def rename_household(account_id, name):
    return bool(q("UPDATE accounts SET name = %s WHERE id = %s RETURNING id", (name, account_id)))


def delete_household(account_id):
    """Deletes a household and everything in it; returns its devices' key hashes (None if there's no such household)."""
    with pool().connection() as c, c.transaction():
        keys = [r["key_hash"] for r in c.execute("SELECT key_hash FROM devices WHERE account_id = %s", (account_id,))]
        gone = c.execute("DELETE FROM accounts WHERE id = %s RETURNING id", (account_id,)).fetchone()
    return keys if gone else None


def set_household_admin(account_id, profile_id):
    """Makes [profile_id] the household's one admin profile; False if it isn't one of its profiles."""
    with pool().connection() as c, c.transaction():
        if not c.execute("SELECT 1 FROM profiles WHERE id = %s AND account_id = %s", (profile_id, account_id)).fetchone():
            return False
        c.execute("UPDATE profiles SET is_admin = (id = %s) WHERE account_id = %s", (profile_id, account_id))
    return True


def wrong_tries(kind, who, seconds):
    """{"mine", "all"}: wrong tries of [kind] in the last [seconds], from [who] and from everyone."""
    return q("""SELECT count(*) FILTER (WHERE who = %(w)s) AS mine, count(*) AS all
                FROM wrong_tries WHERE kind = %(k)s AND at > now() - make_interval(secs => %(s)s)""",
             {"k": kind, "w": who, "s": seconds}, one=True)


def add_wrong_try(kind, who, seconds):
    """Notes a wrong try, and lets go of ones older than [seconds]."""
    with pool().connection() as c:
        c.execute("INSERT INTO wrong_tries (kind, who) VALUES (%s, %s)", (kind, who))
        c.execute("DELETE FROM wrong_tries WHERE at < now() - make_interval(secs => %s)", (seconds,))


# ---------- Invites (one device each) ----------

# Used and expired invites are kept this long, so who joined with which shows for a while; after that
# they're only clutter (the Devices page says what joined). Cleared out when one is made or the list is
# opened.
INVITES_KEPT_DAYS = S.household.finished_invites_kept_days


def add_invite(account_id, code_hash, label, made_by, seconds, most_open, for_device=None):
    """A new invite for the account; returns {"id", "label", "created_at", "expires_at"}, or None for
    no such account (or [for_device] isn't one of its devices). Raises TooManyInvites when [most_open]
    are open already. Old used and expired ones are cleared out on the way. [for_device]: a code for
    that device to join again as itself; one it had open before stops working."""
    if not _UUID.match(str(account_id or "")) or (for_device and not _UUID.match(str(for_device))):
        return None
    with pool().connection() as c:
        # (One at a time per household, so two at once can't both slip under the limit.)
        if not c.execute("SELECT id FROM accounts WHERE id = %s FOR UPDATE", (account_id,)).fetchone():
            return None
        if for_device:
            if not c.execute("SELECT id FROM devices WHERE id = %s AND account_id = %s", (for_device, account_id)).fetchone():
                return None
            c.execute("""DELETE FROM invites WHERE for_device = %s AND used_at IS NULL""", (for_device,))
        c.execute("""DELETE FROM invites WHERE account_id = %s AND (used_at < now() - make_interval(days => %s)
                     OR expires_at < now() - make_interval(days => %s))""", (account_id, INVITES_KEPT_DAYS, INVITES_KEPT_DAYS))
        n = c.execute("""SELECT count(*) AS n FROM invites WHERE account_id = %s AND used_at IS NULL
                         AND expires_at > now()""", (account_id,)).fetchone()["n"]
        if n >= most_open:
            raise TooManyInvites(most_open)
        return c.execute("""INSERT INTO invites (account_id, code_hash, label, made_by, expires_at, for_device)
                            VALUES (%s, %s, %s, %s, now() + make_interval(secs => %s), %s)
                            RETURNING id, label, created_at, expires_at""",
                         (account_id, code_hash, label, made_by, seconds, for_device)).fetchone()


class TooManyInvites(Exception):
    pass


# A finished invite: used, or expired unused.
_FINISHED = "(i.used_at IS NOT NULL OR i.expires_at <= now())"


def invites(account_id):
    """The account's invites, newest first: open, used (with the device that joined, if it's still
    there) and expired. Finished ones older than INVITES_KEPT_DAYS are forgotten first."""
    q(f"""DELETE FROM invites i WHERE i.account_id = %s AND {_FINISHED}
          AND COALESCE(i.used_at, i.expires_at) < now() - make_interval(days => %s)""", (account_id, INVITES_KEPT_DAYS))
    return q("""SELECT i.id, i.label, i.made_by, i.created_at, i.expires_at, i.expires_at <= now() AS expired,
                       i.used_at, d.name AS device_name,
                       d.id AS device_id, i.for_device, f.name AS for_name
                FROM invites i LEFT JOIN devices d ON d.id = i.used_by LEFT JOIN devices f ON f.id = i.for_device
                WHERE i.account_id = %s ORDER BY i.created_at DESC""", (account_id,))


def remove_invite(account_id, invite_id):
    """Removes one of the account's finished invites (used, or expired unused) from the list; False if
    there's no such finished invite. (An open one is cancelled instead: cancel_invite.)"""
    if not _UUID.match(str(invite_id or "")):
        return False
    return bool(q(f"""DELETE FROM invites i WHERE i.account_id = %s AND i.id = %s AND {_FINISHED} RETURNING i.id""",
                  (account_id, invite_id), one=True))


def clear_finished_invites(account_id):
    """Removes all of the account's finished invites from the list; how many."""
    return len(q(f"""DELETE FROM invites i WHERE i.account_id = %s AND {_FINISHED} RETURNING i.id""", (account_id,)))


def cancel_invite(account_id, invite_id):
    """Cancels one of the account's open invites; False if there's no such open invite."""
    if not _UUID.match(str(invite_id or "")):
        return False
    return bool(q("""DELETE FROM invites WHERE account_id = %s AND id = %s AND used_at IS NULL RETURNING id""",
                  (account_id, invite_id), one=True))


def profile(profile_id):
    """{"id", "account_id", "name", "avatar", "is_admin", "settings"}, or None for an unknown id."""
    if not _UUID.match(str(profile_id or "")):
        return None
    return q("SELECT id, account_id, name, avatar, is_admin, settings FROM profiles WHERE id = %s",
             (profile_id,), one=True)


def profiles(account):
    """The account's profiles: the admin first, then in the order they were added."""
    return q("""SELECT id, name, avatar, is_admin FROM profiles WHERE account_id = %s
                ORDER BY is_admin DESC, created_at""", (account,))


def create_profile(account, name, avatar):
    """A new (non-admin) profile. ValueError if the account already has one by that name, or has its
    most profiles (S.household.max_profiles; one that has more already keeps them)."""
    most = S.household.max_profiles
    try:
        with pool().connection() as c:
            # (One at a time per household, so two added at once can't both slip under the limit.)
            c.execute("SELECT id FROM accounts WHERE id = %s FOR UPDATE", (account,))
            if c.execute("SELECT count(*) AS n FROM profiles WHERE account_id = %s", (account,)).fetchone()["n"] >= most:
                raise ValueError(f"A household has at most {most} profiles: remove one first")
            return c.execute("""INSERT INTO profiles (account_id, name, avatar) VALUES (%s, %s, %s)
                                RETURNING id, name, avatar, is_admin""", (account, name, avatar)).fetchone()
    except psycopg.errors.UniqueViolation:
        raise ValueError(f"There's already a profile called {name}")


def update_profile(profile_id, name=None, avatar=None, settings=None):
    """Changes a profile's name, avatar, and/or settings (merged into what's there)."""
    try:
        return q("""UPDATE profiles SET name = COALESCE(%s, name), avatar = COALESCE(%s, avatar),
                        settings = settings || %s WHERE id = %s
                    RETURNING id, name, avatar, is_admin""",
                 (name, avatar, Jsonb(settings or {}), profile_id), one=True)
    except psycopg.errors.UniqueViolation:
        raise ValueError(f"There's already a profile called {name}")


def delete_profile(profile_id):
    """Removes a non-admin profile and everything it watched (its AI spend stays on the account)."""
    return bool(q("DELETE FROM profiles WHERE id = %s AND NOT is_admin RETURNING id", (profile_id,)))


def known_titles():
    """Every title the server knows (the shared titles table), as search cards' details, most popular first."""
    rows = q("""SELECT imdb_id, type, name, poster, backdrop, overview, rating, release_date, popularity
                FROM titles WHERE name IS NOT NULL ORDER BY popularity DESC NULLS LAST""")
    return [{"id": r["imdb_id"], "type": r["type"], "name": r["name"], "poster": r["poster"], "backdrop": r["backdrop"],
             "overview": (r["overview"] or "")[:300], "rating": float(r["rating"]) if r["rating"] is not None else None,
             "year": str(r["release_date"].year) if r["release_date"] else None} for r in rows]


def account_of(profile):
    return q("SELECT account_id FROM profiles WHERE id = %s", (profile,), one=True)["account_id"]


def profile_settings(profile):
    row = q("SELECT settings FROM profiles WHERE id = %s", (profile,), one=True)
    return (row or {}).get("settings") or {}


def secrets(account, conn=None):
    """{"aiostreams_url", "subtitle_urls": [...], "stream_urls": [...], "ai_api_key", "ai_provider",
    "ai_model", "ai_base_url", "ai_price": [input, output] | None, "debrid_keys": {service: key},
    "aiostreams_setup": {...} | None}, decrypted; read on [conn] when given. The AI's are read together:
    the key, whose it is (ai.PROVIDERS), the model, the address ("other" only) and the household's own
    price (US dollars per million tokens; [0, 0] for a free one)."""
    key = os.environ["SECRETS_KEY"]
    read = (lambda sql, params, one: conn.execute(sql, params).fetchone()) if conn else q
    row = read("""SELECT pgp_sym_decrypt(aiostreams_url, %(k)s) AS aio, pgp_sym_decrypt(subtitle_urls, %(k)s) AS subs,
                      pgp_sym_decrypt(stream_urls, %(k)s) AS streams,
                      pgp_sym_decrypt(ai_api_key, %(k)s) AS ai, ai_provider,
                      pgp_sym_decrypt(ai_model, %(k)s) AS ai_model, pgp_sym_decrypt(ai_base_url, %(k)s) AS ai_base_url,
                      pgp_sym_decrypt(ai_price, %(k)s) AS ai_price,
                      pgp_sym_decrypt(debrid_keys, %(k)s) AS debrid, pgp_sym_decrypt(aiostreams_setup, %(k)s) AS setup,
                      pgp_sym_decrypt(livetv_urls, %(k)s) AS livetv
               FROM account_secrets WHERE account_id = %(a)s""", {"k": key, "a": account}, one=True) or {}
    return {"aiostreams_url": row.get("aio"), "subtitle_urls": json.loads(row.get("subs") or "[]"),
            "stream_urls": json.loads(row.get("streams") or "[]"),
            "ai_api_key": row.get("ai"), "ai_provider": row.get("ai_provider"),
            "ai_model": row.get("ai_model"), "ai_base_url": row.get("ai_base_url"),
            "ai_price": json.loads(row["ai_price"]) if row.get("ai_price") else None,
            "debrid_keys": json.loads(row.get("debrid") or "{}"),
            "aiostreams_setup": json.loads(row["setup"]) if row.get("setup") else None,
            # Live TV's channel lists: [{"url", "name"}].
            "livetv_urls": json.loads(row.get("livetv") or "[]")}


# How each of the secrets is saved (encrypted, except whose AI key it is), from secrets()' form.
_SECRET_COLUMNS = {
    "aiostreams_url": lambda s: s["aiostreams_url"],
    "subtitle_urls": lambda s: json.dumps(s["subtitle_urls"]),
    "stream_urls": lambda s: json.dumps(s["stream_urls"]),
    "ai_api_key": lambda s: s["ai_api_key"],
    "ai_provider": lambda s: s["ai_provider"] if s["ai_api_key"] else None,
    # (The AI's other settings go with its key: none without one.)
    "ai_model": lambda s: s.get("ai_model") if s["ai_api_key"] else None,
    "ai_base_url": lambda s: s.get("ai_base_url") if s["ai_api_key"] else None,
    "ai_price": lambda s: json.dumps(s["ai_price"]) if s["ai_api_key"] and s.get("ai_price") is not None else None,
    # (None when there are none.)
    "debrid_keys": lambda s: json.dumps(s.get("debrid_keys") or {}) if s.get("debrid_keys") else None,
    "aiostreams_setup": lambda s: json.dumps(s["aiostreams_setup"]) if s.get("aiostreams_setup") else None,
    "livetv_urls": lambda s: json.dumps(s["livetv_urls"]) if s.get("livetv_urls") else None,
}


def save_secrets(account, s, conn=None, only=None):
    """Saves the account's sources and keys from [s] (as secrets() gives them), encrypted: all of
    them, or only the ones named in [only] (the others as they are, so a change made meanwhile to
    another isn't undone). On [conn] when given (inside its transaction)."""
    cols = [c for c in _SECRET_COLUMNS if only is None or c in only]
    if not cols:
        return
    values = ", ".join(f"%({c})s" if c == "ai_provider" else f"pgp_sym_encrypt(%({c})s, %(k)s)" for c in cols)
    (conn.execute if conn else q)(
        f"""INSERT INTO account_secrets (account_id, {", ".join(cols)}, updated_at) VALUES (%(a)s, {values}, now())
            ON CONFLICT (account_id) DO UPDATE SET {", ".join(f"{c} = EXCLUDED.{c}" for c in cols)}, updated_at = now()""",
        {"a": account, "k": os.environ["SECRETS_KEY"], **{c: _SECRET_COLUMNS[c](s) for c in cols}})


# ---------- The shared title cache ----------

def title(imdb_id):
    return q("SELECT * FROM titles WHERE imdb_id = %s", (imdb_id,), one=True)


def missing_titles():
    """[(imdb_id, type)] in someone's library with no row in titles yet."""
    return [(r["imdb_id"], r["type"]) for r in q(
        """SELECT DISTINCT l.imdb_id, l.type FROM library l
           WHERE NOT EXISTS (SELECT 1 FROM titles t WHERE t.imdb_id = l.imdb_id)""")]


def claim_rechecks(days, most):
    """[(imdb_id, type)] of at most [most] saved titles over [days] old and watched since they were
    saved, the oldest first (TMDB's details get fixed and added to). They're marked as looked at
    now, so another server (or a lookup that fails) doesn't take them again for [days]."""
    return [(r["imdb_id"], r["type"]) for r in q(
        """UPDATE titles SET updated_at = now() WHERE imdb_id IN (
               SELECT t.imdb_id FROM titles t
               WHERE t.updated_at < now() - make_interval(days => %s)
                 AND EXISTS (SELECT 1 FROM library l WHERE l.imdb_id = t.imdb_id AND l.last_watched_at > t.updated_at)
               ORDER BY t.updated_at LIMIT %s FOR UPDATE SKIP LOCKED)
           RETURNING imdb_id, type""", (days, most))]


def blank_title(imdb_id, ctype):
    """A titles row for one TMDB doesn't know."""
    return {"imdb_id": imdb_id, "type": ctype, "tmdb_id": None, "name": None, "language": None,
            "genres": [], "poster": None, "backdrop": None, "overview": None, "rating": None,
            "trailer": None, "keywords": [], "keyword_ids": [], "cast": Jsonb([]), "creators": Jsonb([]),
            "vote_count": None, "popularity": None, "release_date": None, "status": None, "runtime_min": None,
            "seasons": None, "episode_count": None, "origin_country": [], "collection": None,
            "certification": None}


def save_title(t, eps, conn=None):
    """Adds or updates one title and its episodes (on [conn] if given, else its own connection)."""
    if conn is None:
        with pool().connection() as c:
            return save_title(t, eps, c)
    with conn.cursor(row_factory=tuple_row) as cur:  # (db/fill_titles.py's connection has plain rows)
        before = cur.execute("SELECT tmdb_id FROM titles WHERE imdb_id = %s", (t["imdb_id"],)).fetchone()
    # (What TMDB leaves out of an episode stays, unless it's now another TMDB title: then the old
    # one's pictures and ratings go, even for episodes not in [eps].)
    same = before is not None and before[0] is not None and before[0] == t["tmdb_id"]
    if before is not None and not same:
        conn.execute("UPDATE episodes SET still = NULL, rating = NULL WHERE imdb_id = %s", (t["imdb_id"],))
    conn.execute("""
        INSERT INTO titles (imdb_id, type, tmdb_id, name, language, genres, poster, backdrop,
                            overview, rating, trailer, keywords, keyword_ids, "cast", creators, vote_count,
                            popularity, release_date, status, runtime_min, seasons, episode_count,
                            origin_country, collection, certification, updated_at)
        VALUES (%(imdb_id)s, %(type)s, %(tmdb_id)s, %(name)s, %(language)s, %(genres)s, %(poster)s,
                %(backdrop)s, %(overview)s, %(rating)s, %(trailer)s, %(keywords)s, %(keyword_ids)s,
                %(cast)s, %(creators)s, %(vote_count)s, %(popularity)s, %(release_date)s, %(status)s,
                %(runtime_min)s, %(seasons)s, %(episode_count)s, %(origin_country)s, %(collection)s, %(certification)s, now())
        ON CONFLICT (imdb_id) DO UPDATE SET type = EXCLUDED.type, tmdb_id = EXCLUDED.tmdb_id,
            name = EXCLUDED.name, language = EXCLUDED.language, genres = EXCLUDED.genres,
            -- (A picture or story TMDB leaves out stays, unless it's now another TMDB title.)
            poster = CASE WHEN EXCLUDED.tmdb_id = titles.tmdb_id THEN coalesce(EXCLUDED.poster, titles.poster) ELSE EXCLUDED.poster END,
            backdrop = CASE WHEN EXCLUDED.tmdb_id = titles.tmdb_id THEN coalesce(EXCLUDED.backdrop, titles.backdrop) ELSE EXCLUDED.backdrop END,
            overview = CASE WHEN EXCLUDED.tmdb_id = titles.tmdb_id THEN coalesce(EXCLUDED.overview, titles.overview) ELSE EXCLUDED.overview END, rating = EXCLUDED.rating, trailer = EXCLUDED.trailer,
            keywords = EXCLUDED.keywords, keyword_ids = EXCLUDED.keyword_ids, "cast" = EXCLUDED."cast",
            creators = EXCLUDED.creators, vote_count = EXCLUDED.vote_count, popularity = EXCLUDED.popularity,
            release_date = EXCLUDED.release_date, status = EXCLUDED.status, runtime_min = EXCLUDED.runtime_min,
            seasons = EXCLUDED.seasons, episode_count = EXCLUDED.episode_count,
            origin_country = EXCLUDED.origin_country, collection = EXCLUDED.collection,
            certification = EXCLUDED.certification, updated_at = now()""", t)
    for e in eps:
        conn.execute("""
            INSERT INTO episodes (video_id, imdb_id, season, episode, name, overview, still, released, rating)
            VALUES (%(video_id)s, %(imdb_id)s, %(season)s, %(episode)s, %(name)s, %(overview)s, %(still)s,
                    %(released)s, %(rating)s)
            ON CONFLICT (video_id) DO UPDATE SET name = EXCLUDED.name,
                overview = CASE WHEN %(same)s THEN coalesce(EXCLUDED.overview, episodes.overview) ELSE EXCLUDED.overview END,
                still = CASE WHEN %(same)s THEN coalesce(EXCLUDED.still, episodes.still) ELSE EXCLUDED.still END,
                released = CASE WHEN %(same)s THEN coalesce(EXCLUDED.released, episodes.released) ELSE EXCLUDED.released END,
                rating = CASE WHEN %(same)s THEN coalesce(EXCLUDED.rating, episodes.rating) ELSE EXCLUDED.rating END""",
                     {**e, "same": same})


# ---------- The library ----------

def library(profile):
    """Every title the profile has watched or is watching, most recent first."""
    return q("""SELECT l.*, t.name, t.poster FROM library l LEFT JOIN titles t USING (imdb_id)
                WHERE l.profile_id = %s ORDER BY l.last_watched_at DESC NULLS LAST""", (profile,))


def entry(profile, imdb_id):
    return q("SELECT * FROM library WHERE profile_id = %s AND imdb_id = %s", (profile, imdb_id), one=True)


def ticks(profile, imdb_id):
    """The set of episode ids ticked watched for one show."""
    return {r["video_id"] for r in q("SELECT video_id FROM episode_watched WHERE profile_id = %s AND imdb_id = %s",
                                     (profile, imdb_id))}


def ticked_shows(profile):
    return {r["imdb_id"] for r in q("SELECT DISTINCT imdb_id FROM episode_watched WHERE profile_id = %s", (profile,))}


def history(profile):
    """Titles that count as watched: played some, finished, or ticked. Most recent first."""
    return q("""SELECT l.imdb_id, l.type, coalesce(t.name, l.imdb_id) AS name
                FROM library l LEFT JOIN titles t USING (imdb_id)
                WHERE l.profile_id = %(p)s AND (l.watched OR l.times_watched > 0 OR l.overall_watched_ms > 0
                      OR l.position_ms > 0 OR EXISTS (SELECT 1 FROM episode_watched e
                                                      WHERE e.profile_id = l.profile_id AND e.imdb_id = l.imdb_id))
                ORDER BY l.last_watched_at DESC NULLS LAST""", {"p": profile})


def save_audio_pick(profile, imdb_id, pick):
    """The audio language picked in the player for a title ("hi"; "" clears it). Only for a title
    already in the library (its progress is saved first)."""
    q("UPDATE library SET audio_pick = %s WHERE profile_id = %s AND imdb_id = %s",
      (pick or None, profile, imdb_id))


def save_subtitle_pick(profile, imdb_id, pick):
    """The subtitles picked in the player for a title ("eng", "off"). Only for a title already in the
    library (its progress is saved first)."""
    q("UPDATE library SET subtitle_pick = %s WHERE profile_id = %s AND imdb_id = %s", (pick, profile, imdb_id))


def ensure_entry(conn, profile, imdb_id, ctype):
    conn.execute("""INSERT INTO library (profile_id, imdb_id, type) VALUES (%s, %s, %s)
                    ON CONFLICT (profile_id, imdb_id) DO NOTHING""", (profile, imdb_id, ctype))


def save_progress(profile, ctype, vid, position, duration, next_vid=None, played=None, source=None, device=None):
    """Where playback is up to. Finishing (92%+) ticks the episode (or marks the film watched)
    and, for a show, moves on to the next episode. Each play session is kept in watch_events.
    [played] is the real playback time since the last save, measured by the TV; [source] says
    where the play started ({origin, row_key, slot, request_id, model_version, audio_language}); [device]
    is the device it's playing on (each device has its own session)."""
    source = source or {}
    imdb_id = vid.split(":")[0]
    finished = duration > 0 and position >= duration * S.advanced.progress.finished_at
    now = datetime.now(timezone.utc)
    with pool().connection() as c:
        ensure_entry(c, profile, imdb_id, ctype)
        # The session: the one for this video (on this device) updated in the last half hour, else a new
        # one. (Carrying on on another device starts its own, so each device keeps what it played.)
        cutoff = datetime.fromtimestamp(time.time() - S.advanced.progress.session_gap_minutes * 60, timezone.utc)
        ev = c.execute("""SELECT id, position_ms, ended_at, finished FROM watch_events
                          WHERE profile_id = %s AND video_id = %s AND ended_at > %s
                            AND (%s::uuid IS NULL OR device_id = %s::uuid)
                          ORDER BY started_at DESC LIMIT 1""",
                       (profile, vid, cutoff, device, device)).fetchone()
        # Carrying on on another device (this video, this profile, in the last half hour): not a new
        # "played", and a finish already counted there isn't counted again.
        carried = None if ev else c.execute("""SELECT position_ms, ended_at, finished FROM watch_events
                          WHERE profile_id = %s AND video_id = %s AND ended_at > %s
                          ORDER BY ended_at DESC LIMIT 1""", (profile, vid, cutoff)).fetchone()
        if played is None:
            # No measurement from the TV: how far it moved on, no more than the time that passed.
            last = ev or carried
            played = max(0, min(position - last["position_ms"], int((now - last["ended_at"]).total_seconds() * 1000) + 5_000)) \
                if last else 0
        played = max(0, int(played))
        if ev:
            newly_finished = finished and not ev["finished"]
            c.execute("""UPDATE watch_events SET position_ms = %s, duration_ms = %s, ended_at = %s,
                             played_ms = played_ms + %s, finished = finished OR %s,
                             audio_language = coalesce(%s, audio_language), device_id = coalesce(device_id, %s),
                             moved_at = CASE WHEN position_ms <> %s THEN %s ELSE moved_at END
                         WHERE id = %s""",
                      (position, duration, now, played, finished, source.get("audio_language"), device, position, now, ev["id"]))
        else:
            newly_finished = finished and not (carried and carried["finished"])
            c.execute("""INSERT INTO watch_events (profile_id, imdb_id, video_id, started_at, ended_at, position_ms,
                             duration_ms, finished, played_ms, audio_language, origin, row_key, slot, request_id,
                             model_version, device_id, moved_at)
                         VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                      (profile, imdb_id, vid, now, now, position, duration, finished, played,
                       source.get("audio_language"), source.get("origin"), source.get("row_key"), source.get("slot"),
                       source.get("request_id"), source.get("model_version"), device, now))
        if not ev and not carried:
            # A new play session is also a deliberate "played", linked to where it came from.
            c.execute("""INSERT INTO interactions (profile_id, imdb_id, kind, origin, row_key, slot, request_id, model_version)
                         VALUES (%s, %s, 'played', %s, %s, %s, %s, %s)""",
                      (profile, imdb_id, source.get("origin"), source.get("row_key"), source.get("slot"),
                       source.get("request_id"), source.get("model_version")))
        c.execute("""UPDATE library SET position_ms = %s, duration_ms = %s, last_watched_at = %s,
                         overall_watched_ms = overall_watched_ms + %s,
                         times_watched = times_watched + %s,
                         current_video_id = CASE WHEN type = 'series' THEN %s ELSE current_video_id END,
                         watched = watched OR (type = 'movie' AND %s)
                     WHERE profile_id = %s AND imdb_id = %s""",
                  (0 if finished else position, duration, now, played, 1 if newly_finished else 0, vid,
                   finished, profile, imdb_id))
        if finished and ctype == "movie":
            _off_my_list(c, profile, imdb_id)
        if finished and ctype == "series":
            c.execute("""INSERT INTO episode_watched (profile_id, video_id, imdb_id) VALUES (%s, %s, %s)
                         ON CONFLICT DO NOTHING""", (profile, vid, imdb_id))
            if next_vid:
                c.execute("""UPDATE library SET current_video_id = %s, position_ms = 0, duration_ms = 0
                             WHERE profile_id = %s AND imdb_id = %s""", (next_vid, profile, imdb_id))


def mark_watched(profile, ctype, vid, episodes=(), next_vid=None):
    """Ticks an episode (or every aired episode, given in [episodes]) or marks a film watched.
    Marking the episode you're on moves on to [next_vid]."""
    imdb_id = vid.split(":")[0]
    with pool().connection() as c:
        ensure_entry(c, profile, imdb_id, ctype)
        if ctype == "movie":
            c.execute("""UPDATE library SET watched = true, position_ms = 0, times_watched = greatest(times_watched, 1),
                             last_watched_at = coalesce(last_watched_at, now()) WHERE profile_id = %s AND imdb_id = %s""",
                      (profile, imdb_id))
            _off_my_list(c, profile, imdb_id)
            return
        for v in (episodes or [vid]):
            c.execute("INSERT INTO episode_watched (profile_id, video_id, imdb_id) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                      (profile, v, imdb_id))
        row = c.execute("SELECT current_video_id FROM library WHERE profile_id = %s AND imdb_id = %s",
                        (profile, imdb_id)).fetchone()
        if row and row["current_video_id"] == vid:
            if next_vid:
                c.execute("""UPDATE library SET current_video_id = %s, position_ms = 0, duration_ms = 0
                             WHERE profile_id = %s AND imdb_id = %s""", (next_vid, profile, imdb_id))
            else:
                c.execute("UPDATE library SET position_ms = 0 WHERE profile_id = %s AND imdb_id = %s", (profile, imdb_id))
        c.execute("UPDATE library SET last_watched_at = coalesce(last_watched_at, now()) WHERE profile_id = %s AND imdb_id = %s",
                  (profile, imdb_id))


def mark_unwatched(profile, ctype, vid, episodes=()):
    """Unticks an episode (or a whole show, given every episode), or resets a film. A title with
    nothing else watched leaves the library, so it no longer counts as history."""
    imdb_id = vid.split(":")[0]
    with pool().connection() as c:
        if ctype == "movie" or vid == imdb_id and not episodes:
            c.execute("DELETE FROM episode_watched WHERE profile_id = %s AND imdb_id = %s", (profile, imdb_id))
            c.execute("DELETE FROM library WHERE profile_id = %s AND imdb_id = %s", (profile, imdb_id))
            return
        for v in (episodes or [vid]):
            c.execute("DELETE FROM episode_watched WHERE profile_id = %s AND video_id = %s", (profile, v))
        c.execute("""UPDATE library SET position_ms = 0 WHERE profile_id = %s AND imdb_id = %s
                     AND current_video_id = %s""", (profile, imdb_id, vid))
        left = c.execute("SELECT count(*) AS n FROM episode_watched WHERE profile_id = %s AND imdb_id = %s",
                         (profile, imdb_id)).fetchone()["n"]
        pos = c.execute("SELECT position_ms FROM library WHERE profile_id = %s AND imdb_id = %s",
                        (profile, imdb_id)).fetchone()
        if not left and (not pos or not pos["position_ms"]):
            c.execute("DELETE FROM library WHERE profile_id = %s AND imdb_id = %s", (profile, imdb_id))


def set_notify(profile, imdb_id, on):
    """New-episode alerts on or off for a show in the library; False if it isn't in it."""
    return bool(q("""UPDATE library SET notify = %s WHERE profile_id = %s AND imdb_id = %s AND type = 'series'
                     RETURNING imdb_id""", (on, profile, imdb_id)))


def leave_early(profile, vid, reason):
    """The "leaving early?" answer, on the play session just ended. "Not for me" also takes the
    title out of Continue watching until it's played again (it stays history; nothing is hidden)."""
    imdb_id = vid.split(":")[0]
    with pool().connection() as c:
        c.execute("""UPDATE watch_events SET exit_reason = %s WHERE id = (SELECT id FROM watch_events
                     WHERE profile_id = %s AND video_id = %s ORDER BY started_at DESC LIMIT 1)""", (reason, profile, vid))
        if reason == "not_my_taste":
            c.execute("UPDATE library SET continue_hidden_at = now() WHERE profile_id = %s AND imdb_id = %s",
                      (profile, imdb_id))
        c.execute("""INSERT INTO prompts (profile_id, imdb_id, kind) VALUES (%s, %s, 'early_exit')
                     ON CONFLICT DO NOTHING""", (profile, imdb_id))


def prompt_shown(profile, imdb_id, kind):
    q("INSERT INTO prompts (profile_id, imdb_id, kind) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
      (profile, imdb_id, kind))


def prompts(profile, imdb_id):
    return {r["kind"] for r in q("SELECT kind FROM prompts WHERE profile_id = %s AND imdb_id = %s", (profile, imdb_id))}


def rating(profile, imdb_id):
    r = q("SELECT value FROM ratings WHERE profile_id = %s AND imdb_id = %s", (profile, imdb_id), one=True)
    return r and r["value"]


def rate(profile, imdb_id, value):
    """-1 not for me, 1 like, 2 love; None clears it."""
    if value is None:
        q("DELETE FROM ratings WHERE profile_id = %s AND imdb_id = %s", (profile, imdb_id))
    else:
        q("""INSERT INTO ratings (profile_id, imdb_id, value) VALUES (%s, %s, %s)
             ON CONFLICT (profile_id, imdb_id) DO UPDATE SET value = EXCLUDED.value, rated_at = now()""",
          (profile, imdb_id, value))
    prompt_shown(profile, imdb_id, "rating")


def my_list(profile):
    """The profile's My List, newest first: (imdb_id, type, name, poster)."""
    return q("""SELECT m.imdb_id, m.type, t.name, t.poster FROM my_list m LEFT JOIN titles t USING (imdb_id)
                WHERE m.profile_id = %s ORDER BY m.added_at DESC""", (profile,))


def in_my_list(profile, imdb_id):
    return bool(q("SELECT 1 FROM my_list WHERE profile_id = %s AND imdb_id = %s", (profile, imdb_id), one=True))


def set_my_list(profile, imdb_id, ctype, on):
    """Puts a title on the profile's My List (added again, it keeps its place), or takes it off."""
    if on:
        q("""INSERT INTO my_list (profile_id, imdb_id, type) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING""",
          (profile, imdb_id, ctype))
    else:
        q("DELETE FROM my_list WHERE profile_id = %s AND imdb_id = %s", (profile, imdb_id))


def _off_my_list(conn, profile, imdb_id):
    """A film just finished (or marked watched) leaves My List: it was put there to be watched."""
    conn.execute("DELETE FROM my_list WHERE profile_id = %s AND imdb_id = %s AND type = 'movie'", (profile, imdb_id))


def watched_ids(profile):
    """Titles this profile has watched (finished, or marked watched)."""
    return {r["imdb_id"] for r in q("""SELECT imdb_id FROM library
                                      WHERE profile_id = %s AND (watched OR times_watched > 0)""", (profile,))}


def watch_again(profile, limit=40):
    """Watched titles that may be worth seeing again: a film rated "I like it" or "Love it" or
    watched more than once; a series rated so (whether it's finished is for the caller: its count
    is episodes, and one you're still following isn't a rewatch). Most recently watched first,
    with what a page needs to pick its own."""
    return q("""SELECT l.imdb_id, l.type, t.language, t.genres
                FROM library l JOIN titles t USING (imdb_id)
                LEFT JOIN ratings r ON r.profile_id = l.profile_id AND r.imdb_id = l.imdb_id
                WHERE l.profile_id = %s AND (l.watched OR l.times_watched > 0)
                  AND CASE WHEN l.type = 'movie' THEN r.value IN (1, 2) OR l.times_watched >= 2
                           ELSE r.value IN (1, 2) END
                ORDER BY l.last_watched_at DESC NULLS LAST LIMIT %s""", (profile, limit))


def taste_signals(profile):
    """What the profile said about what it watched: {"loved", "liked", "disliked"} as sets of IMDb
    ids, from its ratings (2 love, 1 like, -1 not for me) and from leaving a title early as not
    to its taste (counted as disliked unless it was rated since)."""
    out = {"loved": set(), "liked": set(), "disliked": set()}
    for r in q("SELECT imdb_id, value FROM ratings WHERE profile_id = %s", (profile,)):
        out["loved" if r["value"] == 2 else "liked" if r["value"] == 1 else "disliked"].add(r["imdb_id"])
    for r in q("""SELECT DISTINCT imdb_id FROM watch_events WHERE profile_id = %s AND exit_reason = 'not_my_taste'""",
               (profile,)):
        if r["imdb_id"] not in out["loved"] | out["liked"]:
            out["disliked"].add(r["imdb_id"])
    return out


def sweep_lookups(rules):
    """Deletes kept lookups that are past their use: for each (key pattern, days), those of that kind
    (a profile's own as well) saved more than [days] ago, and cleared ones older than a day. Returns
    how many went. (They'd be worked out again if asked for: this only stops the table growing.)"""
    n = 0
    with pool().connection() as c:
        for pattern, days in rules:
            n += c.execute("""DELETE FROM lookups WHERE key ~ %s AND saved_at < now() - make_interval(days => %s)""",
                           (rf"^([0-9a-f-]{{36}}\|)?{pattern}", days)).rowcount
        n += c.execute("DELETE FROM lookups WHERE dropped AND saved_at < now() - interval '1 day'").rowcount
    return n


# ---------- Not interested, interactions, row usage ----------

def not_interested(profile):
    return {r["imdb_id"] for r in q("SELECT imdb_id FROM not_interested WHERE profile_id = %s", (profile,))}


def not_interested_names(profile, limit=40):
    return [r["name"] for r in q("""SELECT t.name FROM not_interested n JOIN titles t USING (imdb_id)
                                   WHERE n.profile_id = %s AND t.name IS NOT NULL ORDER BY n.marked_at DESC LIMIT %s""",
                                 (profile, limit))]


def set_not_interested(profile, imdb_id, on, origin=None, row_key=None):
    """Not interested in a title (or interested again). Not interested takes it off My List too: what was
    said last wins."""
    if on:
        with pool().connection() as c, c.transaction():
            c.execute("INSERT INTO not_interested (profile_id, imdb_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                      (profile, imdb_id))
            c.execute("DELETE FROM my_list WHERE profile_id = %s AND imdb_id = %s", (profile, imdb_id))
        interaction(profile, imdb_id, "not_interested", origin=origin, row_key=row_key)
    else:
        q("DELETE FROM not_interested WHERE profile_id = %s AND imdb_id = %s", (profile, imdb_id))


def interaction(profile, imdb_id, kind, origin=None, row_key=None, slot=None, request_id=None, model_version=None):
    q("""INSERT INTO interactions (profile_id, imdb_id, kind, origin, row_key, slot, request_id, model_version)
         VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
      (profile, imdb_id, kind, origin, row_key, slot, request_id, model_version))


def row_stats(profile):
    return {r["row_key"]: {"shown_since": r["shown_since"] and r["shown_since"].timestamp(),
                           "opened": r["last_opened"] and r["last_opened"].timestamp()}
            for r in q("SELECT * FROM row_stats WHERE profile_id = %s", (profile,))}


def note_row_opened(profile, row):
    q("""INSERT INTO row_stats (profile_id, row_key, last_opened) VALUES (%s, %s, now())
         ON CONFLICT (profile_id, row_key) DO UPDATE SET last_opened = now()""", (profile, row))


def note_rows_shown(profile, keys, page=None):
    """[keys]: the rows on Home ([page] None) or on the Shows ("tv") or Movies ("movie") page, whose rows
    are "tv:…", "movie:…". Only that page's own rows outside [keys] start their streak again."""
    with pool().connection() as c:
        for k in keys:
            c.execute("""INSERT INTO row_stats (profile_id, row_key, shown_since) VALUES (%s, %s, now())
                         ON CONFLICT (profile_id, row_key) DO UPDATE
                         SET shown_since = coalesce(row_stats.shown_since, now())""", (profile, k))
        # A row that's off its page starts its streak again next time it's shown.
        mine = "row_key LIKE %s" if page else "row_key NOT LIKE 'tv:%%' AND row_key NOT LIKE 'movie:%%'"
        c.execute(f"UPDATE row_stats SET shown_since = NULL WHERE profile_id = %s AND NOT (row_key = ANY(%s)) AND {mine}",
                  (profile, list(keys), *([f"{page}:%"] if page else [])))


# ---------- Recommendations ----------

def recommendations(profile):
    """The saved For You / Because you watched rows."""
    r = q("SELECT * FROM recommendations WHERE profile_id = %s", (profile,), one=True)
    if not r:
        return None
    # (seeds: the Because rows' titles as a list, from before the rows' other names were kept with them.)
    names = r["seeds"] if isinstance(r["seeds"], dict) else {"because": r["seeds"] or []}
    return {"built_at": r["built_at"].timestamp(), "history_fingerprint": r["fingerprint"],
            "taste_summary": r["taste_summary"], "seeds": names.get("because") or [], "themes": names.get("themes") or [],
            "seed_kinds": names.get("because_kinds") or [], "page_themes": names.get("page_themes") or {},
            "by_ai": names.get("by_ai"), "version": names.get("version"), "catalogs": r["rows"]}


def save_recommendations(profile, cache):
    q("""INSERT INTO recommendations (profile_id, built_at, fingerprint, taste_summary, seeds, rows)
         VALUES (%s, to_timestamp(%s), %s, %s, %s, %s)
         ON CONFLICT (profile_id) DO UPDATE SET built_at = EXCLUDED.built_at, fingerprint = EXCLUDED.fingerprint,
             taste_summary = EXCLUDED.taste_summary, seeds = EXCLUDED.seeds, rows = EXCLUDED.rows""",
      (profile, cache["built_at"], cache["history_fingerprint"], cache["taste_summary"],
       Jsonb({"because": cache["seeds"], "because_kinds": cache.get("seed_kinds") or [], "themes": cache.get("themes") or [],
              "page_themes": cache.get("page_themes") or {}, "by_ai": cache.get("by_ai"), "version": cache.get("version")}),
       Jsonb(cache["catalogs"])))


# ---------- AI costs ----------

def record_usage(profile, purpose, model, input_tokens, output_tokens, cost):
    q("""INSERT INTO ai_usage (account_id, profile_id, purpose, model, input_tokens, output_tokens, cost_usd)
         VALUES (%s, %s, %s, %s, %s, %s, %s)""",
      (account_of(profile), profile, purpose, model, input_tokens, output_tokens, cost))


def save_ai_picks(profile, request_id, feature, model, sent, picks, seed=None, query=None):
    q("""INSERT INTO ai_picks (request_id, profile_id, feature, model, seed, query, sent, picks)
         VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
      (request_id, profile, feature, model, seed, query, Jsonb(sent), Jsonb(picks)))


def sweep_ai_picks(days):
    """Deletes the AI's lists saved more than [days] ago; returns how many went."""
    with pool().connection() as c:
        return c.execute("DELETE FROM ai_picks WHERE at < now() - make_interval(days => %s)", (days,)).rowcount


def month_spend(account, tz):
    """What the account's AI calls have cost this calendar month (in its time zone), in USD."""
    row = q("""SELECT coalesce(sum(cost_usd), 0)::float AS cost FROM ai_usage
               WHERE account_id = %s AND called_at >= date_trunc('month', now() AT TIME ZONE %s) AT TIME ZONE %s""",
            (account, tz, tz), one=True)
    return row["cost"]


def usage_summary(account, tz):
    """This month's AI spend for the account (with each profile's share), today, and the last 30 days,
    with days and months counted in [tz]. A call whose cost isn't known (its model had no price) counts
    in the calls, not the costs: month_unpriced_calls, today_unpriced_calls and each day's and profile's
    "unpriced" say how many."""
    days = q("""SELECT (called_at AT TIME ZONE %s)::date AS day, coalesce(sum(cost_usd), 0)::float AS cost,
                       count(*) AS calls, count(*) FILTER (WHERE cost_usd IS NULL) AS unpriced
                FROM ai_usage WHERE account_id = %s AND called_at > now() - interval '31 days'
                GROUP BY 1 ORDER BY 1""", (tz, account))
    profiles = q("""SELECT p.name, coalesce(sum(u.cost_usd), 0)::float AS cost, count(*) AS calls,
                           count(*) FILTER (WHERE u.cost_usd IS NULL) AS unpriced
                    FROM ai_usage u JOIN profiles p ON p.id = u.profile_id
                    WHERE u.account_id = %s AND date_trunc('month', u.called_at AT TIME ZONE %s)
                          = date_trunc('month', now() AT TIME ZONE %s)
                    GROUP BY 1 ORDER BY 2 DESC""", (account, tz, tz))
    local_now = datetime.now(ZoneInfo(tz))
    month = local_now.strftime("%Y-%m")
    today = local_now.strftime("%Y-%m-%d")
    this_month = [d for d in days if d["day"].isoformat().startswith(month)]
    t = next((d for d in days if d["day"].isoformat() == today), {"cost": 0, "calls": 0, "unpriced": 0})
    return {
        "month": month,
        "month_cost": round(sum(d["cost"] for d in this_month), 4),
        "month_calls": sum(d["calls"] for d in this_month),
        "month_unpriced_calls": sum(d["unpriced"] for d in this_month),
        "today_calls": t["calls"], "today_cost": round(t["cost"], 4), "today_unpriced_calls": t["unpriced"],
        "daily": [{"date": d["day"].isoformat(), "cost": round(d["cost"], 4), "calls": d["calls"],
                   "unpriced": d["unpriced"]} for d in days],
        "by_profile": [{"name": p["name"], "cost": round(p["cost"], 4), "calls": p["calls"],
                        "unpriced": p["unpriced"]} for p in profiles],
    }


# ---------- Recent searches (per profile) ----------

RECENT_SEARCHES = S.household.recent_searches


def recent_searches(profile):
    return [r["query"] for r in q("""SELECT query FROM recent_searches WHERE profile_id = %s
                                     ORDER BY searched_at DESC LIMIT %s""", (profile, RECENT_SEARCHES))]


def add_search(profile, query):
    """Puts [query] first (the same words in other capitals count as the same search); keeps the last few."""
    with pool().connection() as db:
        db.execute("DELETE FROM recent_searches WHERE profile_id = %s AND lower(query) = lower(%s)", (profile, query))
        db.execute("INSERT INTO recent_searches (profile_id, query) VALUES (%s, %s)", (profile, query))
        db.execute("""DELETE FROM recent_searches WHERE profile_id = %s AND query NOT IN (
                          SELECT query FROM recent_searches WHERE profile_id = %s
                          ORDER BY searched_at DESC LIMIT %s)""", (profile, profile, RECENT_SEARCHES))


# ---------- Links played on a TV (per profile) ----------

def sent_items(profile, keep=S.household.sent_links_shown):
    return [{"id": str(r["id"]), "url": r["url"], "name": r["name"], "position": r["position_ms"],
             "duration": r["duration_ms"], "sent_at": r["sent_at"].timestamp(),
             "played_at": r["played_at"] and r["played_at"].timestamp(), "thumb": r["has_thumb"]}
            for r in q("""SELECT id, url, name, position_ms, duration_ms, sent_at, played_at, thumb IS NOT NULL AS has_thumb
                          FROM sent_links WHERE profile_id = %s ORDER BY sent_at DESC LIMIT %s""", (profile, keep))]


def send_link(profile, url, name):
    """Puts a link at the top of the profile's list; re-sending keeps its saved position."""
    old = q("SELECT id FROM sent_links WHERE profile_id = %s AND url = %s", (profile, url), one=True)
    if old:
        q("UPDATE sent_links SET sent_at = now(), name = coalesce(%s, name) WHERE id = %s", (name or None, old["id"]))
        return old["id"]
    return q("INSERT INTO sent_links (profile_id, url, name) VALUES (%s, %s, %s) RETURNING id",
             (profile, url, name), one=True)["id"]


def sent_progress(profile, item_id, position, duration):
    q("UPDATE sent_links SET position_ms = %s, duration_ms = %s, played_at = now() WHERE profile_id = %s AND id = %s",
      (int(position), int(duration), profile, int(item_id)))


def save_thumb(profile, item_id, jpeg):
    q("UPDATE sent_links SET thumb = %s WHERE profile_id = %s AND id = %s", (jpeg, profile, int(item_id)))


def sent_thumb(profile, item_id):
    """The picture for one of the profile's sent links (None for anyone else's)."""
    r = q("SELECT thumb FROM sent_links WHERE profile_id = %s AND id = %s", (profile, int(item_id)), one=True)
    return r and r["thumb"]


def sent_remove(profile, item_id):
    q("DELETE FROM sent_links WHERE profile_id = %s AND id = %s", (profile, int(item_id)))


# ---------- Kept lookups and pages ----------
# What the server worked out from other services (TMDB, Cinemeta, TVmaze, the AI) and the pages it
# built, so any copy of the server (a fresh one too) can answer from them. See cache.py.

def lookup(key):
    """(saved at as a timestamp, value) for a kept lookup or page, or None (none, or cleared)."""
    r = q("SELECT value, saved_at FROM lookups WHERE key = %s AND NOT dropped", (key,), one=True)
    return (r["saved_at"].timestamp(), r["value"]) if r else None


def keep_lookup(key, value, saved_at):
    """Keeps [value], worked out from [saved_at] on, unless the key was cleared after that."""
    q("""INSERT INTO lookups (key, value, saved_at, dropped) VALUES (%s, %s, to_timestamp(%s), false)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, saved_at = EXCLUDED.saved_at, dropped = false
         WHERE lookups.saved_at <= EXCLUDED.saved_at""", (key, Jsonb(value), saved_at))


def drop_lookup(key, at):
    """Clears a kept lookup or page, at [at] (the server's clock, as keep_lookup's times are)."""
    q("""INSERT INTO lookups (key, value, saved_at, dropped) VALUES (%s, NULL, to_timestamp(%s), true)
         ON CONFLICT (key) DO UPDATE SET value = NULL, saved_at = EXCLUDED.saved_at, dropped = true""", (key, at))


def drop_lookups(prefix, at):
    """Clears every kept lookup or page whose key starts with [prefix]."""
    q("""UPDATE lookups SET value = NULL, saved_at = to_timestamp(%s), dropped = true
         WHERE left(key, length(%s)) = %s AND NOT dropped""", (at, prefix, prefix))


# ---------- Play on TV ----------

def device(account_id, device_id):
    """One of the account's devices ({"id", "name", "kind", "idle_s"}: seconds since it was last
    used, by the database's clock; None if never), or None."""
    return q("""SELECT id, name, kind, extract(epoch FROM now() - last_used_at)::float AS idle_s
                FROM devices WHERE account_id = %s AND id = %s""", (account_id, device_id), one=True)


def add_tv_request(account_id, device_id, from_profile, what):
    return q("""INSERT INTO tv_requests (account_id, device_id, from_profile, what) VALUES (%s, %s, %s, %s)
                RETURNING id""", (account_id, device_id, from_profile, Jsonb(what)), one=True)["id"]


def take_tv_request(device_id, within_s):
    """The oldest request waiting for this TV (sent in the last [within_s] seconds), now marked shown."""
    return q("""UPDATE tv_requests SET status = 'shown' WHERE id = (
                    SELECT id FROM tv_requests WHERE device_id = %s AND status = 'waiting'
                      AND created_at > now() - make_interval(secs => %s) ORDER BY created_at LIMIT 1
                    FOR UPDATE SKIP LOCKED)
                RETURNING id, from_profile, what""", (device_id, within_s), one=True)


def tv_request(account_id, request_id):
    return q("""SELECT id, device_id, status, extract(epoch FROM now() - created_at)::float AS age
                FROM tv_requests WHERE account_id = %s AND id = %s""", (account_id, request_id), one=True)


def set_tv_request(request_id, status, device_id=None, only_from=None):
    """Moves a request on to [status]; [device_id] must be its TV, [only_from] the status it's in now."""
    return bool(q("""UPDATE tv_requests SET status = %s, answered_at = now()
                     WHERE id = %s AND (%s::uuid IS NULL OR device_id = %s::uuid) AND (%s::text IS NULL OR status = %s)
                     RETURNING id""", (status, request_id, device_id, device_id, only_from, only_from)))


def forget_tv_requests(older_than_s):
    q("DELETE FROM tv_requests WHERE created_at < now() - make_interval(secs => %s)", (older_than_s,))


# ---------- Source failures ----------

def record_failure(account, profile, video_id, addon, kind, detail=None):
    q("""INSERT INTO source_failures (account_id, profile_id, video_id, addon, kind, detail)
         VALUES (%s, %s, %s, %s, %s, %s)""", (account, profile, video_id, addon[:80], kind, (detail or "")[:300] or None))


def recent_failures(account, days=7):
    """How often each add-on failed lately, worst first (files seen gone aren't add-on failures)."""
    return q("""SELECT addon, kind, count(*) AS n, max(at) AS last FROM source_failures
                WHERE account_id = %s AND kind <> 'seen_dead' AND at > now() - make_interval(days => %s)
                GROUP BY 1, 2 ORDER BY 3 DESC""", (account, days))


def record_sighting(account, video_id, addon, key):
    """One occasion a household's file looked gone (its key only). Anything older than 30 days goes."""
    with pool().connection() as c:
        c.execute("""INSERT INTO source_failures (account_id, video_id, addon, kind, detail)
                     VALUES (%s, %s, %s, 'seen_dead', %s)""", (account, video_id, (addon or "?")[:80], key[:64]))
        c.execute("DELETE FROM source_failures WHERE account_id = %s AND at < now() - interval '30 days'", (account,))


def forget_sightings(account, video_id, key):
    """A household's file seen gone that has played after all: its sightings go."""
    q("""DELETE FROM source_failures WHERE account_id = %s AND video_id = %s AND kind = 'seen_dead'
         AND detail = %s""", (account, video_id, key))


def file_health(account, video_id):
    """{file key: "dead" | "seen"} for a household's files of one video: dead when seen gone twice or more
    in 7 days at least 30 min apart; seen when seen gone in the last 24 h and not dead."""
    rows = q("""SELECT detail AS key, count(*) AS n, max(at) - min(at) >= interval '30 minutes' AS apart,
                       max(at) > now() - interval '24 hours' AS lately
                FROM source_failures
                WHERE account_id = %s AND video_id = %s AND kind = 'seen_dead' AND at > now() - interval '7 days'
                GROUP BY detail""", (account, video_id))
    out = {}
    for r in rows:
        if r["n"] >= 2 and r["apart"]:
            out[r["key"]] = "dead"
        elif r["lately"]:
            out[r["key"]] = "seen"
    return out



# ---------- The admin profile's PIN and its sessions (see adminpin.py) ----------

def pin_state(profile_id):
    """{"pin_hash", "pin_failures", "locked_for" (seconds the PIN is still locked, 0 if not), "is_admin",
    "account_id"} for one profile (worked out in the database's clock)."""
    return q("""SELECT pin_hash, pin_failures, is_admin, account_id,
                       greatest(0, ceil(extract(epoch FROM pin_locked_until - now())))::int AS locked_for
                FROM profiles WHERE id = %s""", (profile_id,), one=True)


def set_pin(profile_id, pin_hash):
    """A new PIN (or none): wrong tries forgotten, and every admin session for the profile ended."""
    with pool().connection() as c:
        c.execute("UPDATE profiles SET pin_hash = %s, pin_failures = 0, pin_locked_until = NULL WHERE id = %s",
                  (pin_hash, profile_id))
        c.execute("DELETE FROM admin_sessions WHERE profile_id = %s", (profile_id,))


def pin_failed(profile_id, lock_seconds=None):
    """Counts a wrong PIN, and locks the PIN for [lock_seconds] when given."""
    q("""UPDATE profiles SET pin_failures = pin_failures + 1,
                pin_locked_until = CASE WHEN %(s)s::int IS NULL THEN pin_locked_until ELSE now() + make_interval(secs => %(s)s) END
         WHERE id = %(p)s""", {"s": lock_seconds, "p": profile_id})


def pin_ok(profile_id):
    q("UPDATE profiles SET pin_failures = 0, pin_locked_until = NULL WHERE id = %s", (profile_id,))


def add_admin_session(token_hash, device_id, profile_id, seconds):
    q("""INSERT INTO admin_sessions (token_hash, device_id, profile_id, expires_at)
         VALUES (%s, %s, %s, now() + make_interval(secs => %s))""", (token_hash, device_id, profile_id, seconds))
    # Expired ones go as new ones come.
    q("DELETE FROM admin_sessions WHERE expires_at < now()")


def admin_session(token_hash, device_id, profile_id, seconds):
    """Renews a live admin session for this device and profile and returns when it now ends; None if
    there's no such session (or it has expired)."""
    r = q("""UPDATE admin_sessions SET expires_at = greatest(expires_at, now() + make_interval(secs => %s))
             WHERE token_hash = %s AND device_id = %s AND profile_id = %s AND expires_at > now()
             RETURNING expires_at""", (seconds, token_hash, device_id, profile_id), one=True)
    return r and r["expires_at"]


def end_admin_session(token_hash):
    q("DELETE FROM admin_sessions WHERE token_hash = %s", (token_hash,))


# ---------- Playback links (see playlinks.py) ----------

def add_play_links(token_hash, account_id, device_id, links, seconds):
    """Keeps a play answer's upstream links (a JSON list) for [seconds], encrypted."""
    with pool().connection() as c:
        c.execute("""INSERT INTO play_links (token_hash, account_id, device_id, links, expires_at)
                     VALUES (%(t)s, %(a)s, %(d)s, pgp_sym_encrypt(%(l)s, %(k)s), now() + make_interval(secs => %(s)s))""",
                  {"t": token_hash, "a": account_id, "d": device_id, "l": links, "k": os.environ["SECRETS_KEY"], "s": seconds})
        # Expired ones go as new ones come, a day on (until then a long pause can renew them: playlinks.renew).
        c.execute("DELETE FROM play_links WHERE expires_at < now() - interval '1 day'")


def play_links(token_hash, account=None):
    """The upstream links (JSON list) for a token that hasn't expired and whose device is still in the
    household (removing a device removes its rows), and of [account] when it's given; None otherwise."""
    r = q("""SELECT pgp_sym_decrypt(links, %(k)s) AS links FROM play_links
             WHERE token_hash = %(t)s AND expires_at > now() AND (%(a)s::uuid IS NULL OR account_id = %(a)s::uuid)""",
          {"t": token_hash, "k": os.environ["SECRETS_KEY"], "a": account}, one=True)
    return r and r["links"]


def play_link_row(token_hash, account=None):
    """(links JSON, the household it's for) for a token as play_links has it, or None."""
    r = q("""SELECT pgp_sym_decrypt(links, %(k)s) AS links, account_id FROM play_links
             WHERE token_hash = %(t)s AND expires_at > now() AND (%(a)s::uuid IS NULL OR account_id = %(a)s::uuid)""",
          {"t": token_hash, "k": os.environ["SECRETS_KEY"], "a": account}, one=True)
    return (r["links"], str(r["account_id"])) if r else None


def renewable_play_links(token_hash, account_id, device_id, seconds):
    """The upstream links (JSON) of one of [device_id]'s tokens, expired or not, up to [seconds] after
    it expired; None otherwise. They're only read here to be kept again under a new token."""
    r = q("""SELECT pgp_sym_decrypt(links, %(k)s) AS links FROM play_links
             WHERE token_hash = %(t)s AND account_id = %(a)s::uuid AND device_id = %(d)s::uuid
               AND expires_at > now() - make_interval(secs => %(s)s)""",
          {"t": token_hash, "a": account_id, "d": device_id, "k": os.environ["SECRETS_KEY"], "s": seconds}, one=True)
    return r and r["links"]


# ---------- Live TV (see livetv.py) ----------

def livetv_lists(account, cards=True):
    """The household's lists as last read: [{"list_id", "cards" (compressed JSON, decrypted; None if
    never read), "count", "read_at", "error"}]; without their cards when [cards] is False."""
    what = "pgp_sym_decrypt_bytea(cards, %(k)s)" if cards else "NULL"
    return q(f"""SELECT list_id, {what} AS cards, count, read_at, error, fields FROM livetv_lists
                 WHERE account_id = %(a)s""",
             {"a": account, "k": os.environ["SECRETS_KEY"]})


def livetv_streams(account):
    """Each list's stream addresses (compressed JSON, decrypted): [{"list_id", "streams"}]."""
    return q("""SELECT list_id, pgp_sym_decrypt_bytea(streams, %(k)s) AS streams FROM livetv_lists
                WHERE account_id = %(a)s AND streams IS NOT NULL""", {"a": account, "k": os.environ["SECRETS_KEY"]})


def save_livetv_list(account, list_id, cards, streams, count, fields=None):
    """A list just read: its cards and streams (compressed already), encrypted, and the attributes its
    items have ([{name, count}])."""
    q("""INSERT INTO livetv_lists (account_id, list_id, cards, streams, count, read_at, error, fields)
         VALUES (%(a)s, %(l)s, pgp_sym_encrypt_bytea(%(c)s, %(k)s), pgp_sym_encrypt_bytea(%(s)s, %(k)s), %(n)s, now(), NULL,
                 %(f)s)
         ON CONFLICT (account_id, list_id) DO UPDATE SET cards = EXCLUDED.cards, streams = EXCLUDED.streams,
             count = EXCLUDED.count, read_at = now(), error = NULL, fields = EXCLUDED.fields""",
      {"a": account, "l": list_id, "c": cards, "s": streams, "n": count,
       "f": Jsonb(fields) if fields is not None else None, "k": os.environ["SECRETS_KEY"]})


def livetv_list_failed(account, list_id, error):
    """A read that failed: its last channels stay (none for one never read)."""
    q("""INSERT INTO livetv_lists (account_id, list_id, read_at, error) VALUES (%s, %s, now(), %s)
         ON CONFLICT (account_id, list_id) DO UPDATE SET read_at = now(), error = EXCLUDED.error""",
      (account, list_id, error[:200]))


def remove_livetv_list(account, list_id):
    q("DELETE FROM livetv_lists WHERE account_id = %s AND list_id = %s", (account, list_id))


def livetv_favourites(profile):
    """The profile's channels, in the order added."""
    return [r["channel"] for r in q("SELECT channel FROM livetv_favourites WHERE profile_id = %s ORDER BY added_at",
                                    (profile,))]


def set_livetv_favourite(profile, channel, on):
    if on:
        q("INSERT INTO livetv_favourites (profile_id, channel) VALUES (%s, %s) ON CONFLICT DO NOTHING", (profile, channel))
    else:
        q("DELETE FROM livetv_favourites WHERE profile_id = %s AND channel = %s", (profile, channel))


def livetv_last_watched(profile, limit=5):
    """The channels the profile watched last, latest first."""
    return [r["channel"] for r in q("""SELECT channel FROM livetv_watched WHERE profile_id = %s
                                       ORDER BY last_at DESC LIMIT %s""", (profile, limit))]


def livetv_household_seconds(account):
    """{channel: seconds} watched by the household's profiles."""
    return {r["channel"]: int(r["s"]) for r in q(
        """SELECT channel, sum(seconds) AS s FROM livetv_watched
           WHERE profile_id IN (SELECT id FROM profiles WHERE account_id = %s) GROUP BY channel""", (account,))}


def livetv_watched(account, device, profile, channel, seconds, tz):
    """[seconds] more of [channel] for [profile], counted at the hour it is now in [tz]; a channel that
    plays isn't failing on this [device] any more."""
    with pool().connection() as c:
        c.execute("""INSERT INTO livetv_watched AS w (profile_id, channel, seconds, by_hour, last_at)
                     VALUES (%(p)s, %(c)s, %(s)s, array_fill(0, ARRAY[24]), now())
                     ON CONFLICT (profile_id, channel) DO UPDATE SET seconds = w.seconds + %(s)s, last_at = now()""",
                  {"p": profile, "c": channel, "s": seconds})
        c.execute("""UPDATE livetv_watched SET by_hour[extract(hour FROM now() AT TIME ZONE %(tz)s)::int + 1] =
                         by_hour[extract(hour FROM now() AT TIME ZONE %(tz)s)::int + 1] + %(s)s
                     WHERE profile_id = %(p)s AND channel = %(c)s""", {"p": profile, "c": channel, "s": seconds, "tz": tz})
        c.execute("DELETE FROM livetv_failures WHERE account_id = %s AND device_id = %s AND channel = %s",
                  (account, device, channel))


def livetv_failed(account, device, channel, gap_minutes, days):
    """One more failure on [device], unless the last was within [gap_minutes] (retries close together,
    or the internet down for a while, count once). One after the last had been hidden its [days]
    starts the count again."""
    q("""INSERT INTO livetv_failures AS f (account_id, device_id, channel) VALUES (%s, %s, %s)
         ON CONFLICT (account_id, device_id, channel) DO UPDATE
         SET times = CASE WHEN f.last_failed < now() - make_interval(days => %s) THEN 1 ELSE f.times + 1 END,
             last_failed = now()
         WHERE f.last_failed < now() - make_interval(mins => %s)""", (account, device, channel, days, gap_minutes))


def livetv_failures(account, device, times, days):
    """Channels hidden on [device] now: failed [times] in a row there, the last within [days].
    [{"channel", "times", "last_failed"}]"""
    return q("""SELECT channel, times, last_failed FROM livetv_failures WHERE account_id = %s AND device_id = %s
                AND times >= %s AND last_failed > now() - make_interval(days => %s)""", (account, device, times, days))
