"""The audio language picked in the player, kept per title, without a database.

Run from nightcap-server/:  env -u DATABASE_URL TMDB_API_KEY=x .venv/bin/python -m unittest tests.test_audiopick
"""

import os
import unittest
from unittest import mock

os.environ.setdefault("TMDB_API_KEY", "test")
os.environ.setdefault("SECRETS_KEY", "test-secret")

from pydantic import ValidationError  # noqa: E402

from nightcap import api, watching  # noqa: E402

BASE = {"type": "series", "id": "tt1281973:20:66", "position": 1000, "duration": 2000}
DEVICE = {"id": "00000000-0000-0000-0000-000000000001"}


class AudioPick(unittest.TestCase):
    def save(self, **extra):
        with mock.patch.object(watching, "save_progress") as progress, \
                mock.patch.object(watching, "save_audio_pick") as pick:
            api.save_position(api.Position(**BASE, **extra), DEVICE)
        progress.assert_called_once()
        return pick

    def test_a_pick_is_kept_for_the_title(self):
        self.save(audioPick="hi").assert_called_once_with("tt1281973:20:66", "hi")

    def test_an_empty_pick_clears_it(self):
        self.save(audioPick="").assert_called_once_with("tt1281973:20:66", "")

    def test_a_failed_pick_save_keeps_the_progress(self):
        with mock.patch.object(watching, "save_progress") as progress, \
                mock.patch.object(watching, "save_audio_pick", side_effect=RuntimeError("db")):
            self.assertFalse(api.save_position(api.Position(**BASE, audioPick="hi"), DEVICE))
        progress.assert_called_once()

    def test_a_subtitle_pick_is_kept_for_the_title(self):
        with mock.patch.object(watching, "save_progress"), mock.patch.object(watching, "save_audio_pick"), \
                mock.patch.object(watching, "save_subtitle_pick") as subs:
            api.save_position(api.Position(**BASE, subtitlePick="off"), DEVICE)
        subs.assert_called_once_with("tt1281973:20:66", "off")
        api.Position(**BASE, subtitlePick="pt-br")
        api.Position(**BASE, subtitlePick="pl")
        for bad in ("", "English", "e"):
            with self.assertRaises(ValidationError):
                api.Position(**BASE, subtitlePick=bad)

    def test_no_pick_leaves_it(self):
        self.save().assert_not_called()

    def test_only_a_language_code(self):
        for bad in ("Hindi", "h", "hi;drop", "HI"):
            with self.assertRaises(ValidationError):
                api.Position(**BASE, audioPick=bad)

    def test_watch_state_says_the_pick(self):
        row = {"current_video_id": "tt1:1:1", "position_ms": 5, "duration_ms": 9, "audio_pick": "hi"}
        self.assertEqual(watching.library_state("tt1", row)["audioPick"], "hi")



class WantFirst(unittest.TestCase):
    """The TV's rule for "has the wanted language" (PlayOrder.level), on the server."""
    def test_levels(self):
        from nightcap.playback import meets_want
        self.assertEqual(meets_want({"fileAudio": ["en", "hi"], "languages": []}, "hi", "en"), 3)
        self.assertEqual(meets_want({"fileAudio": ["en"], "languages": ["hi"]}, "hi", "en"), 0)
        self.assertEqual(meets_want({"languages": ["hi"]}, "hi", "en"), 2)
        self.assertEqual(meets_want({"languages": ["ta"]}, "hi", "en"), 0)
        self.assertEqual(meets_want({"languages": []}, "hi", "hi"), 1)
        self.assertEqual(meets_want({"languages": []}, "hi", "en"), 0)
        self.assertEqual(meets_want({"languages": ["hi"]}, None, "en"), 0)


if __name__ == "__main__":
    unittest.main()
