"""Moving households to another server: the owner exports one household, or all of them, as one
file locked with a password, and imports it on the new server. Everything a household has comes
along (its profiles, devices, sources and keys, and every profile's library, history, ratings, AI
picks, sent links and saved pages), with the same ids, so its TVs carry on once they're pointed at
the new address: no joining again, no picking who's watching again.

The shows and episodes the household has used come too (the new server would fetch them again
anyway; this way its Home looks the same at once). Not moved: Play on TV requests (they last
seconds) and other households' pages.

The file is OpenPGP (AES-256, password-based; `gpg -d` opens it too) around JSON. Tables go in and
out as Postgres's own JSON for their rows, so dates, numbers and pictures come back exactly. The
sources and keys are in it decrypted (the file's password is their lock), and saved again under
the new server's key.
"""

import json
import logging
from datetime import datetime, timezone

from . import cache, livetv, sources, store
from .config import S, SERVER_NAME
from .errors import NotFound

log = logging.getLogger(__name__)

FORMAT, VERSION = "nightcap-households", 1
MIN_PASSWORD = S.security.export_password_min

# Where each table's rows for a household are: (table, how its rows belong to the household).
HOUSEHOLD = [("accounts", "id = %(a)s"), ("profiles", "account_id = %(a)s"), ("devices", "account_id = %(a)s"),
             ("ai_usage", "account_id = %(a)s"), ("source_failures", "account_id = %(a)s"),
             ("livetv_failures", "account_id = %(a)s")]
BY_PROFILE = ["library", "episode_watched", "watch_events", "interactions", "ratings", "not_interested", "prompts",
              "recent_searches", "recommendations", "row_stats", "sent_links", "livetv_favourites", "livetv_watched",
              "my_list"]
PROFILES = "(SELECT id FROM profiles WHERE account_id = %(a)s)"
# The household's saved pages (kept by profile: "{profile id}|…").
LOOKUPS = "key LIKE ANY (SELECT id::text || '|%%' FROM profiles WHERE account_id = %(a)s)"
# The shows and episodes it has used (and put on a My List, so their cards come along).
USED = f"""(SELECT imdb_id FROM library WHERE profile_id IN {PROFILES}
            UNION SELECT imdb_id FROM episode_watched WHERE profile_id IN {PROFILES}
            UNION SELECT imdb_id FROM watch_events WHERE profile_id IN {PROFILES}
            UNION SELECT imdb_id FROM my_list WHERE profile_id IN {PROFILES})"""
SHARED = ["titles", "episodes"]
# Kept another way, or not moved.
OTHER = {"account_secrets": "decrypted, saved again under the new server's key",
         "lookups": "the household's own pages only", "tv_requests": "Play on TV requests last seconds",
         "admin_sessions": "an unlocked admin session ends on moving (the PIN itself comes along)",
         "play_links": "playback links last hours; the TV asks for new ones",
         "livetv_lists": "Live TV's channel lists are read again from their addresses (in the secrets)",
         "wrong_tries": "wrong join codes and owner keys, kept minutes",
         "invites": "their codes are keyed to this server's SECRETS_KEY: the owner makes new ones there",
         "schema_applied": "the server's own note of which table setup it applied, not a household's",
         "own_aiostreams": "the template the server's owner chose, not a household's",
         "ai_picks": "the AI's answers, kept a few months for this server's recommendations"}


class WrongPassword(Exception):
    pass


