"""The server's owner: whoever deployed it, proved by the owner key (OWNER_KEY, set when the server
is deployed; sent as X-Owner-Key). The owner creates, renames and deletes households, picks each
one's admin profile, and makes its invites (a join code each, for one device, and the web app's
/join#{code} link; its admin can make them too). A household's admin manages the household but
can't change who the admin is.

No key set: there's no owner, and these are refused.
"""

import hmac
import re

from . import accounts, adminpin, cache, store, tries
from .config import OWNER_KEY, S
from .errors import Forbidden, NotFound

AVATAR = re.compile(r"^[a-z0-9_]{1,40}$")
TooManyTries = tries.TooMany
MIN_OWNER_KEY = S.security.owner_key_min


def check(key, who):
    """Raises unless [key] is the owner key. Wrong keys are counted per address ([who], see
    tries.py): whoever guesses is held back, and the owner elsewhere still gets in."""
    if not OWNER_KEY:
        raise Forbidden("This server has no owner key set")
    # The master key (every household, every secret in an export): a short one could be guessed.
    if len(OWNER_KEY) < MIN_OWNER_KEY:
        raise Forbidden(f"This server's owner key is too short: set OWNER_KEY to at least {MIN_OWNER_KEY} characters")
    tries.check("owner", who)
    if not hmac.compare_digest((key or "").encode(), OWNER_KEY.encode()):
        tries.failed("owner", who)
        raise Forbidden("That isn't the owner key")


def invite_json(made):
    """A just-made invite: its code (shown this once: only a hash is kept), the web app's link (the code
    after #, so it never reaches a server log), its name, and when it expires unused."""
    code, row = made
    return {"id": str(row["id"]), "code": code, "path": f"/app/join#{code}", "label": row["label"],
            "expiresAt": row["expires_at"].isoformat()}


def households():
    return [{"id": str(h["id"]), "name": h["name"], "created": h["created_at"].isoformat(),
             "admin": {"id": str(h["admin_id"]), "name": h["admin_name"]} if h["admin_id"] else None,
             "profiles": h["profiles"], "devices": h["devices"],
             "openInvites": h["open_invites"]}
            for h in store.household_list()]


def _name(value, what, longest):
    name = " ".join(str(value or "").split())
    if not 1 <= len(name) <= longest:
        raise ValueError(f"{what} needs 1 to {longest} characters")
    return name


def create(name, admin_name, admin_avatar=None, invite_name=None):
    """A new household with its first (admin) profile, and its invite, named for who it's for."""
    name = _name(name, "A household's name", S.names.household)
    admin_name = _name(admin_name, "The admin profile's name", S.names.profile)
    if admin_avatar is not None and not AVATAR.match(str(admin_avatar)):
        raise ValueError("Unknown avatar")
    # (Checked first: a household made and then refused its invite would be left with none.)
    invite_name = accounts.label(invite_name)
    account = store.create_household(name, admin_name, admin_avatar)
    made = accounts.new_invite(account, invite_name)
    return {**next(h for h in households() if h["id"] == str(account)), "invite": invite_json(made)}


def rename(account_id, name):
    if not store.rename_household(account_id, _name(name, "A household's name", S.names.household)):
        raise NotFound("No such household")


def delete(account_id, confirm):
    """Deletes a household and everything in it ([confirm] must be its name, as a check). Its TVs
    and browsers stop working at once."""
    found = next((h for h in store.household_list() if str(h["id"]) == str(account_id)), None)
    if not found:
        raise NotFound("No such household")
    if confirm != found["name"]:
        raise ValueError("To delete a household, confirm with its name")
    for key_hash in store.delete_household(account_id) or []:
        cache.drop(f"device:{key_hash}")


def set_admin(account_id, profile_id):
    if not store.set_household_admin(account_id, profile_id):
        raise NotFound("No such profile in that household")
    # Pages that show admin-only parts (the AI's cost) are built again.
    cache.drop_prefix(f"{profile_id}|")


def reset_admin_pin(account_id):
    """Clears the household admin profile's PIN (forgotten): it sets a new one at its next admin action."""
    admin = next((p for p in store.profiles(account_id) if p["is_admin"]), None)
    if not admin:
        raise NotFound("That household has no admin profile")
    adminpin.reset(admin["id"])


def new_invite(account_id, label=None):
    """A new one-time invite (its code and link) for the household, named [label]; the others it has
    open keep working."""
    made = accounts.new_invite(account_id, label, "owner")
    if not made:
        raise NotFound("No such household")
    return invite_json(made)


def invites(account_id):
    if not store.account(account_id):
        raise NotFound("No such household")
    return accounts.invites(account_id)
