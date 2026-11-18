"""Live TV's list reading (livetv.py), without a database or the network.

Run from nightcap-server/:  env -u DATABASE_URL TMDB_API_KEY=x .venv/bin/python -m unittest tests.test_livetv
The lists here are made up: their addresses are example.invalid, nothing real.
"""

import os
import unittest
from unittest import mock

os.environ.setdefault("TMDB_API_KEY", "test")

from nightcap import livetv  # noqa: E402
from nightcap.livetv import NotAList, clean_name, kind_of, merge, monogram, parse  # noqa: E402

LIST = """﻿#EXTM3U x-tvg-url="https://example.invalid/guide.xml"
#EXTINF:-1 tvg-id="DWNews.de" tvg-logo="https://example.invalid/dw.png" tvg-language="English" group-title="News",DW News (1080p)
https://example.invalid/dw/1080.m3u8
#EXTINF:-1 tvg-id="DWNews.de" group-title="News",DW News (720p) [Geo-blocked]
https://example.invalid/dw/720.m3u8
#EXTINF:-1 tvg-id="DWNews.de@SD" tvg-language="German" group-title="Undefined",DW News HD
#EXTVLCOPT:http-user-agent=Something
https://example.invalid/dw/hd.m3u8
#EXTINF:-1 tvg-country="IN" tvg-language="Hindi;English" group-title="General;News",DD National
https://example.invalid/dd.m3u8
#EXTINF:-1 tvg-country="PK" tvg-language="Urdu" group-title='News',PTV News
https://example.invalid/ptv.m3u8
#EXTINF:-1 tvg-country="UK" group-title="Kids",Channel, With A Comma
https://example.invalid/comma.m3u8
#EXTINF:-1 tvg-country="INT" group-title="Music",Music 24
https://example.invalid/music.m3u8

#EXTINF:-1,No Address Follows
#EXTINF:-1 group-title="Movies",Films Plus
ftp://example.invalid/not-http
#EXTINF:-1,Plain One
#EXTGRP:Sport
https://example.invalid/plain.m3u8
"""


class Reading(unittest.TestCase):
    def setUp(self):
        self.lines = parse(LIST)

    def test_lines(self):
        names = [x["name"] for x in self.lines]
        # The line without an address and the one with an ftp address are left out.
        self.assertEqual(names, ["DW News (1080p)", "DW News (720p) [Geo-blocked]", "DW News HD", "DD National", "PTV News",
                                 "Channel, With A Comma", "Music 24", "Plain One"])

    def test_attributes(self):
        dw, dd, ptv, comma = self.lines[0], self.lines[3], self.lines[4], self.lines[5]
        self.assertEqual(dw["countries"], ["DE"])          # from its tvg-id
        self.assertEqual(dw["languages"], ["en"])
        self.assertEqual(dw["height"], 1080)
        self.assertEqual(dw["logo"], "https://example.invalid/dw.png")
        self.assertTrue(self.lines[1]["limited"])
        self.assertEqual(dd["languages"], ["hi", "en"])
        self.assertEqual(ptv["group"], "News")              # single quotes
        self.assertEqual(comma["countries"], ["GB"])        # UK is GB
        self.assertEqual(self.lines[6]["countries"], ["INT"])
        self.assertEqual(self.lines[7]["group"], "Sport")   # from #EXTGRP

    def test_not_a_list(self):
        with self.assertRaises(NotAList):
            parse("<html>Not found</html>")
        with self.assertRaises(NotAList):
            parse("#EXTM3U\n#EXTINF:-1,Nothing\n")

    def test_most(self):
        old = livetv.L
        try:
            livetv.L = type("L", (), {"max_channels": 2})()
            self.assertEqual(len(parse(LIST)), 2)
        finally:
            livetv.L = old


