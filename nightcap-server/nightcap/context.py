"""Which profile the current request (or background job) is for.

The API sets it for each request from the X-Profile header (see api.py); background work runs
as the profile it was started for (for_me, as_profile). Nothing falls back to another profile:
work with no profile is a bug, and me() says so.
"""

from contextlib import contextmanager
from contextvars import ContextVar

_profile = ContextVar("profile", default=None)


class NoProfile(RuntimeError):
    pass


def me():
    """The id of the profile this request (or background job) is for."""
    profile_id = _profile.get()
    if profile_id is None:
        raise NoProfile("No profile named for this work")
    return profile_id


@contextmanager
def as_profile(profile_id):
    token = _profile.set(profile_id)
    try:
        yield
    finally:
        _profile.reset(token)


def set_profile(profile_id):
    """For the API: this request is for [profile_id] (the request's own context ends with it)."""
    _profile.set(profile_id)


def for_me(fn):
    """fn, run as the current profile: for work handed to another thread."""
    profile_id = me()

    def run(*args):
        with as_profile(profile_id):
            return fn(*args)
    return run


# Cached pages that show a profile's own watch state, taste or settings; the rest are shared.
PROFILE_PAGES = ("launcher", "title:", "similar:", "browse:")


def scoped(key):
    return f"{me()}|{key}" if key.startswith(PROFILE_PAGES) else key
