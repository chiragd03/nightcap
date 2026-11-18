"""The household's sources and keys: its AIOStreams address (with its debrid setup), extra stream
add-ons, subtitle add-ons, and its AI (whose, the model, the key, an address for an OpenAI-compatible
service of its own, and the price when Nightcap doesn't know it). Kept encrypted (store.secrets); only ever shown masked;
each can be tested before or after it's saved.

An add-on is named by an id made from its address, so one can be removed without the page ever
seeing the address itself.

On a server with its own AIOStreams (aiostreams.py), a household without an AIOStreams address of its
own gets a setup there: without debrid keys, only what needs no debrid service (never torrents); with
the keys the admin gives, everything through them. It's kept up to date as they change.
Its extra stream add-ons are asked by the server itself, whichever AIOStreams it uses. An AIOStreams address the admin gives
still wins: the keys are kept, unused, until it's removed.
"""

import copy
import hashlib
import logging
import threading
import time
from contextlib import contextmanager
from urllib.parse import urlparse

from . import ai, aiostreams, cache, own_aiostreams, store
from .config import AT_HOME, MODEL, S
from .http import get_json

log = logging.getLogger(__name__)

# Where each kind of add-on is kept in the secrets.
LISTS = {"stream": "stream_urls", "subtitle": "subtitle_urls"}
MAX_ADDONS = S.household.max_addons
# A household's AIOStreams setup is checked (and made again if it's lost) at most this often.
REPAIR_EVERY_S = S.advanced.timeouts.aiostreams_repair_every_seconds
# After a saved add-on's address: its manifest asks to be called only as a last resort (a plugin, a
# separate service). Read from the manifest once and kept here, so its service, costly and asleep most of
# the time, isn't woken just to be asked again.
LAST_RESORT = "#nightcap-last-resort"
# How long a test waits for an add-on: one that's asked for by name (not yet saved, or a last resort, whose
# service is usually asleep and takes 10 to 15 s to wake) gets longer than the ones tested all at once.
TEST_S = S.advanced.timeouts.addon_test_seconds
TEST_SLEEPING_S = S.advanced.timeouts.addon_test_sleeping_seconds


def _id(url):
    # (Without the last-resort mark: an add-on's id can't change when the mark is added to it.)
    return hashlib.sha256(url.removesuffix(LAST_RESORT).encode()).hexdigest()[:12]


def mask_url(url):
    """https://host/…a1b2 (the add-on's address carries its keys in the path)."""
    p = urlparse(url)
    tail = p.path.removesuffix("/manifest.json").rstrip("/")[-4:]
    return f"{p.scheme}://{p.hostname}/…{tail}" if tail else f"{p.scheme}://{p.hostname}/"


def mask_key(key):
    return "••••" + key[-4:]


def _addon(url):
    """As the Sources and keys page shows it. It's said when it's a last resort: the page doesn't test those by
    itself, which would wake their service for nothing."""
    return {"id": _id(url), "address": mask_url(url), **({"lastResort": True} if url.endswith(LAST_RESORT) else {})}


class StillStarting(ValueError):
    """Nightcap's AIOStreams didn't answer (starting after a cold start, say): worth trying again soon."""


def managed(s):
    """Whether the household's AIOStreams is the setup this server made for it (not an address of its own)."""
    setup = s.get("aiostreams_setup")
    return bool(setup and s["aiostreams_url"] and s["aiostreams_url"] == setup.get("url"))


def overview(account_id):
    """What the Sources and keys page shows: everything masked, and which add-ons failed lately."""
    s = store.secrets(account_id)
    keys = s["debrid_keys"]
    return {
        "aiostreams": _addon(s["aiostreams_url"]) if s["aiostreams_url"] and not managed(s) else None,
        # Nightcap's own AIOStreams: offered when this server runs one; in use when the household's
        # AIOStreams is its setup there.
        "nightcapAiostreams": {
            "available": aiostreams.available(), "inUse": managed(s),
            "services": [{"id": k, "name": v, "key": mask_key(keys[k]) if keys.get(k) else None}
                         for k, v in own_aiostreams.services().items()],
        } if aiostreams.available() or keys else None,
        "streamAddons": [_addon(u) for u in s["stream_urls"]],
        "subtitleAddons": [_addon(u) for u in s["subtitle_urls"]],
        "ai": _ai(s) if s["ai_api_key"] else None,
        "providers": [{"id": k, "name": v, "needsBaseUrl": k == "other", "needsModel": True,
                       "defaultModel": MODEL if k == "anthropic" else None} for k, v in ai.PROVIDERS.items()],
        "failedLately": [{"addon": f["addon"], "kind": f["kind"], "times": f["n"], "last": f["last"].isoformat()}
                         for f in store.recent_failures(account_id)],
    }