class Merging(unittest.TestCase):
    def setUp(self):
        self.channels = merge(parse(LIST))
        self.by_name = {c["name"]: c for c in self.channels}

    def test_one_channel_each(self):
        self.assertEqual(sorted(self.by_name), ["Channel, With A Comma", "DD National", "DW News", "Music 24", "PTV News",
                                                "Plain One"])

    def test_streams_best_first(self):
        dw = self.by_name["DW News"]
        # Sharpest first; the geo-blocked one last; the unsaid one counts as 720p.
        self.assertEqual(dw["streams"], ["https://example.invalid/dw/1080.m3u8", "https://example.invalid/dw/hd.m3u8",
                                         "https://example.invalid/dw/720.m3u8"])
        self.assertEqual(dw["languages"], ["en", "de"])
        self.assertEqual(dw["kind"], "news")
        self.assertEqual(dw["mono"], "DW")

    def test_kinds(self):
        self.assertEqual(self.by_name["DD National"]["kind"], "news")   # General says less than News
        self.assertEqual(self.by_name["Plain One"]["kind"], "sports")
        self.assertEqual(self.by_name["Channel, With A Comma"]["kind"], "kids")

    def test_ids_stay(self):
        again = {c["name"]: c["id"] for c in merge(parse(LIST))}
        self.assertEqual(again, {n: c["id"] for n, c in self.by_name.items()})

    def test_no_address_in_cards(self):
        card = livetv._card(self.by_name["DW News"], set())
        self.assertNotIn("example.invalid/dw/", str(card))


class Names(unittest.TestCase):
    def test_clean(self):
        self.assertEqual(clean_name("Al Jazeera English (1080p) [Not 24/7]"), "Al Jazeera English")
        self.assertEqual(clean_name("Star Sports 1 HD"), "Star Sports 1")

    def test_monogram(self):
        self.assertEqual(monogram("Al Jazeera English"), "AJE")
        self.assertEqual(monogram("France 24"), "F24")
        self.assertEqual(monogram("NHK World"), "NHK")
        self.assertEqual(monogram("Euronews"), "EUR")

    def test_kind_of(self):
        self.assertEqual(kind_of("Undefined"), "other")
        self.assertEqual(kind_of(None), "other")
        self.assertEqual(kind_of("Films"), "movies")
        self.assertEqual(kind_of("Bollywood Hits"), "bollywood hits")


class Places(unittest.TestCase):
    def test_from(self):
        ch = lambda countries, languages: {"countries": countries, "languages": languages}
        # Countries: one of them (no country counts as international).
        self.assertTrue(livetv._from(ch(["IN"], ["hi"]), ["IN", "PK"], []))
        self.assertFalse(livetv._from(ch(["DE"], ["en"]), ["IN", "INT"], []))
        self.assertTrue(livetv._from(ch([], []), ["IN", "INT"], []))
        # Languages: one of them (or, with "Not said" picked, none said).
        self.assertTrue(livetv._from(ch(["IN"], ["hi", "en"]), ["IN"], ["en"]))
        self.assertFalse(livetv._from(ch(["IN"], ["ta"]), ["IN"], ["hi"]))
        self.assertFalse(livetv._from(ch(["IN"], []), ["IN"], ["hi"]))
        self.assertTrue(livetv._from(ch(["IN"], []), ["IN"], ["hi", "none"]))   # "Not said" picked
        self.assertFalse(livetv._from(ch(["IN"], ["ta"]), ["IN"], ["none"]))
        # Nothing picked: everything.
        self.assertTrue(livetv._from(ch(["DE"], ["de"]), [], []))

    def test_languages_said(self):
        said = {"languages": ["hi"]}
        unsaid = {"languages": []}
        self.assertFalse(livetv.languages_said([]))
        self.assertFalse(livetv.languages_said([said, unsaid]))            # 50%: under 60%
        self.assertTrue(livetv.languages_said([said, said, said, unsaid, unsaid]))   # 60%

    def test_not_said_option(self):
        every = merge(parse(LIST))
        options = livetv._options(every, every)["languages"]
        self.assertEqual(options[-1], {"id": "none", "name": "Not said", "count": 3})

    def test_kinds_counted_after_filters(self):
        every = merge(parse(LIST))
        near = [c for c in livetv._in_countries(every, ["PK"]) if livetv._from(c, [], [])]
        options = livetv._options(every, near)
        self.assertEqual([(k["id"], k["count"]) for k in options["kinds"]], [(near[0]["kind"], 1)])
        self.assertGreater(len(options["countries"]), 1)        # countries still count every channel


