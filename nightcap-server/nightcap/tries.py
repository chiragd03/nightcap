"""Wrong tries (join codes, the owner key), counted per address so whoever guesses is held back,
not everyone. Kept in the database, so every copy of the server counts the same ones (a container,
several, or serverless). Only joining and the owner's pages touch it: a read when a code or key
comes in, a write when it's wrong.

The address is the connection's, or behind a load balancer (TRUSTED_PROXY set) the last one in
X-Forwarded-For, which the load balancer adds itself (the ones before it can be made up). Only a
hash of it is kept, for WINDOW_S.
"""

import hashlib

from . import store
from .config import S, TRUSTED_PROXY

WINDOW_S = S.security.tries_window_minutes * 60
# Wrong tries in WINDOW_S: from one address, and from everyone (a backstop against guessing from
# many addresses at once; None for none).
LIMITS = {"join": (S.security.join_tries_per_address, S.security.join_tries_total),
          "owner": (S.security.owner_tries_per_address, None)}


class TooMany(Exception):
    pass


def address(request):
    """Who's asking: a hash of the client's address."""
    found = request.client.host if request.client else ""
    if TRUSTED_PROXY:
        forwarded = [a.strip() for a in request.headers.get("x-forwarded-for", "").split(",") if a.strip()]
        found = forwarded[-1] if forwarded else found
    return hashlib.sha256(found.encode()).hexdigest()[:32]


def check(kind, who):
    """Raises TooMany when [who], or everyone, has had too many wrong tries of [kind] lately."""
    mine, everyone = LIMITS[kind]
    seen = store.wrong_tries(kind, who, WINDOW_S)
    if seen["mine"] >= mine or (everyone is not None and seen["all"] >= everyone):
        raise TooMany()


def failed(kind, who):
    store.add_wrong_try(kind, who, WINDOW_S)
