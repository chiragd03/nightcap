"""Checks a channel list the way Live TV reads it, printing only counts: never an address or a name.

    LIVETV_LIST='https://…' python -m nightcap.livetv_check      (from nightcap-server/)
    python -m nightcap.livetv_check path/to/list.m3u

The address is read from LIVETV_LIST (so it isn't in the command), or a file is read from disk.
"""

import os
import re
import sys
from collections import Counter
from datetime import datetime, timezone

os.environ.setdefault("TMDB_API_KEY", "unused")

from . import livetv  # noqa: E402
from .config import S  # noqa: E402
from .http import get_text  # noqa: E402
from .livetv_places import COUNTRIES, INTERNATIONAL, LANGUAGES  # noqa: E402


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8", errors="replace") as f:
            text = f.read()
    elif os.environ.get("LIVETV_LIST"):
        try:
            text = get_text(os.environ["LIVETV_LIST"].strip(), most=S.livetv.max_list_bytes,
                            timeout=S.advanced.timeouts.livetv_list_seconds)
        except Exception as e:
            sys.exit(f"Couldn't read the list: {type(e).__name__}")
    else:
        sys.exit(__doc__)
    try:
        lines = livetv.parse(text)
    except livetv.NotAList as e:
        sys.exit(str(e))
    channels = livetv.merge(lines)
    top = lambda counter, name: ", ".join(f"{name(k)} {n}" for k, n in counter.most_common(12))
    print(f"Lines read:            {len(lines)}" + (f" (the most read: {S.livetv.max_channels})"
                                                    if len(lines) >= S.livetv.max_channels else ""))
    print(f"Channels (merged):     {len(channels)}")
    print(f"With a logo:           {sum(bool(c['logo']) for c in channels)}")
    print(f"With 2+ streams:       {sum(len(c['streams']) > 1 for c in channels)}")
    print(f"Geo-blocked or not 24/7 lines: {sum(x['limited'] for x in lines)}")
    print(f"No country said:       {sum(not c['countries'] for c in channels)}")
    print(f"No language said:      {sum(not c['languages'] for c in channels)}")
    if personal(text):
        return      # a personal list: its kinds are its own names, so they aren't printed
    print(f"Kinds:     {top(Counter(c['kind'] for c in channels), livetv.kind_name)}")
    print(f"Countries: {top(Counter(x for c in channels for x in (c['countries'] or [INTERNATIONAL])), COUNTRIES.get)}")
    print(f"Languages: {top(Counter(x for c in channels for x in c['languages']), LANGUAGES.get)}")


_ATTR = re.compile(r"""([A-Za-z][\w-]*)=("[^"]*"|'[^']*')""")
# (Live TV's optional extension, if it's here, checks what it reads itself, and adds its item field.)
extension = livetv.extension
ITEM_KEYS = {"x-id", "x-row", "x-start", "x-end", "x-status", "x-about", "x-event-id", "x-channel",
             *([extension.FIELD] if extension else [])}


def _attrs(line):
    """A line's attributes before its name (the first comma outside quotes)."""
    head, quote = line, None
    for i, ch in enumerate(line):
        if quote:
            quote = None if ch == quote else quote
        elif ch in "\"'":
            quote = ch
        elif ch == ",":
            head = line[:i]
            break
    return {k: v[1:-1] for k, v in _ATTR.findall(head)}


def _when(value):
    try:
        t = datetime.fromisoformat(value)
    except ValueError:
        return "bad"
    return t if t.tzinfo else "no timezone"


def personal(text):
    """The personal-list fields, as field names, counts and checks: never a value, an address or a name."""
    lines = text.lstrip("﻿").splitlines()
    header = _attrs(lines[0]) if lines else {}
    items = [_attrs(x) for x in lines if x.startswith("#EXTINF")]
    if not any(k.startswith("x-") for a in items for k in a) and not any(k.startswith("x-") for k in header):
        return False
    print("\nPersonal list fields")
    print(f"Header fields:         {', '.join(sorted(header)) or 'none'}")
    names = extension.check(lines) if extension else set()
    used = Counter(k for a in items for k in a if k.startswith("x-"))
    print(f"Items:                 {len(items)}")
    print(f"Item fields used:      {', '.join(f'{k} {n}' for k, n in sorted(used.items())) or 'none'}")
    if set(used) - ITEM_KEYS:
        print(f"Other item fields:     {', '.join(sorted(set(used) - ITEM_KEYS))}  (a list's Advanced settings can map them)")
    rows = Counter(a.get("x-row") for a in items if a.get("x-row"))
    print(f"Rows:                  {len(rows)} (items each, in file order: {', '.join(str(n) for n in rows.values()) or '-'})"
          + (f"; {sum(1 for a in items if not a.get('x-row'))} items without a row" if rows else ""))
    ids = Counter(a["x-id"] for a in items if a.get("x-id"))
    if any(n > 1 for n in ids.values()):
        print(f"x-id used twice:       {sum(1 for n in ids.values() if n > 1)} ids")
    now, problems, state = datetime.now(timezone.utc), Counter(), Counter()
    for a in items:
        start = _when(a["x-start"]) if "x-start" in a else None
        end = _when(a["x-end"]) if "x-end" in a else None
        for field, t in (("x-start", start), ("x-end", end)):
            if isinstance(t, str):
                problems[f"{field} {t}"] += 1
        if isinstance(start, datetime) and isinstance(end, datetime) and end <= start:
            problems["x-end not after x-start"] += 1
        status = a.get("x-status")
        if status and status not in ("live", "upcoming", "24/7"):
            problems["x-status not live, upcoming or 24/7"] += 1
        if extension and a.get(extension.FIELD) and a[extension.FIELD] not in names:
            problems[f"{extension.FIELD} names nothing the list has"] += 1
        if status:
            state[status] += 1
        elif not isinstance(start, datetime) and not isinstance(end, datetime):
            state["24/7"] += 1
        elif isinstance(end, datetime) and now >= end:
            state["ended (hidden)"] += 1
        elif isinstance(start, datetime) and now < start:
            state["upcoming"] += 1
        else:
            state["live"] += 1
    print(f"Right now:             {', '.join(f'{k} {n}' for k, n in state.most_common()) or '-'}")
    print("Problems:              " + (", ".join(f"{k} {n}" for k, n in problems.most_common()) or "none"))
    return True


if __name__ == "__main__":
    main()
