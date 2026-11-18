# Nightcap server

The server behind Nightcap: households, profiles, Homes, search, Play on TV, Live TV and the player's sources. It is a Python web service (FastAPI) with a PostgreSQL database.

Most people don't need this folder. The `nightcap` setup command from [Releases](https://github.com/chiragd03/nightcap/releases) installs and runs the server for you. This is for running it yourself or working on it.

## What you need

- Python 3.12 or newer
- PostgreSQL (tested on 16), with an empty database
- A free [TMDB](https://www.themoviedb.org) API key

## Run it

```sh
cd nightcap-server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

cp .env.example .env        # then fill it in
set -a; . ./.env; set +a
.venv/bin/python -m nightcap
```

The server listens on port 7171 and sets up its database tables itself when it starts. To also serve the web app and the Samsung/LG TV app, build [`nightcap-web`](../nightcap-web) and start the server with `WEB_DIR=../nightcap-web/dist`.

**Or as one Docker image** with the server, the web app and the TV app, built from the repository's root:

```sh
docker build -f nightcap-server/Dockerfile -t nightcap .
```

Run it with the same settings (as environment variables) and port 7171.

`.env.example` describes each setting:

| Setting | What it is |
|---|---|
| `TMDB_API_KEY` | Your TMDB key, for posters and details |
| `DATABASE_URL` | Your PostgreSQL database, e.g. `postgresql://user:password@localhost:5432/nightcap` |
| `SECRETS_KEY` | A long random string. It encrypts each household's keys in the database. Keep it, and keep it the same. |
| `OWNER_KEY` | The server owner's key (at least 32 characters), sent as `X-Owner-Key` to create households |
| `MODE` | `home` on a home network (TVs find the server, joining needs no code), or `cloud` (the default) |

A random key: `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`

Every other setting, with its default, is in `nightcap/defaults.toml`.

## Your first household

```sh
curl -X POST http://localhost:7171/server/households \
  -H "X-Owner-Key: $OWNER_KEY" -H "Content-Type: application/json" \
  -d '{"name": "Home", "admin": "Alex"}'
```

The answer includes an 8-character join code for the first device.

## Tests

```sh
.venv/bin/python -m unittest discover -s tests
```

Tests that need a database run only when `DATABASE_URL` and `SECRETS_KEY` are set. Point them at a throwaway database: they write to it.

## Licence

[AGPL-3.0](../LICENSE), like the rest of Nightcap.
