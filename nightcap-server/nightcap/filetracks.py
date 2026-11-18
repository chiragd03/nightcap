"""What a file says about itself, read from its own header (not its name): its audio tracks'
languages and how long it runs. A track's own name counts too ("Hindi 5.1"): many Indian releases
leave the language out (Matroska then says English) or say "und", and name the track instead. From the start of an MKV, or an MP4's moov box (at its start, or
after its media when it's there). Nothing is kept here: it's read when a viewer asks for a language
another version may have (api.py, audio-languages), and for the first sources a play would try, to
tell a file of another title by its length (playback.py)."""

import logging
import re
import struct

from .languages import AUDIO_LANGUAGES
from .playback import LANGUAGES, LANGUAGE_FOR_AUDIO

log = logging.getLogger(__name__)

# How much of a file is read at a time: an MKV's track list, and an MP4's moov, fit in it.
CHUNK = 1 << 20

# Three-letter codes (both kinds: "ger" and "deu") to two-letter ones.
_THREE = {**{three: LANGUAGE_FOR_AUDIO[name] for three, name in LANGUAGES.items() if name in LANGUAGE_FOR_AUDIO},
          **{three: two for two, three, _, _ in AUDIO_LANGUAGES}}


def code(lang):
    """A track's language ("hin", "hi", "hi-IN") as a two-letter code; "und" when it doesn't say."""
    lang = (lang or "").strip().lower().split("-")[0]
    if len(lang) == 2:
        return lang
    return _THREE.get(lang, "und" if lang in ("", "und", "mul", "zxx", "mis") else lang)


# A track's name naming one language: its English or own name, or its three-letter code as a word.
_NAMED = [(two, re.compile(rf"(?i)(?<![a-z]){re.escape(english)}(?![a-z])|{re.escape(native)}|(?<![a-z]){three}(?![a-z])"))
          for two, three, english, native in AUDIO_LANGUAGES]


def named(name):
    """The language a track's name names ("Hindi DD+ 5.1" → "hi"), or None (none, or more than one)."""
    found = {two for two, pattern in _NAMED if name and pattern.search(name)}
    return found.pop() if len(found) == 1 else None


def language(tag, name):
    """A track's language from its tag and its name: the name's when the tag says nothing, says "und"
    or says English (Matroska's default, and what a missing tag reads as); otherwise the tag's."""
    tagged = code(tag) if tag else "en"
    return (named(name) or tagged) if tagged in ("en", "und") else tagged


NOTHING = {"audio": None, "seconds": None}


def file_info(read):
    """{"audio": the audio tracks' languages (two-letter codes, "und" for one that doesn't say),
    "seconds": how long it runs}, each None when it couldn't be read. [read](offset, size) gives that
    part of the file (bytes, maybe less)."""
    head = read(0, CHUNK)
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return _mkv(head)
    if head[4:8] in (b"ftyp", b"moov", b"free", b"wide", b"skip", b"mdat"):
        return _mp4(head, read)
    return dict(NOTHING)


def audio_languages(read):
    """The audio tracks' languages, as file_info's, or None."""
    return file_info(read)["audio"]


# ---------- MKV (EBML) ----------

SEGMENT, INFO, TRACKS, TRACK, CLUSTER = 0x18538067, 0x1549A966, 0x1654AE6B, 0xAE, 0x1F43B675
TIMESTAMP_SCALE, DURATION = 0x2AD7B1, 0x4489
TRACK_TYPE, LANGUAGE, LANGUAGE_BCP47, NAME = 0x83, 0x22B59C, 0x22B59D, 0x536E
AUDIO = 2


def _vint(b, i, keep_marker):
    """An EBML number at [i]: (value, next index); value -1 for an unknown size."""
    first = b[i]
    n = next((k for k in range(8) if first & (0x80 >> k)), None)
    if n is None or i + n >= len(b):
        raise IndexError
    value = first if keep_marker else first & (0xFF >> (n + 1))
    for k in range(1, n + 1):
        value = (value << 8) | b[i + k]
    if not keep_marker and value == (1 << (7 * (n + 1))) - 1:
        value = -1
    return value, i + n + 1


def _elements(b, start, end):
    """(id, data start, data end) of each element in b[start:end]; an unknown size runs to [end]."""
    i = start
    while i < end:
        eid, i = _vint(b, i, True)
        size, i = _vint(b, i, False)
        stop = end if size < 0 else i + size
        yield eid, i, stop
        if size < 0:
            return
        i = stop


def _mkv(b):
    found = dict(NOTHING)
    try:
        for eid, s, e in _elements(b, 0, len(b)):
            if eid != SEGMENT:
                continue
            for cid, cs, ce in _elements(b, s, min(e, len(b))):
                if cid == CLUSTER or ce > len(b):
                    break
                if cid == INFO:
                    found["seconds"] = _mkv_seconds(b, cs, ce)
                elif cid == TRACKS:
                    found["audio"] = _mkv_tracks(b, cs, ce)
                if found["audio"] is not None and found["seconds"] is not None:
                    break
            break
    except IndexError:
        pass
    return found


