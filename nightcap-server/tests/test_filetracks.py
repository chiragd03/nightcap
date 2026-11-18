"""A file's audio languages from its own track list (filetracks.py), on small hand-made files.

Run from nightcap-server/:  env -u DATABASE_URL TMDB_API_KEY=x .venv/bin/python -m unittest tests.test_filetracks
"""

import os
import struct
import unittest

os.environ.setdefault("TMDB_API_KEY", "test")

from nightcap import filetracks  # noqa: E402


# ---------- MKV ----------

def _size(n):
    return bytes([0x01]) + n.to_bytes(7, "big")  # an 8-byte EBML size


def _el(eid, data):
    return eid.to_bytes((eid.bit_length() + 7) // 8, "big") + _size(len(data)) + data


def _track(kind, lang=None, bcp=None, name=None):
    data = _el(0x83, bytes([kind]))
    if name:
        data += _el(0x536E, name.encode())
    if lang:
        data += _el(0x22B59C, lang.encode())
    if bcp:
        data += _el(0x22B59D, bcp.encode())
    return _el(0xAE, data)


def _mkv(*tracks, unknown_segment=False, cluster_first=False, seconds=None, scale=None):
    header = _el(0x1A45DFA3, _el(0x4282, b"matroska"))
    info = _el(0x7BA9, b"a film")
    if scale:
        info += _el(0x2AD7B1, scale.to_bytes(4, "big"))
    if seconds:
        info += _el(0x4489, struct.pack(">d", seconds * 1e9 / (scale or 1_000_000)))
    body = _el(0x1549A966, info)
    if cluster_first:
        body += _el(0x1F43B675, b"\0" * 10)
    body += _el(0x1654AE6B, b"".join(tracks)) + _el(0x1F43B675, b"\0" * 100)
    segment = (0x18538067).to_bytes(4, "big") + (b"\x01\xff\xff\xff\xff\xff\xff\xff" if unknown_segment else _size(len(body))) + body
    return header + segment


def reader(data):
    return lambda offset, size: data[offset:offset + size]


def test_mkv_audio_tracks():
    f = _mkv(_track(1, "und"), _track(2, "eng"), _track(2, "hin"), _track(17, "eng"))
    assert filetracks.audio_languages(reader(f)) == ["en", "hi"]


def test_mkv_default_language_is_english_and_bcp47_wins():
    f = _mkv(_track(2), _track(2, "und", "ta-IN"))
    assert filetracks.audio_languages(reader(f)) == ["en", "ta"]


def test_mkv_unknown_sized_segment():
    f = _mkv(_track(2, "ger"), unknown_segment=True)
    assert filetracks.audio_languages(reader(f)) == ["de"]


def test_mkv_tracks_after_the_media_or_cut_off():
    assert filetracks.audio_languages(reader(_mkv(_track(2, "hin"), cluster_first=True))) is None
    f = _mkv(_track(2, "eng"), _track(2, "hin"))
    cut = f[:f.index(b"hin") - 2]
    assert filetracks.audio_languages(reader(cut)) is None


# ---------- MP4 ----------

def _box(kind, data):
    return struct.pack(">I4s", 8 + len(data), kind) + data


def _trak(handler, lang, version=0, extended=None):
    packed = sum((ord(c) - 0x60) << sh for c, sh in zip(lang, (10, 5, 0)))
    times = b"\0" * (16 if version == 0 else 28)  # creation, modification, timescale, duration
    mdhd = _box(b"mdhd", bytes([version, 0, 0, 0]) + times + struct.pack(">H", packed) + b"\0\0")
    hdlr = _box(b"hdlr", b"\0" * 8 + handler + b"\0" * 12)
    elng = _box(b"elng", b"\0" * 4 + extended.encode() + b"\0") if extended else b""
    return _box(b"trak", _box(b"tkhd", b"\0" * 20) + _box(b"mdia", mdhd + hdlr + elng))


def _moov(*traks, seconds=None, version=0):
    if version == 0:
        mvhd = bytes(4) + bytes(8) + struct.pack(">II", 600, int((seconds or 0) * 600)) + bytes(80)
    else:
        mvhd = bytes([1, 0, 0, 0]) + bytes(16) + struct.pack(">IQ", 1000, int((seconds or 0) * 1000)) + bytes(80)
    return _box(b"moov", _box(b"mvhd", mvhd) + b"".join(traks))


def test_mp4_moov_first():
    f = _box(b"ftyp", b"isom") + _moov(_trak(b"vide", "und"), _trak(b"soun", "eng"), _trak(b"soun", "hin", 1)) + _box(b"mdat", b"\0" * 50)
    assert filetracks.audio_languages(reader(f)) == ["en", "hi"]


def test_mp4_moov_after_the_media():
    mdat = _box(b"mdat", b"\0" * (filetracks.CHUNK * 2))
    f = _box(b"ftyp", b"isom") + mdat + _moov(_trak(b"soun", "jpn"), _trak(b"soun", "und", extended="ko-KR"))
    asked = []

    def read(offset, size):
        asked.append(offset)
        return f[offset:offset + size]
    assert filetracks.audio_languages(read) == ["ja", "ko"]
    assert len(asked) == 2  # the start, then the moov past the media


def test_mkv_seconds():
    info = filetracks.file_info(reader(_mkv(_track(2, "hin"), seconds=11_700)))
    assert info == {"audio": ["hi"], "seconds": 11_700.0}
    assert filetracks.file_info(reader(_mkv(_track(2, "eng"), seconds=2_700, scale=100_000)))["seconds"] == 2_700.0
    assert filetracks.file_info(reader(_mkv(_track(2, "eng"))))["seconds"] is None


def test_mp4_seconds():
    f = _box(b"ftyp", b"isom") + _moov(_trak(b"soun", "eng"), seconds=8_100) + _box(b"mdat", b"\0" * 10)
    assert filetracks.file_info(reader(f)) == {"audio": ["en"], "seconds": 8_100.0}
    f = _box(b"ftyp", b"isom") + _moov(_trak(b"soun", "eng"), seconds=8_100, version=1)
    assert filetracks.file_info(reader(f))["seconds"] == 8_100.0


def test_not_a_file_it_knows():
    assert filetracks.audio_languages(reader(b"#EXTM3U\n#EXT-X-VERSION:3\n")) is None
    assert filetracks.audio_languages(reader(b"")) is None
    assert filetracks.file_info(reader(b"")) == {"audio": None, "seconds": None}


def test_mkv_track_names_say_the_language_a_tag_leaves_out():
    # No tag (reads as English), "und", or English by mistake: the name's. Another language tagged: the tag's.
    f = _mkv(_track(2, name="Hindi DD+ 5.1"), _track(2, "und", name="Tamil (Original)"), _track(2, "eng", name="HIN 2.0"),
             _track(2, "tel", name="Hindi"), _track(2, name="Stereo"), _track(2, "und", name="Hindi-English"))
    assert filetracks.audio_languages(reader(f)) == ["hi", "ta", "hi", "te", "en", "und"]


def test_named():
    assert [filetracks.named(x) for x in ("Hindi 5.1", "हिन्दी", "Original", "Hindi + Tamil", "", None, "Stereo")] == \
        ["hi", "hi", None, None, None, None, None]


def test_codes():
    assert [filetracks.code(x) for x in ("hin", "hi", "hi-IN", "fre", "fra", "deu", "und", "", "xyz")] == \
        ["hi", "hi", "hi", "fr", "fr", "de", "und", "und", "xyz"]


class FileTracks(unittest.TestCase):
    pass


for _name, _f in list(globals().items()):
    if _name.startswith("test_") and callable(_f):
        setattr(FileTracks, _name, lambda self, f=_f: f())
