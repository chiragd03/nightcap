"""Links played on a TV (not titles in the catalogue): the history the web app shows and manages,
per profile: what, when it was sent and last played, how far it got, and a picture the TV grabbed.
"""

import logging
from urllib.parse import unquote, urlparse

from . import store
from .context import me

log = logging.getLogger(__name__)


def sent_items():
    return store.sent_items(me())


def link_name(url):
    path = urlparse(url).path.rstrip("/")
    leaf = unquote(path.rsplit("/", 1)[-1]).rsplit(".", 1)[0] if path else ""
    # Stream files are often called index.m3u8 or master.m3u8; the site name says more.
    if not leaf or leaf.lower() in ("index", "master", "playlist", "video", "manifest"):
        return urlparse(url).hostname or url
    return leaf.replace("-", " ").replace("_", " ")[:80]


def send_link(url, name=""):
    """Put a link at the top of the profile's list; re-sending keeps its saved position."""
    item_id = store.send_link(me(), url, name.strip()[:80] or link_name(url))
    item = next((i for i in sent_items() if i["id"] == str(item_id)), {"id": str(item_id), "name": name or link_name(url)})
    log.info("Sent to TV: %s", item["name"])
    return item


def save_thumb(item_id, jpeg):
    """The TV uploads a frame it grabbed while playing; the web app shows it with the link."""
    store.save_thumb(me(), item_id, jpeg)


def thumb(item_id):
    """The picture for one of this profile's sent links, or None (also for anyone else's)."""
    return store.sent_thumb(me(), item_id)


def sent_progress(item_id, position, duration):
    store.sent_progress(me(), item_id, position, duration)


def sent_remove(item_id):
    if str(item_id).isdigit():
        store.sent_remove(me(), item_id)