def _ai(s):
    """The household's AI as the page shows it. [price]: what Nightcap counts it at (US dollars per million
    tokens, input and output; [0, 0] free), null when it isn't known: then its calls are made, their
    cost isn't counted and the monthly limit isn't applied."""
    price = ai.price_of({"provider": s["ai_provider"], "model": s["ai_model"], "price": s["ai_price"]})
    return {"provider": s["ai_provider"], "providerName": ai.PROVIDERS.get(s["ai_provider"], s["ai_provider"]),
            "key": mask_key(s["ai_api_key"]), "model": s["ai_model"],
            "baseUrl": mask_url(s["ai_base_url"]) if s["ai_base_url"] else None,
            "price": list(price) if price is not None else None}


def check_url(url):
    """An add-on's address as given, checked (ValueError otherwise)."""
    url = (url or "").strip()
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname or len(url) > 2000:
        raise ValueError("That isn't an add-on address (it starts with https://)")
    if not p.path.endswith("/manifest.json"):
        raise ValueError("An add-on's address ends with /manifest.json")
    return url


def check_key(provider, key):
    if provider not in ai.PROVIDERS:
        raise ValueError("Unknown AI provider")
    key = (key or "").strip()
    # (A service of the household's own may want no key at all: anything typed will do for it.)
    shortest = 1 if provider == "other" else 20
    if not shortest <= len(key) <= 300 or any(c.isspace() for c in key):
        raise ValueError("That doesn't look like an API key")
    return key


def check_model(model):
    model = (model or "").strip()
    if not model or len(model) > 200 or any(c.isspace() for c in model):
        raise ValueError("Choose the AI model (its id, like gpt-5-mini)")
    return model


def check_base_url(url):
    """An OpenAI-compatible service's address as given (https://host/v1), checked (ValueError otherwise).
    In the cloud only https (and, when it's fetched, only public addresses on ports 80 and 443: see
    http.py); at home http too, and the home network's own addresses."""
    url = (url or "").strip().rstrip("/")
    p = urlparse(url)
    schemes = ("http", "https") if AT_HOME else ("https",)
    if p.scheme not in schemes or not p.hostname or p.username or p.password or len(url) > 500:
        raise ValueError("That isn't an AI address (it starts with https://)")
    return url


def check_price(price):
    """[input, output] US dollars per million tokens ([0, 0]: free), or None."""
    if price is None:
        return None
    if (not isinstance(price, (list, tuple)) or len(price) != 2
            or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= 1000 for v in price)):
        raise ValueError("A price is two numbers: US dollars per million tokens in, and out")
    return [float(price[0]), float(price[1])]


def ai_settings(provider, key, model, base_url=None, price=None):
    """The AI's settings as ai.settings() gives them, each checked."""
    if provider not in ai.PROVIDERS:
        raise ValueError("Unknown AI provider")
    return {"provider": provider, "key": check_key(provider, key), "model": check_model(model),
            "base_url": check_base_url(base_url) if provider == "other" else None, "price": check_price(price)}


def _changed(account_id):
    """Sources changed: the add-on list is loaded again, and no source list found with the old ones is used."""
    cache.drop(f"addons:{account_id}")
    cache.memory.drop_prefix(f"play:{account_id}:")
    cache.drop_prefix(f"ready:{account_id}:")


def _sync(account_id, s, wait=False):
    """Brings the household's setup in Nightcap's AIOStreams in line with its keys (in [s], changed in
    place): made or updated, and its address the household's AIOStreams. Nothing while the household
    uses an AIOStreams address of its own.
    An add-on AIOStreams couldn't reach is left out for now: the setup isn't marked as made from the
    current template, so the next update (update_template, a few minutes on) puts it back.
    Raises ValueError when AIOStreams refuses or doesn't answer (then nothing is saved)."""
    if not aiostreams.available() or (s["aiostreams_url"] and not managed(s)):
        return
    deadline = time.time() + (aiostreams.WAIT_S if wait else 0)
    while True:
        try:
            setup, left_out = aiostreams.save(s.get("aiostreams_setup"), aiostreams.config(s["debrid_keys"]))
            break
        except aiostreams.Down as e:
            # Starting (after a cold start): waited for, when asked to, else said.
            if time.time() + 1 >= deadline:
                raise StillStarting(f"{e}: it may still be starting, try again in a moment")
            time.sleep(1)
        except aiostreams.Unavailable as e:
            raise ValueError(str(e))
    # (Which template it was made from: a changed template reaches it once, see update_template. Made
    # without an add-on: from none, and not tried again for a few minutes.)
    s["aiostreams_setup"], s["aiostreams_url"] = {**setup, "template": None if left_out else aiostreams.template_hash()}, setup["url"]
    if left_out:
        _updated[account_id] = time.time()


