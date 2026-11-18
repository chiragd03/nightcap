# Nightcap Server Setup

The `nightcap` command: sets up a Nightcap server and manages it afterwards. It asks a few questions on screen (where the server runs, its database, its keys, its name) and then sets it up. It runs on Docker on this computer, on a Kubernetes cluster, or on Google Cloud Run. It can also just write the files for another machine.

Afterwards it shows each server's status and logs, and can update, restart, stop, start or remove it.

Most people install the ready-built program from [Releases](https://github.com/chiragd03/nightcap/releases) instead of building it.

## Install

Mac and Linux:

```sh
curl -fsSL https://mynightcap.tv/install.sh | sh
```

It installs the newest `setup-v…` release as `nightcap` in `~/.local/bin`, after checking it against the release's checksums. Windows: download `nightcap-setup-windows-amd64.exe` from the newest `setup-v…` release.

Then run `nightcap`. Use the arrow keys to choose, `enter` to select and `q` to quit.

## Commands

| Command | What it does |
|---|---|
| `nightcap` | Set up a server, or manage one set up before |
| `nightcap update` | Update this program to the newest release |
| `nightcap template "<server>" setup.json` | Give a server's own AIOStreams your own household setup (an AIOStreams export). With no file, it goes back to the server's default. |
| `nightcap --version` | Show the version |

The servers it sets up are listed in `~/.nightcap-setup/servers.json`, which holds no keys. Each server's keys stay in its own folder, in files only you can read.

Settings: `NIGHTCAP_SERVER_IMAGE` (the server image, default `docker.io/chiragdahiya3/nightcap:latest`), `NIGHTCAP_NO_UPDATE_CHECK=1` (don't check GitHub for a newer version), `NIGHTCAP_THEME=light` or `dark` (for a terminal that can't say).

## Build

Go 1.25 or newer:

```sh
cd nightcap-setup
go build -o nightcap .
```

Builds for every platform, with checksums, as the releases have them: `VERSION=1.0.0 ./release.sh` (into `release/`).

## Tests

```sh
go test ./...
```

Some tests need real services and run only when they're given:

| Setting | What it checks |
|---|---|
| `PG_TEST_URL` | Real database connections, with a throwaway Postgres's superuser (it makes and drops a test database and user) |
| `DOCKER_TEST=1` | A real Postgres container, made and removed (needs Docker and a network named `nctest`) |
| `TMDB_TEST_KEY` | A real TMDB key and a wrong one |

## Data it carries

- `data/zone.tab`: the tz database's zones (public domain), to guess the nearest Google Cloud region from this computer's time zone. Nothing is looked up online.
- `data/windowszones.tsv`: Windows time zone names to tz zones, from Unicode CLDR. Copyright © 1991-2025 Unicode, Inc., under the Unicode License v3 (https://www.unicode.org/license.txt).

## Licence

[AGPL-3.0](../LICENSE), like the rest of Nightcap.
