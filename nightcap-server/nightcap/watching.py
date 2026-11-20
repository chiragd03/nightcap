"""Watch state: progress, watched marks, and new-episode alerts."""

from . import store
from .config import S
from .cache import changed
from .context import me
from .episodes import aired_episodes, next_episode
from .http import cinemeta


def library_state(imdb_id, item=False):
    """Watch state for one title as {"video_id", "timeOffset", "duration", "audioPick", "subtitlePick"}
    (empty if not in the library)."""
    e = store.entry(me(), imdb_id) if item is False else item
    return {"video_id": e["current_video_id"], "timeOffset": e["position_ms"], "duration": e["duration_ms"],
            "audioPick": e.get("audio_pick"), "subtitlePick": e.get("subtitle_pick")} if e else {}

def mark_watched(ctype, vid, watched=True, season=None):
    """Marks an episode, a season, a whole show (vid is the show's id) or a film watched, or unwatched."""
    imdb_id = vid.split(":")[0]
    # Only real titles get a library entry (a mistyped id must never add junk).
    if not cinemeta(ctype, imdb_id).get("name"):
        raise LookupError(f"{imdb_id} isn't a known {ctype}")
    if season is not None:
        vid = imdb_id
    whole_show = ctype == "series" and vid == imdb_id
    episodes = aired_episodes(imdb_id, season) if whole_show else ()
    if watched:
        nxt = next_episode(vid) if ctype == "series" and not whole_show else None
        store.mark_watched(me(), ctype, vid, episodes, nxt and nxt["id"])
    else:
        store.mark_unwatched(me(), ctype, vid, episodes)
    changed(imdb_id)


def mark_unwatched_title(imdb_id):
    """Continue watching's "Mark as unwatched": a film resets; a show unticks the episode you're on
    (and leaves the library if nothing else is watched)."""
    e = store.entry(me(), imdb_id)
    if not e:
        return
    if e["type"] == "movie":
        store.mark_unwatched(me(), "movie", imdb_id)
    else:
        store.mark_unwatched(me(), "series", e["current_video_id"] or imdb_id)
    changed(imdb_id)


def set_notify(imdb_id, on):
    """New-episode alerts on or off, for a show already in the library (never creates one)."""
    ok = store.set_notify(me(), imdb_id, on)
    changed(imdb_id)
    return ok


def save_progress(ctype, vid, position, duration, played=None, source=None, device=None):
    """Where playback is up to. Finishing ticks the episode (or marks the film watched) and a
    show moves on to its next episode. [device]: the device it's playing on (its id)."""
    finished = duration > 0 and position >= duration * S.advanced.progress.finished_at
    nxt = next_episode(vid) if ctype == "series" and finished else None
    store.save_progress(me(), ctype, vid, position, duration, nxt and nxt["id"], played, source, device)
    changed(vid.split(":")[0])
    # (A title watched for the first time gets its name and poster on the next refresh of Home.)


def save_subtitle_pick(vid, pick):
    """The subtitles picked in the player for this title ("eng", "off"), after its progress."""
    store.save_subtitle_pick(me(), vid.split(":")[0], pick)


def save_audio_pick(vid, pick):
    """The audio language picked in the player for this title ("" clears it), after its progress."""
    store.save_audio_pick(me(), vid.split(":")[0], pick)


SOURCE_FIELDS = {"origin": "origin", "row": "row_key", "slot": "slot", "requestId": "request_id",
                 "modelVersion": "model_version", "audioLanguage": "audio_language"}
ORIGINS = ("row", "search", "continue", "up_next", "direct", "similar")


def source_of(body):
    """Where a play or action came from, as the TV reports it (unknown values dropped)."""
    out = {col: body.get(key) for key, col in SOURCE_FIELDS.items() if body.get(key) not in (None, "")}
    if out.get("origin") not in ORIGINS:
        out.pop("origin", None)
    if "slot" in out:
        out["slot"] = int(out["slot"]) if str(out["slot"]).isdigit() else None
    for k in ("row_key", "request_id", "model_version", "audio_language"):
        if k in out:
            out[k] = str(out[k])[:80]
    return out
