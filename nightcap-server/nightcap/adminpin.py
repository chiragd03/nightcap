"""The admin profile's PIN, and the admin sessions it unlocks.

Naming the admin profile in X-Profile isn't enough to act as the household's admin: admin
actions (sources and keys, devices, adding or removing profiles, the household's settings) need an
admin session too, sent as X-Admin-Session. A device gets one by giving the admin profile's PIN; it
lasts SESSION_S and is renewed while it's used. Only its hash is kept.

A household whose admin profile has no PIN yet sets one the first time an admin action is asked
for (the person at the admin profile then, which is why this should be done before the server is
on the internet). After that, changing the PIN needs an admin session, and the server's owner can
reset it (owner.py) when it's forgotten.

Wrong PINs: after LOCK_AFTER in a row, the PIN is locked for LOCK_S, doubling with each lock, so
guessing even a 4-digit PIN takes years.
"""

import hashlib
import hmac
import re
import secrets

from . import store
from .config import S
from .errors import Forbidden

SESSION_S = S.security.admin_session_minutes * 60
LOCK_AFTER = S.security.pin_tries_before_lock
LOCK_S = S.security.pin_lock_minutes * 60
PIN = re.compile(rf"^\d{{{S.security.pin_min_digits},{S.security.pin_max_digits}}}$")

# scrypt: memory-hard, so a stolen hash is slow to guess offline too.
_N, _R, _P = 2 ** 14, 8, 1


class PinNeeded(Exception):
    """The admin profile has no PIN yet: one has to be set first."""


class Locked(Exception):
    def __init__(self, seconds):
        super().__init__("Too many wrong PINs")
        self.seconds = seconds


class WrongPin(Exception):
    def __init__(self, tries_left):
        super().__init__("That isn't the admin PIN")
        self.tries_left = tries_left


def _hash_pin(pin):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(pin.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=32)
    return f"scrypt${salt.hex()}${digest.hex()}"


def _matches(pin, stored):
    try:
        _, salt, digest = stored.split("$")
        found = hashlib.scrypt(pin.encode(), salt=bytes.fromhex(salt), n=_N, r=_R, p=_P, dklen=32)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(found.hex(), digest)


def _token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def _admin(profile_id):
    state = store.pin_state(profile_id)
    if not state or not state["is_admin"]:
        raise Forbidden("Only the household's admin profile can do that")
    return state


def _check_pin_format(pin):
    if not PIN.match(str(pin or "")):
        raise ValueError(f"A PIN is {S.security.pin_min_digits} to {S.security.pin_max_digits} digits")


def _new_session(device_id, profile_id):
    token = secrets.token_urlsafe(32)
    store.add_admin_session(_token_hash(token), device_id, profile_id, SESSION_S)
    return {"session": token, "expiresIn": SESSION_S}


def status(device_id, profile_id, token):
    """{"pinSet", "unlocked"} for the admin profile on this device."""
    state = _admin(profile_id)
    unlocked = bool(token) and store.admin_session(_token_hash(token), device_id, profile_id, SESSION_S) is not None
    return {"pinSet": bool(state["pin_hash"]), "unlocked": unlocked}


def unlock(device_id, profile_id, pin):
    """An admin session for this device, given the admin profile's PIN."""
    state = _admin(profile_id)
    if not state["pin_hash"]:
        raise PinNeeded()
    if state["locked_for"] > 0:
        raise Locked(state["locked_for"])
    if not _matches(str(pin or ""), state["pin_hash"]):
        # Every LOCK_AFTER-th wrong PIN in a row locks it, for twice as long each time: 15 minutes, 30, an hour…
        failures = state["pin_failures"] + 1
        lock = LOCK_S * 2 ** (failures // LOCK_AFTER - 1) if failures % LOCK_AFTER == 0 else None
        store.pin_failed(profile_id, lock)
        if lock:
            raise Locked(lock)
        raise WrongPin(LOCK_AFTER - failures % LOCK_AFTER)
    store.pin_ok(profile_id)
    return _new_session(device_id, profile_id)


def set_pin(device_id, profile_id, pin, token=None):
    """Sets the admin profile's PIN: the first one freely, a new one only with an admin session. Ends
    every other admin session, and answers a new one for this device."""
    state = _admin(profile_id)
    _check_pin_format(pin)
    if state["pin_hash"] and not (token and store.admin_session(_token_hash(token), device_id, profile_id, SESSION_S)):
        raise Forbidden("Unlock with the current PIN first")
    store.set_pin(profile_id, _hash_pin(str(pin)))
    return _new_session(device_id, profile_id)


def lock(token):
    """Ends this admin session (the device locks admin again)."""
    if token:
        store.end_admin_session(_token_hash(token))


def require(device_id, profile_id, token):
    """For every admin action: the named profile must be the admin, and this device must have a live
    admin session for it. Raises PinNeeded (no PIN yet) or Forbidden."""
    state = _admin(profile_id)
    if not state["pin_hash"]:
        raise PinNeeded()
    if not token or store.admin_session(_token_hash(token), device_id, profile_id, SESSION_S) is None:
        raise Forbidden("Unlock admin with the PIN first")


def unlocked(device_id, profile_id, token):
    """Whether this device has the admin unlocked for this profile, without renewing its session: for
    pages that ask again by themselves (the Devices panel every 20 seconds), which mustn't keep admin
    unlocked while they're open. Never raises."""
    try:
        return bool(token) and bool(_admin(profile_id)["pin_hash"]) and store.admin_session_live(
            _token_hash(token), device_id, profile_id)
    except Exception:
        return False


def reset(profile_id):
    """The owner clears a forgotten PIN: the household sets a new one at its next admin action."""
    store.set_pin(profile_id, None)