# The secrets a setup in Nightcap's AIOStreams changes (saved alone: see store.save_secrets' only).
_SETUP_SAVED = {"aiostreams_url", "aiostreams_setup"}


@contextmanager
def _held(account_id, wait=True):
    """The household's setup held while it's made or changed: on this copy of the server, then in the
    database (other copies). Gives the database connection to read and save on, or None when [wait] is
    False and it's held already."""
    lock = _lock(account_id)
    if not lock.acquire(blocking=wait):
        yield None
        return
    try:
        with store.setup_lock(account_id, wait) as conn:
            yield conn
    finally:
        lock.release()


# What the household's setup in Nightcap's AIOStreams is made from.
_SETUP_FIELDS = ("debrid_keys", "aiostreams_url")


def _save(account_id, change):
    """A change of the household's sources: under the setup's hold (a setup being made waits, and isn't
    lost to it), only what changed saved."""
    with _held(account_id) as conn:
        s = store.secrets(account_id, conn)
        before = copy.deepcopy(s)
        change(s)
        if {k: s.get(k) for k in _SETUP_FIELDS} != {k: before.get(k) for k in _SETUP_FIELDS}:
            _sync(account_id, s)
        store.save_secrets(account_id, s, conn, only={k for k in s if s[k] != before.get(k)})
    _changed(account_id)


def set_debrid(account_id, service, key):
    """A debrid service's key for Nightcap's AIOStreams, or key None to remove it."""
    if service not in own_aiostreams.services():
        raise LookupError("Unknown debrid service")
    if key is not None:
        if not aiostreams.available():
            raise ValueError("This server has no AIOStreams of its own: give an AIOStreams address instead")
        key = (key or "").strip()
        if not 8 <= len(key) <= 300 or any(c.isspace() for c in key):
            raise ValueError("That doesn't look like an API key")

    def change(s):
        keys = dict(s["debrid_keys"])
        if key:
            keys[service] = key
        else:
            keys.pop(service, None)
        s["debrid_keys"] = keys
    _save(account_id, change)


def ensure(account_id):
    """A household with no AIOStreams at all, on a server with its own: its setup there is made,
    waiting a little for AIOStreams if it's still starting. True if it was. One play makes it: another
    at the same time on this copy of the server waits for that one and doesn't try again itself (on
    another copy, it doesn't wait: its play says the sources are being set up). Should AIOStreams
    refuse the setup, it isn't asked again for a few minutes."""
    if not aiostreams.available() or time.time() - _repaired.get(account_id, 0) < REPAIR_EVERY_S:
        return False
    with _held(account_id, wait=False) as conn:
        made = _make(account_id, conn) if conn is not None else None
    if made is not None:
        # (Once saved and the hold let go: the add-on list is loaded again with it.)
        if made:
            _changed(account_id)
        return made
    # (Held: by a play on this copy, waited for; by another copy, not.)
    with _lock(account_id):
        return bool(store.secrets(account_id)["aiostreams_url"])


def _make(account_id, conn):
    s = store.secrets(account_id, conn)
    if s["aiostreams_url"]:
        return True
    try:
        _sync(account_id, s, wait=True)
    except StillStarting as e:
        # Not held back: the next play tries again (AIOStreams is likely up by then).
        log.warning("Couldn't make the AIOStreams setup yet: %s", e)
        return False
    except ValueError as e:
        _repaired[account_id] = time.time()
        log.warning("Couldn't make the AIOStreams setup: %s", e)
        return False
    store.save_secrets(account_id, s, conn, only=_SETUP_SAVED)
    return True


def setting_up(account_id):
    """Whether the household's sources are still being set up: this server has its own AIOStreams and
    the household's setup there isn't made yet (AIOStreams starting, or it refused for now)."""
    return aiostreams.available() and not store.secrets(account_id)["aiostreams_url"]


_locks = {}  # account id -> its setup's lock on this copy of the server
_locks_lock = threading.Lock()


