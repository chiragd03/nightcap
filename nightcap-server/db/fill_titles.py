"""Fills the shared title caches (titles, episodes) for every title in the library and in the
current recommendations.

TMDB supplies everything that's shown (names, plots, genres, language, images, ratings, air
dates); Cinemeta supplies only a show's episode list and numbering, because that's what the
stream add-ons expect. Episodes TMDB numbers differently keep Cinemeta's name and get no
still (no Stremio images are used).

    set -a; . ./.env; set +a; .venv/bin/python db/fill_titles.py

Safe to run again: rows are updated in place.
"""

import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nightcap import store  # noqa: E402
from nightcap.titles import episode_rows, title_row  # noqa: E402


def main():
    # Plain (tuple) rows here, unlike the server's pool.
    with psycopg.connect(store.conninfo()) as db:
        db.execute(open(Path(__file__).with_name("schema.sql")).read())
        wanted = dict(db.execute("SELECT imdb_id, type FROM library").fetchall())
        for row in db.execute("SELECT rows FROM recommendations").fetchall():
            for metas in (row[0] or {}).values():
                for m in metas:
                    if str(m.get("id", "")).startswith("tt") and m.get("type") in ("movie", "series"):
                        wanted.setdefault(m["id"], m["type"])

        def fetch(item):
            imdb_id, ctype = item
            try:
                t = title_row(imdb_id, ctype)
                eps = episode_rows(imdb_id, t and t["tmdb_id"]) if ctype == "series" else []
                return imdb_id, ctype, t, eps, None
            except Exception as e:
                return imdb_id, ctype, None, [], e

        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(fetch, wanted.items()))

        titles = episodes = matched = 0
        missing, failed = [], []
        for imdb_id, ctype, t, eps, err in results:
            if err:
                failed.append((imdb_id, f"{type(err).__name__}: {err}"[:80]))
                continue
            if t is None:
                missing.append(imdb_id)
                if db.execute("SELECT 1 FROM titles WHERE imdb_id = %s", (imdb_id,)).fetchone():
                    continue  # (What was saved stays.)
            store.save_title(t or store.blank_title(imdb_id, ctype), eps, db)
            titles += 1
            episodes += len(eps)
            matched += sum(e["still"] is not None for e in eps)
        db.commit()
        print(f"titles: {titles} ({len(missing)} not on TMDB: {missing[:8]})")
        print(f"episodes: {episodes} ({matched} with a TMDB still)")
        if failed:
            print(f"failed (run again to retry): {failed}")


if __name__ == "__main__":
    main()