def _mkv_seconds(b, s, e):
    scale, duration = 1_000_000, None  # (nanoseconds per tick; Matroska's default)
    for fid, fs, fe in _elements(b, s, e):
        if fid == TIMESTAMP_SCALE:
            scale = int.from_bytes(b[fs:fe], "big") or scale
        elif fid == DURATION and fe - fs in (4, 8):
            duration = struct.unpack(">f" if fe - fs == 4 else ">d", b[fs:fe])[0]
    return round(duration * scale / 1e9, 1) if duration and duration > 0 else None


def _mkv_tracks(b, s, e):
    langs = []
    for tid, ts, te in _elements(b, s, e):
        if tid != TRACK:
            continue
        kind, lang, bcp, name = None, None, None, None  # (No language: Matroska's default, English.)
        for fid, fs, fe in _elements(b, ts, te):
            if fid == TRACK_TYPE:
                kind = int.from_bytes(b[fs:fe], "big")
            elif fid == LANGUAGE:
                lang = b[fs:fe].rstrip(b"\0").decode("ascii", "replace")
            elif fid == LANGUAGE_BCP47:
                bcp = b[fs:fe].rstrip(b"\0").decode("ascii", "replace")
            elif fid == NAME:
                name = b[fs:fe].rstrip(b"\0").decode("utf-8", "replace")
        if kind == AUDIO:
            langs.append(language(bcp or lang, name))
    return langs


# ---------- MP4 ----------

def _boxes(b, start, end):
    """(type, data start, box end) of each box in b[start:end]; the last may run past [end]."""
    i = start
    while i + 8 <= end:
        size, kind = struct.unpack(">I4s", b[i:i + 8])
        head = 8
        if size == 1:
            if i + 16 > end:
                return
            size, head = struct.unpack(">Q", b[i + 8:i + 16])[0], 16
        elif size == 0:
            size = end - i
        if size < head:
            return
        yield kind, i + head, i + size
        i += size


def _mp4(head, read):
    offset, b = 0, head
    for _ in range(4):  # (ftyp, mdat, then moov: a jump or two at most)
        for kind, s, e in _boxes(b, 0, len(b)):
            if kind == b"moov":
                if e > len(b):
                    # Bigger than what was read: read it whole (moovs are a few MB at most).
                    if e - s > 16 * CHUNK:
                        return dict(NOTHING)
                    b = read(offset, e)
                    if len(b) < e:
                        return dict(NOTHING)
                return {"audio": _mp4_tracks(b, s, e), "seconds": _mp4_seconds(b, s, e)}
            if e > len(b):
                # The rest of the file starts past what was read: read on from there.
                offset, b = offset + e, read(offset + e, CHUNK)
                break
        else:
            return dict(NOTHING)
        if len(b) < 8:
            return dict(NOTHING)
    return dict(NOTHING)


def _mp4_seconds(b, s, e):
    for kind, ms, me in _boxes(b, s, e):
        if kind != b"mvhd" or me - ms < 20:
            continue
        # (After version and flags, the times are 4 or 8 bytes each by version, then timescale and duration.)
        if b[ms] == 1 and me - ms >= 32:
            scale, duration = struct.unpack(">IQ", b[ms + 20:ms + 32])
        else:
            scale, duration = struct.unpack(">II", b[ms + 12:ms + 20])
        return round(duration / scale, 1) if scale and duration and duration != 0xFFFFFFFF else None
    return None


def _mp4_tracks(b, s, e):
    langs = []
    for kind, ts, te in _boxes(b, s, e):
        if kind != b"trak":
            continue
        for mk, ms, me in _boxes(b, ts, te):
            if mk != b"mdia":
                continue
            handler, lang, extended, name = None, None, None, None
            for k, cs, ce in _boxes(b, ms, me):
                if k == b"hdlr" and ce - cs >= 12:
                    handler = b[cs + 8:cs + 12]
                    # (After the handler and 12 reserved bytes, its name: "Hindi" in some releases.)
                    name = b[cs + 24:ce].rstrip(b"\0").decode("utf-8", "replace") if ce - cs > 24 else None
                elif k == b"mdhd" and ce > cs:
                    # (After version and flags, then the times, timescale and duration: 4 or 8 bytes each by version.)
                    at = cs + (20 if b[cs] == 0 else 32) if b[cs] in (0, 1) else None
                    if at is not None and at + 2 <= ce:
                        packed = struct.unpack(">H", b[at:at + 2])[0]
                        lang = "".join(chr(((packed >> sh) & 0x1F) + 0x60) for sh in (10, 5, 0))
                elif k == b"elng" and ce - cs > 4:
                    extended = b[cs + 4:ce].rstrip(b"\0").decode("ascii", "replace")
            if handler == b"soun":
                tag = code(extended or lang)
                langs.append(language(tag, name) if tag in ("en", "und") else tag)
    return langs
