# Nightcap web app

The browser version of Nightcap, and the TV app for Samsung and LG TVs. The Nightcap server serves both: the web app at `/app/`, the TV app at `/app/tv/`.

- **Web app** (`src/`): Home, title pages, Search, Live TV, Sent to TV, Play on TV, Settings (with the household admin's pages), the invite page and the server owner's page. Works on laptops and phones.
- **TV app** (`tv/`): the same Homes, made for a remote. It runs on the browser engines of 2020 TVs (Tizen 5.5, webOS 5).

Both are React + TypeScript, built with Vite.

## What you need

- Node.js 22
- A running Nightcap server for the app to talk to (see [`nightcap-server`](../nightcap-server))

## Build

```sh
cd nightcap-web
npm ci
npm run build        # → dist/ (the web app) and dist/tv/ (the TV app)
```

The build is static files for the path `/app/`. To have a server you run from source serve it, start the server with `WEB_DIR` pointing at the build:

```sh
WEB_DIR=../nightcap-web/dist .venv/bin/python -m nightcap     # from nightcap-server/
```

## Develop

```sh
npm run dev          # web app: http://localhost:5173/app/
npm run dev:tv       # TV app:  http://localhost:5177/app/tv/  (arrow keys and Enter act as the remote)
```

The dev servers forward API calls to a Nightcap server at `http://localhost:7171`. To use another one:

```sh
NIGHTCAP_SERVER=http://192.168.1.20:7171 npm run dev
```

A browser joins a household once, like a TV, and keeps its device key in local storage.

## Tests and lint

```sh
npm test
npm run lint
```

## The server and web app as one Docker image

From the repository's root (the image builds this app too):

```sh
docker build -f nightcap-server/Dockerfile -t nightcap .
```

## Licence

[AGPL-3.0](../LICENSE), like the rest of Nightcap.
