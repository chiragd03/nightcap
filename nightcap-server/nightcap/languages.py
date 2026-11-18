"""Language rows (Anime counts as one), countries, and a profile's Home settings."""

from . import accounts, store
from .config import S
from .context import me

# What Home shows. Defaults from the settings ([home]); each profile's settings override any of them.
# (How many rows Home has is the server's setting: [home] rows.)
HOME_DEFAULTS = {
    "languages": [],                     # Latest rows in each, themed rows of each, picks from each
    "top10_countries": None,             # the first is on Home, the others are Browse tiles (the account's country)
    "featured": S.home.featured,
}
LANGUAGE_ROWS = dict(S.home.language_rows)

# The audio (and subtitle) languages a profile can pick, one list for the server and the apps (sent in
# GET /limits.json): (two-letter code, three-letter code, English name, its own name). Profiles keep
# the English name.
AUDIO_LANGUAGES = [
    ("en", "eng", "English", "English"), ("hi", "hin", "Hindi", "हिन्दी"), ("es", "spa", "Spanish", "Español"),
    ("fr", "fre", "French", "Français"), ("de", "ger", "German", "Deutsch"), ("it", "ita", "Italian", "Italiano"),
    ("pt", "por", "Portuguese", "Português"), ("ja", "jpn", "Japanese", "日本語"), ("ko", "kor", "Korean", "한국어"),
    ("zh", "chi", "Chinese", "中文"), ("ar", "ara", "Arabic", "العربية"), ("ru", "rus", "Russian", "Русский"),
    ("nl", "dut", "Dutch", "Nederlands"), ("ta", "tam", "Tamil", "தமிழ்"), ("te", "tel", "Telugu", "తెలుగు"),
    ("pa", "pan", "Punjabi", "ਪੰਜਾਬੀ"), ("ur", "urd", "Urdu", "اردو"),
]
# "Anime" isn't a language: Japanese animation, plus anything TMDB tags anime (some isn't Japanese).
ANIME = "anime"
ANIME_KEYWORD = "210024"


def tmdb_languages(codes):
    """Language-row codes as TMDB original languages, for rows that mix languages (Anime counts as Japanese)."""
    return list(dict.fromkeys("ja" if c == ANIME else c for c in codes))


COUNTRY_NAMES = dict(S.home.countries)
ANIMATION = 16


def home_settings():
    """The profile's Home settings, over its account's defaults for them, over the server's."""
    settings = store.profile_settings(me())
    household = accounts.settings().get("home_defaults") or {}
    out = {**HOME_DEFAULTS, **{k: v for k, v in {**household, **settings}.items() if k in HOME_DEFAULTS}}
    if not out["top10_countries"]:
        out["top10_countries"] = [accounts.country()]
    return out


NOT_STORIES = "99|10402|10763|10764|10767"   # documentaries, concerts, news, reality, talk


def language_filter(code, kind):
    """TMDB discover filters for one language row: Anime is animation in Japanese (the anime tag
    is added separately); Japanese is everything else in Japanese."""
    if code == ANIME:
        return {"with_original_language": "ja", "with_genres": ANIMATION}
    if code == "ja":
        return {"with_original_language": "ja", "without_genres": f"{NOT_STORIES}|{ANIMATION}"}
    return {"with_original_language": code}


def in_language_row(title, code):
    """Whether a title (with its original language and TMDB genres) belongs on a language page."""
    animated = ANIMATION in (title["genres"] or [])
    if code == ANIME:
        return title["language"] == "ja" and animated
    if code == "ja":
        return title["language"] == "ja" and not animated
    return title["language"] == code