OWN = """#EXTM3U
#EXTINF:-1 x-id="m1" x-row="Cricket" x-start="2026-11-05T13:30+05:30" x-end="2026-11-05T22:00+05:30" x-about="2nd ODI",India vs Australia HD
https://example.invalid/c/1.m3u8
#EXTINF:-1 x-id="m2" x-row="Cricket" x-start="2026-11-06T13:30+05:30" x-end="2026-11-06T22:00+05:30",India vs Australia HD
https://example.invalid/c/2.m3u8
#EXTINF:-1 x-id="door" x-row="Home cameras",Front door
https://example.invalid/c/3.m3u8
#EXTINF:-1 x-id="late" x-row="Cricket" x-status="live" x-start="2026-11-01T10:00+05:30" x-end="2026-11-01T12:00+05:30",Running late
https://example.invalid/c/4.m3u8
#EXTINF:-1 x-row="Family",Old one
https://example.invalid/c/5.m3u8
#EXTINF:-1 x-row="Family" x-start="2026-11-05T09:00",No offset
https://example.invalid/c/6.m3u8
"""


class OwnLists(unittest.TestCase):
    def setUp(self):
        self.lines = parse(OWN, "America/Toronto")
        self.by_name = {c["name"]: c for c in merge(self.lines)}
        self.m1 = next(c for c in merge(self.lines) if c["streams"][0].endswith("/1.m3u8"))

    def test_fields(self):
        x = self.lines[0]["x"]
        self.assertEqual(x["row"], "Cricket")
        self.assertEqual(x["start"], 1793865600)                  # 2026-11-05 08:00 UTC
        # Without an offset: the household's timezone (Toronto, 5 hours behind UTC in November).
        self.assertEqual(self.lines[5]["x"]["start"], 1793887200)

    def test_own_id_keeps_items_apart(self):
        # Two matches of the same name are two (their own ids); the name is kept as written.
        same = [c for c in merge(self.lines) if c["name"] == "India vs Australia HD"]
        self.assertEqual(len(same), 2)
        self.assertEqual(self.m1["about"], "2nd ODI")
        self.assertEqual(self.m1["streams"], ["https://example.invalid/c/1.m3u8"])
        again = [c["id"] for c in merge(parse(OWN.replace("India vs Australia HD", "IND v AUS")))]
        self.assertIn(self.m1["id"], again)                       # renamed: the same id

    def test_states(self):
        before, during, after = 1793865600 - 60, 1793865600 + 60, 1793896200 + 60
        self.assertEqual(livetv.state(self.m1, before), "upcoming")
        self.assertEqual(livetv.state(self.m1, during), "live")
        self.assertEqual(livetv.state(self.m1, after), "ended")
        self.assertEqual(livetv.state(self.by_name["Front door"], during), "24/7")
        self.assertEqual(livetv.state(self.by_name["Running late"], after), "live")   # what it says wins
        self.assertIsNone(livetv.state({"name": "DW News"}, during))                  # an ordinary channel

    def test_row_order(self):
        chs = [c for c in merge(self.lines) if c.get("row") == "Cricket"]
        during = 1793865600 + 60
        # Live ones first (the one running late, then the one just started), then upcoming soonest first.
        self.assertEqual([c["name"] for c in livetv._in_row(chs, during)],
                         ["India vs Australia HD", "Running late", "India vs Australia HD"])
        self.assertEqual(livetv._in_row(chs, during)[0]["id"], self.m1["id"])

    def test_read_with_and_without_the_extension(self):
        # (A made-up extension: items naming "known" in x-how are opened as it says; others naming one aren't kept.)
        class Extension:
            FIELD = "x-how"
            read = staticmethod(lambda text: {"known": {"a": 1}})
            for_play = staticmethod(lambda how: {"extra": how})
        text = OWN.replace('x-id="door"', 'x-how="known" x-id="door"').replace('x-row="Family" x-start', 'x-how="other" x-row="Family" x-start')
        old = livetv.get_text
        try:
            livetv.get_text = lambda *a, **k: text
            with mock.patch.object(livetv, "extension", Extension):
                lines, how, found = livetv._read("https://example.invalid/list.m3u")
                self.assertIn({"name": "x-row", "count": 6}, found)
                self.assertEqual(how, {"known": {"a": 1}})
                self.assertNotIn("No offset", [x["name"] for x in lines])      # names one it hasn't
                door = next(c for c in merge(lines) if c["name"] == "Front door")
                self.assertEqual(door["streams"], [{"u": "https://example.invalid/c/3.m3u8", "r": "known"}])
            with mock.patch.object(livetv, "extension", None):
                names = [x["name"] for x in livetv._read("https://example.invalid/list.m3u")[0]]
            self.assertIn("Front door", names)          # (without it, the attribute is just an attribute)
        finally:
            livetv.get_text = old

    def test_card(self):
        card = livetv._card(self.m1, set(), 1793865600 + 60)
        self.assertEqual((card["state"], card["startsAt"], card["about"]), ("live", 1793865600000, "2nd ODI"))
        self.assertNotIn("example.invalid/c/", str(card))
        self.assertNotIn("state", livetv._card(merge(parse(LIST))[0], set()))