def _check_covered():
    """Every table is moved or left out on purpose: one added later can't be forgotten here."""
    known = {t for t, _ in HOUSEHOLD} | set(BY_PROFILE) | set(SHARED) | set(OTHER)
    tables = {r["table_name"] for r in store.q(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")}
    if missing := sorted(tables - known):
        raise RuntimeError(f"Moving households doesn't cover the table(s) {', '.join(missing)} yet")


def _rows(table, where, account):
    """The rows as Postgres's JSON (text, so numbers keep every digit)."""
    return store.q(f"SELECT coalesce(json_agg(t), '[]')::text AS rows FROM {table} t WHERE {where}",
                   {"a": account}, one=True)["rows"]


def _household(account):
    tables = [(t, _rows(t, where, account)) for t, where in HOUSEHOLD]
    tables += [(t, _rows(t, f"profile_id IN {PROFILES}", account)) for t in BY_PROFILE]
    tables.append(("lookups", _rows("lookups", LOOKUPS, account)))
    tables += [(t, _rows(t, f"imdb_id IN {USED}", account)) for t in SHARED]
    found = store.account(account)
    head = json.dumps({"id": str(account), "name": found["name"], "secrets": store.secrets(account)})
    return head[:-1] + ', "tables": {' + ", ".join(f"{json.dumps(t)}: {rows}" for t, rows in tables) + "}}"


def export(accounts, password):
    """The households (ids; None for every one) as one locked file, and a name for it."""
    _check_covered()
    if len(password or "") < MIN_PASSWORD:
        raise ValueError(f"The password needs at least {MIN_PASSWORD} characters")
    every = [str(h["id"]) for h in store.household_list()]
    chosen = every if accounts is None else [str(a) for a in accounts]
    if not chosen or any(a not in every for a in chosen):
        raise NotFound("No such household")
    doc = (json.dumps({"format": FORMAT, "version": VERSION, "server": SERVER_NAME,
                       "exported": datetime.now(timezone.utc).isoformat()})[:-1]
           + ', "households": [' + ", ".join(_household(a) for a in chosen) + "]}")
    locked = store.q("SELECT pgp_sym_encrypt_bytea(convert_to(%s, 'UTF8'), %s, 'cipher-algo=aes256, compress-algo=2') AS f",
                     (doc, password), one=True)["f"]
    name = "all-households" if accounts is None else store.account(chosen[0])["name"] if len(chosen) == 1 else "households"
    slug = "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-") or "household"
    return bytes(locked), f"nightcap-{slug}-{datetime.now(timezone.utc):%Y-%m-%d}.nightcap"


def _columns(c, table):
    """The table's columns here, less ids this server numbers itself (they'd clash with its own)."""
    return [r["column_name"] for r in c.execute(
        """SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = %s
           AND is_identity = 'NO' AND coalesce(column_default, '') NOT LIKE 'nextval(%%'
           ORDER BY ordinal_position""", (table,)).fetchall()]


def import_file(locked, password, replace=(), check=False):
    """Brings in the households in a file made by export(). One not on this server is created; one
    that's here already is replaced by the file's copy if its id is in [replace] (True: every one
    that's here), and otherwise skipped. With [check], nothing is changed: the answer says which are
    new and which are here (under what name here), for the owner to choose before anything is
    replaced. Refused whole, with nothing changed, if the file holds rows that aren't its own
    households' (an edited file). Answers each household with what happened to it."""
    _check_covered()
    try:
        doc = store.q("SELECT convert_from(pgp_sym_decrypt_bytea(%s, %s), 'UTF8') AS d", (locked, password), one=True)["d"]
    except Exception:
        raise WrongPassword()
    head = json.loads(doc)
    if head.get("format") != FORMAT:
        raise ValueError("That isn't a Nightcap households file")
    if head.get("version", 0) > VERSION:
        raise ValueError("That file is from a newer Nightcap server: update this one first")
    households = head["households"]
    for h in households:
        _check_own(h)
    # Here already, by id, with the name it has here (a file could carry another household's id
    # under its own name: the owner sees both before choosing).
    here = {str(h["id"]): found["name"] for h in households if (found := store.account(h["id"]))}
    listing = [{"id": str(h["id"]), "name": h["name"], "here": str(h["id"]) in here, "nameHere": here.get(str(h["id"])),
                "profiles": len(h["tables"].get("profiles") or []), "devices": len(h["tables"].get("devices") or [])}
               for h in households]
    if check:
        return listing
    chosen = set(here) if replace is True else {str(r) for r in replace or ()} & set(here)
    # What the households being replaced have now, for clearing the server's caches once they're gone.
    old = {a: {"profiles": [str(r["id"]) for r in store.q("SELECT id FROM profiles WHERE account_id = %s", (a,))],
               "keys": [r["key_hash"] for r in store.q("SELECT key_hash FROM devices WHERE account_id = %s", (a,))]}
           for a in chosen}
    order = [t for t, _ in HOUSEHOLD] + BY_PROFILE + ["lookups"] + SHARED
    with store.pool().connection() as c, c.transaction():
        c.execute("CREATE TEMP TABLE moving (doc json) ON COMMIT DROP")
        c.execute("INSERT INTO moving VALUES (%s)", (doc,))
        # Replacing: the household as it is here goes first (everything in it goes with it; its saved
        # pages aren't tied to it, so they go by their profiles).
        for a in chosen:
            c.execute("DELETE FROM lookups WHERE key LIKE ANY (SELECT id::text || '|%%' FROM profiles WHERE account_id = %s)", (a,))
            c.execute("DELETE FROM accounts WHERE id = %s", (a,))
        for i, h in enumerate(households):
            if str(h["id"]) in here and str(h["id"]) not in chosen:
                continue
            for table in order:
                cols = ", ".join(f'"{col}"' for col in _columns(c, table) if col in _keys(h, table))
                if not cols:
                    continue
                rows = f"json_populate_recordset(null::{table}, (SELECT doc -> 'households' -> {i} -> 'tables' -> '{table}' FROM moving))"
                # Shows and pages already here (another household's) stay as they are.
                keep = " ON CONFLICT DO NOTHING" if table in SHARED or table == "lookups" else ""
                c.execute(f"INSERT INTO {table} ({cols}) SELECT {cols} FROM {rows}{keep}")
            # Invites don't move (their hash is keyed to the other server's SECRETS_KEY): the owner
            # makes a new one here.
            c.execute("""UPDATE accounts SET join_code = NULL, join_code_hash = NULL, join_code_expires = NULL
                         WHERE id = %s""", (h["id"],))
            # Its sources and keys in the same go: all of the household comes in, or none of it.
            s = h["secrets"]
            # Its setup in the other server's own AIOStreams isn't here: it's made again here from its
            # debrid keys, once the import is in (below).
            setup = s.get("aiostreams_setup")
            if setup:
                s = {**s, "aiostreams_setup": None,
                     "aiostreams_url": None if s.get("aiostreams_url") == setup.get("url") else s.get("aiostreams_url")}
            # (A household that never set any is left without, as it was.)
            if any(s.get(k) for k in ("aiostreams_url", "subtitle_urls", "stream_urls", "ai_api_key",
                                      "debrid_keys", "livetv_urls")):
                store.save_secrets(h["id"], s, conn=c)
    # Households with debrid keys get their setup in this server's own AIOStreams (if it runs one). An
    # AIOStreams that doesn't answer now isn't the import's failure: the admin saves a key again later.
    for h in households:
        if (str(h["id"]) not in here or str(h["id"]) in chosen) and (h["secrets"].get("debrid_keys") or {}):
            try:
                sources.resync(h["id"])
            except Exception:
                log.exception("Couldn't make the AIOStreams setup of an imported household")
    # Nothing the server kept in memory about the old ones may outlive them (a removed device's key,
    # an old profile's pages, the old sources).
    for a, was in old.items():
        for key in was["keys"]:
            cache.drop(f"device:{key}")
        for p in was["profiles"]:
            cache.drop_prefix(f"{p}|")
        cache.drop(f"addons:{a}")
        cache.memory.drop_prefix(f"play:{a}:")
        livetv.forget(a)
    return [{**row, "status": "replaced" if row["id"] in chosen else "skipped" if row["here"] else "created",
             "replaced": row["id"] in chosen} for row in listing]


def _check_own(h):
    """Every row in a household's part of the file is that household's own: its account, its
    profiles and devices (none of them already on this server), and rows only for those profiles.
    A file edited to slip rows into another household here (a device, an admin profile) is refused
    whole."""
    t, account = h["tables"], str(h["id"])

    def refuse(what):
        raise ValueError(f"That file doesn't hold {h.get('name') or 'a household'} alone ({what}): not imported")

    if [str(r.get("id")) for r in t.get("accounts") or []] != [account]:
        refuse("its household")
    profiles = {str(r.get("id")) for r in t.get("profiles") or []}
    if any(str(r.get("account_id")) != account for r in t.get("profiles") or []):
        refuse("profiles")
    for table in ("devices", "ai_usage", "source_failures", "livetv_failures"):
        for r in t.get(table) or []:
            if str(r.get("account_id")) != account or (r.get("profile_id") and str(r["profile_id"]) not in profiles):
                refuse(table)
    for table in BY_PROFILE:
        if any(str(r.get("profile_id")) not in profiles for r in t.get(table) or []):
            refuse(table)
    if any(not any(str(r.get("key", "")).startswith(f"{p}|") for p in profiles) for r in t.get("lookups") or []):
        refuse("saved pages")
    devices = t.get("devices") or []
    # A play is on one of its own devices, or none (a hand-edited file could point its history at
    # another household's TV, which that household's admin would then see).
    own_devices = {str(d.get("id")) for d in devices}
    if any(r.get("device_id") and str(r["device_id"]) not in own_devices for r in t.get("watch_events") or []):
        refuse("plays on devices that aren't its own")
    # (Its own may be here already: a household being replaced.)
    if store.q("SELECT 1 FROM profiles WHERE id::text = ANY(%s) AND account_id::text <> %s LIMIT 1",
               (list(profiles), account), one=True):
        refuse("profiles of another household here")
    if store.q("""SELECT 1 FROM devices WHERE (id::text = ANY(%s) OR key_hash = ANY(%s)) AND account_id::text <> %s
                  LIMIT 1""", ([str(d.get("id")) for d in devices], [str(d.get("key_hash")) for d in devices], account),
               one=True):
        refuse("devices of another household here")


def _keys(household, table):
    """The columns the file has for a table (from its first row)."""
    rows = household["tables"].get(table) or []
    return set(rows[0]) if rows else set()
