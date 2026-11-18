# Nightcap on Samsung and LG TVs

The small app that gets installed on Samsung (Tizen) and LG (webOS) TVs. It asks for the Nightcap server's address once, then opens the TV app that the server itself serves at `/app/tv/`. That TV app is in [`nightcap-web/tv`](../nightcap-web), so it updates with the server and this launcher rarely changes.

The launcher also remembers every server the TV has joined, so the TV app's Connect screen can switch between them. It supports TVs from 2020 on (Tizen 5.5+, webOS 5+).

Most people install the ready-built packages from the newest `samsung-v…` and `lg-v…` releases in [Releases](https://github.com/chiragd03/nightcap/releases).

## What's here

- `launcher/`: the launcher itself (HTML, CSS, JavaScript and fonts), the same on both TVs
- `tizen/`: Samsung's `config.xml` and icon
- `webos/`: LG's `appinfo.json`, icons and splash screen
- `build.sh`: puts the launcher and each TV's files together in `build/tizen` and `build/webos`

## Build and install

```sh
cd nightcap-tvweb
./build.sh
```

- **Samsung:** with Tizen Studio (TV extension) and a Samsung certificate profile, run `tizen package -t wgt -s <profile> -- build/tizen`. Install the `.wgt` on a TV in Developer Mode: `sdb connect <tv ip>`, then `tizen install -n Nightcap.wgt -t <tv>`.
- **LG:** with the webOS TV CLI, run `ares-package build/webos`. Install the `.ipk` with `ares-install` on a TV in Developer Mode (LG's Developer Mode app). Extend the Developer Mode session now and then, or the TV removes the app.

To try the launcher without a TV, open `build/tizen/index.html` in Chrome, with a Nightcap server running.

## Developing the TV app

The TV app is developed in `nightcap-web` with a desktop browser standing in for the TV:

```sh
cd nightcap-web
NIGHTCAP_SERVER=http://localhost:7171 npm run dev:tv     # then open http://localhost:5177/app/tv/
```

The arrow keys, Enter and Escape act as the remote's D-pad, OK and Back.

## Licence

[AGPL-3.0](../LICENSE), like the rest of Nightcap. The fonts in `launcher/fonts` are under the SIL Open Font License, included next to them: [`big-shoulders.txt`](launcher/fonts/big-shoulders.txt) and [`hanken-grotesk.txt`](launcher/fonts/hanken-grotesk.txt).