MAPPED = """#EXTM3U
#EXTINF:-1 match="ind-aus" ch="Willow" when="1793865600000" till="1793896200" sec="Cricket" tvg-logo="https://example.invalid/p.png",India vs Australia
https://example.invalid/w.m3u8
#EXTINF:-1 match="ind-aus" ch="Sky" when="2026-11-05T13:30+05:30" sec="Cricket",India vs Australia
https://example.invalid/s.m3u8
"""


class Mapping(unittest.TestCase):
    def test_roles_for(self):
        m = livetv.roles_for({"row": "SEC", "start": "", "nope": "x"})
        self.assertEqual(m["row"], "sec")            # lower case, like the attributes
        self.assertEqual(m["start"], "x-start")      # empty: the default
        self.assertNotIn("nope", m)

    def test_mapped_fields(self):
        fields = {"row": "sec", "start": "when", "end": "till", "group": "match", "channel": "ch"}
        lines = parse(MAPPED, "UTC", fields)
        x = lines[0]["x"]
        self.assertEqual((x["row"], x["group"], x["channel"]), ("Cricket", "ind-aus", "Willow"))
        self.assertEqual(x["start"], 1793865600)     # epoch ms
        self.assertEqual(x["end"], 1793896200)       # epoch s
        self.assertEqual(lines[1]["x"]["start"], 1793865600)   # ISO
        # Unmapped, the same list has none of its own fields.
        self.assertEqual(parse(MAPPED)[0]["x"], {})

    def test_country_and_language(self):
        text = """#EXTM3U
#EXTINF:-1 nation="PK" lang="Urdu" tvg-country="IN",Mapped Channel
https://example.invalid/m.m3u8
"""
        line = parse(text, "UTC", {"country": "nation", "language": "lang"})[0]
        self.assertEqual((line["countries"], line["languages"]), (["PK"], ["ur"]))
        self.assertEqual(line["x"], {})                  # not its own fields
        line = parse(text)[0]                            # unmapped: tvg-country, tvg-language
        self.assertEqual((line["countries"], line["languages"]), (["IN"], []))

    def test_kind(self):
        text = """#EXTM3U
#EXTINF:-1 group-title="India" genre="News",One
https://example.invalid/1.m3u8
#EXTINF:-1 group-title="Türkiye;USA",Two
https://example.invalid/2.m3u8
#EXTINF:-1,Three
#EXTGRP:Music
https://example.invalid/3.m3u8
"""
        one, two, three = parse(text)                        # defaults: group-title is the category
        self.assertEqual((one["group"], one["countries"], three["group"]), ("India", [], "Music"))
        one, two, three = parse(text, "UTC", {"kind": "genre"})
        self.assertEqual((one["group"], two["group"], three["group"]), ("News", None, None))   # #EXTGRP is group-title's
        self.assertEqual(one["x"], {})
        # One tag, another role: group-title is each channel's country (by name), and there's no category.
        one, two, three = parse(text, "UTC", {"country": "group-title", "kind": livetv.NO_FIELD})
        self.assertEqual((one["countries"], two["countries"]), (["IN"], ["TR", "US"]))
        self.assertEqual((one["group"], three["group"]), (None, None))

    def test_by_country_list(self):
        # A list by country has a channel once per country it's in: still one channel, in both.
        text = """#EXTM3U
#EXTINF:-1 tvg-id="Euro.fr" group-title="France",Euro One
https://example.invalid/e.m3u8
#EXTINF:-1 tvg-id="Euro.fr" group-title="Belgium",Euro One
https://example.invalid/e.m3u8
"""
        chs = merge(parse(text, "UTC", {"country": "group-title", "kind": livetv.NO_FIELD}))
        self.assertEqual([c["countries"] for c in chs], [["FR", "BE"]])
        self.assertEqual(chs[0]["id"], merge(parse(text))[0]["id"])     # the same id as unmapped

    def test_country_names(self):
        from nightcap.livetv_places import country_code
        self.assertEqual([country_code(x) for x in ("in", "UK", "India", "united states", "Côte d'Ivoire",
                                                    "Ivory Coast", "Turkiye", "Nowhere")],
                         ["IN", "GB", "IN", "US", "CI", "CI", "TR", None])

    def test_field_names(self):
        found = {f["name"]: f["count"] for f in livetv.field_names(MAPPED)}
        self.assertEqual((found["match"], found["ch"], found["till"]), (2, 2, 1))
        self.assertNotIn("india vs australia", found)
        self.assertNotIn("example.invalid", str(livetv.field_names(MAPPED)))   # names only, no values


