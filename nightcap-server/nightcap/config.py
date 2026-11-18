"""Everything the server can be tuned with, read once as it starts.

The settings and their defaults are in defaults.toml (next to this file), which says what each one
does. Whoever runs a server changes them in a file of their own, named by NIGHTCAP_CONFIG, with only
the settings they change; some settings also take environment variables, and those win over the
file. An unknown name or a value of the wrong kind stops the server from starting.

Secrets (TMDB_API_KEY, DATABASE_URL, SECRETS_KEY, OWNER_KEY) are environment variables only. What
differs between households (add-ons, AI key, place, spend limit) is in the database.
"""

import logging
import os
import tomllib
from types import SimpleNamespace

log = logging.getLogger(__name__)

_HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULTS_FILE = os.path.join(_HERE, "defaults.toml")

# Tables whose names are free (a model's price, a language row): a file of one's own replaces the
# whole table, so one can be taken out as well as added.
FREE_TABLES = {"ai.prices", "home.language_rows", "home.countries"}

# The environment variables that set a setting; they win over the file.
ENVIRONMENT = {
    "SERVER_NAME": "server.name", "MODE": "server.mode", "PORT": "server.port",
    "DISCOVERY_PORT": "server.discovery_port", "ADVERTISE_PORT": "server.advertise_port",
    "PUBLIC_URL": "server.public_url", "TZ": "server.timezone", "DEFAULT_COUNTRY": "server.country",
    "TRUSTED_PROXY": "server.trusted_proxy",
    "MAX_BODY_BYTES": "server.max_body_bytes", "MAX_IMPORT_BYTES": "server.max_import_bytes",
    "AI_MODEL": "ai.model", "APP_RELEASES": "app.releases",
    "MIN_REBUILD_HOURS": "recommendations.rebuild_min_hours", "MAX_AGE_HOURS": "recommendations.rebuild_max_hours",
    "BECAUSE_ROWS": "recommendations.because_rows",
    "LOOKUP_BUDGET_S": "playback.lookup_budget_seconds", "CACHE_ENTRIES": "advanced.cache.entries",
}


class BadSetting(SystemExit):
    pass


def _same_kind(default, value):
    """Whether [value] is the kind of value [default] is (a whole number does for a decimal one)."""
    if isinstance(default, bool) or isinstance(value, bool):
        return isinstance(default, bool) and isinstance(value, bool)
    if isinstance(default, float):
        return isinstance(value, (int, float))
    if isinstance(default, list):
        return isinstance(value, list) and len(value) == len(default) and all(
            _same_kind(d, v) for d, v in zip(default, value))
    return isinstance(value, type(default))


def _merge(base, own, where, prefix=""):
    for name, value in own.items():
        dotted = f"{prefix}{name}"
        if name not in base:
            raise BadSetting(f"{where}: there's no setting called {dotted} (see {DEFAULTS_FILE})")
        default = base[name]
        if isinstance(default, dict) and dotted in FREE_TABLES:
            if not isinstance(value, dict):
                raise BadSetting(f"{where}: {dotted} is a table")
            sample = next(iter(default.values()), None)
            for k, v in value.items():
                if sample is not None and not _same_kind(sample, v):
                    raise BadSetting(f"{where}: {dotted}.{k} should be like {sample!r}")
            base[name] = dict(value)
        elif isinstance(default, dict):
            if not isinstance(value, dict):
                raise BadSetting(f"{where}: {dotted} is a table")
            _merge(default, value, where, f"{dotted}.")
        elif not _same_kind(default, value):
            raise BadSetting(f"{where}: {dotted} should be like {default!r}, not {value!r}")
        else:
            base[name] = float(value) if isinstance(default, float) else value


def _from_environment(base):
    for env, dotted in ENVIRONMENT.items():
        raw = os.environ.get(env)
        if raw is None:
            continue
        *path, name = dotted.split(".")
        table = base
        for part in path:
            table = table[part]
        default = table[name]
        raw = raw.strip()
        try:
            if isinstance(default, bool):
                value = bool(raw)            # set to anything: on
            elif isinstance(default, int):
                value = int(raw)
            elif isinstance(default, float):
                value = float(raw)
            else:
                value = raw
        except ValueError:
            raise BadSetting(f"{env}={raw!r}: should be like {default!r}")
        table[name] = value


def load(path=None):
    """The settings: the defaults, then [path]'s (NIGHTCAP_CONFIG), then the environment's."""
    with open(DEFAULTS_FILE, "rb") as f:
        values = tomllib.load(f)
    path = path if path is not None else os.environ.get("NIGHTCAP_CONFIG", "").strip()
    if path:
        try:
            with open(path, "rb") as f:
                own = tomllib.load(f)
        except (OSError, tomllib.TOMLDecodeError) as e:
            raise BadSetting(f"NIGHTCAP_CONFIG {path}: {e}")
        _merge(values, own, path)
    _from_environment(values)
    return values


def _namespace(values, prefix=""):
    return SimpleNamespace(**{k: v if (f"{prefix}{k}" in FREE_TABLES or not isinstance(v, dict))
                              else _namespace(v, f"{prefix}{k}.") for k, v in values.items()})


VALUES = load()
S = _namespace(VALUES)
A = S.advanced          # (the advanced ones, for short)