def _lock(account_id):
    with _locks_lock:
        return _locks.setdefault(account_id, threading.Lock())


def resync(account_id):
    """Makes or updates the household's setup in Nightcap's AIOStreams from what's saved (after an
    import). Raises ValueError when AIOStreams refuses or doesn't answer."""
    with _held(account_id) as conn:
        s = store.secrets(account_id, conn)
        _sync(account_id, s)
        store.save_secrets(account_id, s, conn, only=_SETUP_SAVED)
    _changed(account_id)


_repaired = {}  # account id -> when its setup was last made again
_updated = {}  # account id -> when its setup was last brought up to a changed template


def update_template(account_id, s):
    """The household's setup in Nightcap's AIOStreams made from an older template (its fingerprint
    differs, or it has none, as when an add-on was left out): updated to the current one, once. Off
    the play's way (on a thread of its own: the play goes on with the setup as it is), only for a
    setup this server made, and tried again no sooner than REPAIR_EVERY_S if AIOStreams can't take it
    now (starting after a cold start, or the add-on still too slow)."""
    if not aiostreams.available() or not managed(s):
        return
    if (s.get("aiostreams_setup") or {}).get("template") == aiostreams.template_hash():
        return
    if time.time() - _updated.get(account_id, 0) < REPAIR_EVERY_S:
        return
    _updated[account_id] = time.time()
    threading.Thread(target=_update, args=(account_id,), name="aiostreams-update", daemon=True).start()


def _update(account_id):
    with _held(account_id, wait=False) as conn:
        if conn is None:
            return
        s = store.secrets(account_id, conn)
        if not managed(s) or (s.get("aiostreams_setup") or {}).get("template") == aiostreams.template_hash():
            return
        try:
            _sync(account_id, s)
        except ValueError as e:
            log.info("Couldn't bring the AIOStreams setup up to the template yet: %s", e)
            return
        store.save_secrets(account_id, s, conn, only=_SETUP_SAVED)
    _changed(account_id)
    log.info("Brought a household's AIOStreams setup up to the current template")


def repair(account_id):
    """The household's setup in Nightcap's AIOStreams didn't answer as an add-on: updated (made again
    if AIOStreams lost it, e.g. its database was reset). At most every few minutes, and not while it's
    being made or changed already; True if it was."""
    if time.time() - _repaired.get(account_id, 0) < REPAIR_EVERY_S:
        return False
    _repaired[account_id] = time.time()
    with _held(account_id, wait=False) as conn:
        if conn is None:
            return False
        s = store.secrets(account_id, conn)
        if not managed(s):
            return False
        try:
            _sync(account_id, s)
        except ValueError as e:
            log.warning("Couldn't repair the AIOStreams setup: %s", e)
            return False
        store.save_secrets(account_id, s, conn, only=_SETUP_SAVED)
    _changed(account_id)
    return True


def set_aiostreams(account_id, url):
    """The household's own AIOStreams address, or None to remove it (with debrid keys given, Nightcap's
    AIOStreams is used again)."""
    url = check_url(url) if url else None
    _save(account_id, lambda s: s.update(aiostreams_url=url))


def add_addon(account_id, kind, url):
    url = check_url(url)

    def change(s):
        found = s[LISTS[kind]]
        if url in found or url + LAST_RESORT in found:
            raise ValueError("That add-on is already there")
        if len(found) >= MAX_ADDONS:
            raise ValueError(f"At most {MAX_ADDONS} of these")
        found.append(url)
    _save(account_id, change)
    return _addon(url)


def remember_last_resort(account_id, url):
    """An extra add-on's manifest has asked to be called only as a last resort: kept with its address."""
    def change(s):
        s["stream_urls"] = [u + LAST_RESORT if u == url else u for u in s["stream_urls"]]
    _save(account_id, change)


def remove_addon(account_id, kind, addon_id):
    def change(s):
        before = s[LISTS[kind]]
        s[LISTS[kind]] = [u for u in before if _id(u) != addon_id]
        if len(s[LISTS[kind]]) == len(before):
            raise LookupError("No such add-on")
    _save(account_id, change)