EVENTS = """#EXTM3U
#EXTINF:-1 x-id="a1" x-event-id="final" x-channel="Main" x-row="Sports",Cup Final
https://example.invalid/a1.m3u8
#EXTINF:-1 x-id="b1" x-row="Sports",Highlights
https://example.invalid/b1.m3u8
#EXTINF:-1 x-id="a2" x-event-id="final" x-channel="Alternate" x-row="Sports",Cup Final
https://example.invalid/a2.m3u8
#EXTINF:-1 x-id="c1" x-event-id="solo" x-row="Sports",Solo Match
https://example.invalid/c1.m3u8
"""


class Grouping(unittest.TestCase):
    def test_one_card_per_event(self):
        chs = merge(parse(EVENTS))
        cards = livetv._grouped(chs, set(), 0)
        self.assertEqual([c["name"] for c in cards], ["Cup Final", "Highlights", "Solo Match"])
        final = cards[0]
        self.assertEqual([m["name"] for m in final["channels"]], ["Main", "Alternate"])
        self.assertEqual(final["id"], final["channels"][0]["id"])         # the card plays its first channel
        self.assertEqual(len({m["id"] for m in final["channels"]}), 2)    # each channel its own item
        self.assertNotIn("channels", cards[2])                            # one item: a plain card
        self.assertNotIn("example.invalid", str(cards))


if __name__ == "__main__":
    unittest.main()
