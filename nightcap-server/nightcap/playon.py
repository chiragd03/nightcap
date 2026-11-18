"""Play on TV: the web app sends a title from the catalogue, or any link, to one of the household's
TVs. The TV picks it up with its check every 10 seconds (only while its screen is on), and whoever
is at the TV says yes or no.

A title plays as the profile that sent it (the TV switches to it); a link plays on the profile
that's on the TV. Whether a TV is off is known without it writing anything every 10 seconds: one
not used for OFF_AFTER_S (longer than its "last used" is saved apart, see devices.py, so one in use
never looks off) is off at once; otherwise a request it hasn't picked up within PICKUP_S is unreachable. Nothing is kept for
later.
"""

import re
from urllib.parse import urlparse

from . import store
from .config import S
from .errors import NotFound
from .http import cinemeta
from .titles import title_extras

OFF_AFTER_S = S.advanced.devices.tv_off_after_minutes * 60
PICKUP_S = S.advanced.devices.play_on_tv_pickup_seconds
# How long a request can go unanswered once sent: picking up, Nightcap coming up, the TV's own minute
# to answer, and adding a link.
SHOWN_S = 120
KEEP_S = S.advanced.devices.play_on_tv_kept_hours * 3600
VIDEO_ID = re.compile(r"^tt\d+(:\d+:\d+)?$")


class Off(Exception):
    """The TV is off, asleep or unreachable."""


def _describe_title(ctype, vid):
    """What the pop-up shows for a title: its name, the episode, and a picture."""
    imdb_id = vid.split(":")[0]
    meta = cinemeta(ctype, imdb_id)
    if not meta.get("name"):
        raise NotFound(f"{imdb_id} isn't a known {ctype}")
    x = title_extras(imdb_id, ctype)
    episode = None
    if ctype == "series":
        parts = vid.split(":")
        if len(parts) != 3:
            raise ValueError("A series needs its episode (tt…:season:episode)")
        e = next((v for v in meta.get("videos") or [] if v.get("id") == vid), {})
        episode = f"S{parts[1]} E{parts[2]}" + (f"  ·  {e.get('name') or e.get('title')}" if (e.get("name") or e.get("title")) else "")
    return {"type": ctype, "id": vid, "name": x.get("name") or meta["name"], "episode": episode,
            "art": x.get("backdrop") or x.get("poster")}


def _describe_link(url, name):
    p = urlparse(url or "")
    if p.scheme not in ("http", "https") or not p.hostname or len(url) > 2000:
        raise ValueError("That isn't a link (it starts with http:// or https://)")
    return {"url": url, "name": (name or "").strip()[:80] or None, "site": p.hostname}


def send(account_id, from_profile, device_id, title=None, link=None):
    """Sends a title ({"type", "id"}) or a link ({"url", "name"?}) to one TV. Returns the request's id;
    raises Off if the TV is off, NotFound for another household's (or no) TV."""
    tv = store.device(account_id, device_id)
    if not tv or tv["kind"] != "tv":
        raise NotFound("No such TV")
    if (title is None) == (link is None):
        raise ValueError("Send a title or a link")
    if title is not None:
        if title.get("type") not in ("movie", "series") or not VIDEO_ID.match(str(title.get("id", ""))):
            raise ValueError("A title is {type: movie|series, id: tt… (tt…:season:episode for an episode)}")
        what = {"title": _describe_title(title["type"], title["id"])}
    else:
        what = {"link": _describe_link(link.get("url"), link.get("name"))}
    if tv["idle_s"] is None or tv["idle_s"] > OFF_AFTER_S:
        raise Off()
    store.forget_tv_requests(KEEP_S)
    return store.add_tv_request(account_id, device_id, from_profile, what)


def status(account_id, request_id):
    """waiting, shown (on the TV, not answered yet), accepted, declined, or unreachable."""
    r = store.tv_request(account_id, request_id)
    if not r:
        raise NotFound("No such request")
    if r["status"] == "waiting" and r["age"] > PICKUP_S:
        store.set_tv_request(request_id, "unreachable", only_from="waiting")
        return "unreachable"
    # On the TV and never answered (its answer lost, the TV switched off with it up): the TV gives up
    # after its minute, so after that the phone hears no rather than waiting for good.
    if r["status"] == "shown" and r["age"] > PICKUP_S + SHOWN_S:
        store.set_tv_request(request_id, "declined", only_from="shown")
        return "declined"
    return r["status"]


def next_for(device):
    """What's waiting for this TV (now shown), with who sent it; None if nothing is."""
    r = store.take_tv_request(device["id"], PICKUP_S)
    if not r:
        return None
    sender = store.profile(r["from_profile"]) or {}
    return {"id": r["id"], **r["what"],
            "from": {"id": str(r["from_profile"]), "name": sender.get("name"), "avatar": sender.get("avatar"),
                     "isAdmin": bool(sender.get("is_admin"))}}


def answer(device, request_id, accepted):
    if not store.set_tv_request(request_id, "accepted" if accepted else "declined", device_id=device["id"],
                                only_from="shown"):
        raise NotFound("No such request")