def set_ai(account_id, provider, key, model=None, base_url=None, price=None):
    """The household's AI: whose (ai.PROVIDERS), the key, the model, the address ("other" only) and the
    price the household gives (needed only when Nightcap doesn't know it). Key None with a model keeps
    the saved key (the same provider's, and its address); key None without one removes the AI."""
    if key is None and model is None:
        _save(account_id, lambda s: s.update(ai_api_key=None, ai_provider=None, ai_model=None, ai_base_url=None, ai_price=None))
        return
    if key is None:
        key, base_url = _saved_key(account_id, provider, base_url)
    settings = ai_settings(provider, key, model, base_url, price)
    if provider == "openrouter" and settings["price"] is None:
        # (Its price as OpenRouter lists it, asked once now: what each call may cost is checked against the
        # limit before OpenRouter says what it did cost.)
        found = ai.openrouter_price(settings["key"], settings["model"])
        settings["price"] = list(found) if found else None
    _save(account_id, lambda s: s.update(ai_api_key=settings["key"], ai_provider=provider, ai_model=settings["model"],
                                         ai_base_url=settings["base_url"], ai_price=settings["price"]))


def _saved_key(account_id, provider, base_url=None):
    """The saved AI key and address, when they're [provider]'s (ValueError otherwise). The saved key goes
    only to its saved address: [base_url], when given, must be that one (another needs the key again)."""
    saved = store.secrets(account_id)
    if not saved["ai_api_key"] or saved["ai_provider"] != provider:
        raise ValueError(f"Enter the key for {ai.PROVIDERS.get(provider, 'that AI')}")
    if provider == "other" and base_url and check_base_url(base_url) != saved["ai_base_url"]:
        raise ValueError("Enter the key again to use another address")
    return saved["ai_api_key"], saved["ai_base_url"]


def with_saved_key(account_id, provider, model, base_url=None):
    """The AI's settings for [model] with the saved key of [provider] (and its saved address): to test
    a model before it's saved. The saved price goes with it when it's the saved model."""
    key, saved_url = _saved_key(account_id, provider, base_url)
    saved = store.secrets(account_id)
    price = saved["ai_price"] if model == saved["ai_model"] else None
    return ai_settings(provider, key, model, saved_url, price)


def test_addon(url, timeout=TEST_S):
    """{"ok", "name"?, "lastResort"?, "error"?}: whether the add-on answers with a manifest."""
    try:
        m = get_json(url.removesuffix(LAST_RESORT), retries=0, timeout=timeout)
    except Exception:
        # The same words whatever went wrong, so the answer can't map which hosts and ports exist.
        return {"ok": False, "error": "Couldn't reach that add-on"}
    if not isinstance(m, dict) or not m.get("resources"):
        return {"ok": False, "error": "That address answered, but not like an add-on"}
    return {"ok": True, "name": m.get("name"), "version": m.get("version"),
            **({"lastResort": True} if (m.get("nightcap") or {}).get("lastResort") else {})}


def test_key(settings, profile):
    """{"ok", "error"?}: whether the AI ([settings] as ai_settings gives them) answers with its model. One
    small real answer, charged to [profile]."""
    ok, why = ai.key_works(settings, profile)
    return {"ok": True} if ok else {"ok": False, "error": why}


def ai_models(account_id, provider, key=None, base_url=None):
    """The models the key can use (see ai.models): the one given, else the saved one (the same provider's)."""
    if provider not in ai.PROVIDERS:
        raise ValueError("Unknown AI provider")
    if key is None:
        key, base_url = _saved_key(account_id, provider, base_url)
    return ai.models({"provider": provider, "key": check_key(provider, key), "model": None, "price": None,
                      "base_url": check_base_url(base_url) if provider == "other" else None})


def test_saved(account_id, what, addon_id=None, profile=None):
    """Tests one saved source: "aiostreams", "ai" (its call charged to [profile]), or a "stream"/"subtitle"
    add-on by its id."""
    s = store.secrets(account_id)
    if what == "aiostreams":
        if not s["aiostreams_url"]:
            raise LookupError("No AIOStreams address is set")
        return test_addon(s["aiostreams_url"])
    if what == "ai":
        if not s["ai_api_key"]:
            raise LookupError("No AI key is set")
        if not s["ai_model"]:
            raise LookupError("Choose the AI model first")
        return test_key(ai.settings(account_id), profile)
    url = next((u for u in s[LISTS[what]] if _id(u) == addon_id), None)
    if not url:
        raise LookupError("No such add-on")
    marked = url.endswith(LAST_RESORT)
    result = test_addon(url, TEST_SLEEPING_S if marked else TEST_S)
    # (A test that finds out first saves the wake-ups a first play would otherwise have to.)
    if what == "stream" and result.get("lastResort") and not marked:
        remember_last_resort(account_id, url)
    return result