def _check():
    """Settings that don't fit together: said as the server starts (they're allowed, as they may be meant)."""
    warn = lambda text: log.warning("Settings: %s", text)
    if S.ai.model not in S.ai.prices:
        warn(f"the AI model offered first ({S.ai.model}) has no price in ai.prices: a household choosing it must give one")
    if S.playback.lookup_budget_seconds >= 60:
        warn("playback.lookup_budget_seconds is 60 or more: the TV stops waiting for sources at 60")
    if A.timeouts.plugin_seconds >= S.playback.lookup_budget_seconds:
        warn("advanced.timeouts.plugin_seconds isn't under playback.lookup_budget_seconds")
    if A.devices.watching_seconds <= 60:
        warn("advanced.devices.watching_seconds is 60 or less: the players report every 30 seconds")
    if A.devices.tv_off_after_minutes <= A.devices.last_used_save_minutes:
        warn("advanced.devices.tv_off_after_minutes isn't over last_used_save_minutes: a TV in use can look off")
    if A.devices.play_on_tv_pickup_seconds <= 10:
        warn("advanced.devices.play_on_tv_pickup_seconds is 10 or less: TVs check every 10 seconds")
    if S.recommendations.rebuild_min_hours > S.recommendations.rebuild_max_hours:
        warn("recommendations.rebuild_min_hours is over rebuild_max_hours")
    if not S.app.tag_prefix.strip():
        raise BadSetting("app.tag_prefix is empty: every release (the setup tool's too) would count as the app's")
    if not S.security.pin_min_digits <= S.security.pin_max_digits:
        raise BadSetting("security.pin_min_digits is over pin_max_digits")


_check()


# ---------- The names the rest of the server uses ----------

TMDB_API_KEY = os.environ["TMDB_API_KEY"]
PORT = S.server.port

MIN_REBUILD_HOURS = S.recommendations.rebuild_min_hours
MAX_AGE_HOURS = S.recommendations.rebuild_max_hours
BECAUSE_ROWS = S.recommendations.because_rows

# The model offered first for Anthropic (each household picks its own).
MODEL = S.ai.model
# USD per million tokens (input, output) of models from Anthropic or OpenAI (ai.prices; a model not
# listed there needs the household's own price), for the spend widget and the monthly limit.
PRICES = {model: tuple(p) for model, p in S.ai.prices.items()}

DEFAULT_TIMEZONE = S.server.timezone
DEFAULT_COUNTRY = S.server.country
CACHE_ENTRIES = A.cache.entries
LOOKUP_BUDGET_S = S.playback.lookup_budget_seconds

# Where the server runs (see defaults.toml): anything but "home" is cloud, the safe one if it's forgotten.
MODE = "home" if S.server.mode.strip().lower() == "home" else "cloud"
AT_HOME = MODE == "home"
OPEN_JOIN = AT_HOME
DISCOVERY_PORT = S.server.discovery_port if AT_HOME else 0
ADVERTISE_PORT = S.server.advertise_port or PORT
SERVER_NAME = S.server.name
# The server owner's key (whoever deployed it): creates and deletes households and picks their
# admins (see owner.py). Unset: there's no owner.
OWNER_KEY = os.environ.get("OWNER_KEY", "").strip()

# A read-only GitHub token for a private releases repository (see appupdate.py). Unset: the repository
# is read as a public one.
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "").strip()

# The web app's built files (nightcap-web's dist/), served at /app/. The image puts them here.
WEB_DIR = os.environ.get("WEB_DIR", os.path.join(os.path.dirname(_HERE), "web"))

MAX_BODY_BYTES = S.server.max_body_bytes
MAX_IMPORT_BYTES = S.server.max_import_bytes
PUBLIC_URL = S.server.public_url.rstrip("/")

# Behind a load balancer that adds the client's address to X-Forwarded-For: wrong join codes and
# owner keys are then counted by that address (see tries.py). Off, the header is ignored.
TRUSTED_PROXY = S.server.trusted_proxy

# A server with a public address is on the internet, where open joining would let anyone join any
# household: refuse to start in home mode then.
if AT_HOME and PUBLIC_URL:
    raise SystemExit("MODE=home with PUBLIC_URL set: a server on the internet must run in cloud mode (unset MODE)")


def limits():
    """What the apps are told (GET /limits.json), so what they allow is what the server allows."""
    from .languages import AUDIO_LANGUAGES   # (languages imports config)
    return {
        "maxProfiles": S.household.max_profiles, "maxDevices": S.household.max_devices,
        "maxAddons": S.household.max_addons, "maxOpenInvites": S.household.max_open_invites,
        "inviteCodeLength": S.household.invite_code_length, "inviteHours": S.household.invite_hours,
        "names": {"profile": S.names.profile, "household": S.names.household, "device": S.names.device,
                  "inviteLabel": S.names.invite_label},
        "pin": {"min": S.security.pin_min_digits, "max": S.security.pin_max_digits},
        "exportPasswordMin": S.security.export_password_min,
        "maxImportBytes": S.server.max_import_bytes,
        "monthlyLimitMaxUsd": S.ai.monthly_limit_max_usd,
        "audioLanguages": [{"code": code3, "name": name, "native": native} for _, code3, name, native in AUDIO_LANGUAGES],
    }
