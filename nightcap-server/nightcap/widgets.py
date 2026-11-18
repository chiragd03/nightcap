"""Home's widgets: the weather and the AI's spend."""

import logging
from urllib.parse import urlencode

from . import accounts, store
from .cache import cached
from .config import S
from .ai import available as ai_available, usage_summary
from .context import me
from .http import get_json

log = logging.getLogger(__name__)


# WMO weather codes as Open-Meteo reports them.
WEATHER_TEXT = {
    0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Cloudy", 45: "Fog", 48: "Freezing fog",
    51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Showers", 81: "Showers", 82: "Heavy showers", 85: "Snow showers", 86: "Snow showers",
    95: "Thunderstorm", 96: "Thunderstorm, hail", 99: "Thunderstorm, hail",
}


def weather_icon(code, is_day):
    if code in (0, 1):
        return "☀️" if is_day else "🌙"
    if code == 2:
        return "⛅" if is_day else "☁️"
    if code == 3:
        return "☁️"
    if code in (45, 48):
        return "🌫️"
    if code in (71, 73, 75, 77, 85, 86):
        return "❄️"
    if code in (95, 96, 99):
        return "⛈️"
    if code in (51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82):
        return "🌧️"
    return "🌡️"


def weather(loc):
    """Now and today at [loc] (an account's location)."""
    fahrenheit = loc.get("countryCode") == "US"
    d = get_json("https://api.open-meteo.com/v1/forecast?" + urlencode({
        "latitude": loc["lat"], "longitude": loc["lon"],
        "current": "temperature_2m,apparent_temperature,weather_code,is_day",
        "daily": "temperature_2m_max,temperature_2m_min",
        "forecast_days": 1, "timezone": "auto",
        "temperature_unit": "fahrenheit" if fahrenheit else "celsius",
    })) or {}
    cur, day = d.get("current", {}), d.get("daily", {})
    return {
        "city": loc.get("city", ""),
        "temp": round(cur.get("temperature_2m", 0)),
        "feels": round(cur.get("apparent_temperature", cur.get("temperature_2m", 0))),
        "condition": WEATHER_TEXT.get(cur.get("weather_code"), ""),
        "icon": weather_icon(cur.get("weather_code"), cur.get("is_day", 1)),
        "high": round((day.get("temperature_2m_max") or [0])[0]),
        "low": round((day.get("temperature_2m_min") or [0])[0]),
        "unit": "F" if fahrenheit else "C",
    }


def widget_settings(p=None):
    """Which of Home's widgets this profile shows: weather for everyone, the AI's spend only for
    the admin, unless they've changed it."""
    p = p or store.profile(me())
    raw = p["settings"] or {}
    return {"show_weather": raw.get("show_weather", True), "show_ai": raw.get("show_ai", bool(p["is_admin"]))}


def widgets():
    shown, out = widget_settings(), {}
    if shown["show_ai"] and ai_available():
        out["ai"] = usage_summary()
    loc = accounts.location()
    if shown["show_weather"] and loc:
        try:
            out["weather"] = cached(f"weather:{loc['lat']:.2f},{loc['lon']:.2f}", lambda: weather(loc),
                                    ttl=S.advanced.cache.weather_minutes * 60)
        except Exception:
            log.exception("Weather unavailable")
    return out
