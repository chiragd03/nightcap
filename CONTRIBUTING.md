# Contributing to Nightcap

Thanks for helping. Nightcap is a self-hosted streaming system: a setup tool (`nightcap`), a server with a web app, an Android TV app, and Samsung and LG TV apps.

## Ways to help
- **Report a bug** with the [bug form](https://github.com/chiragd03/nightcap/issues/new/choose). Say which part (setup, server, web app, Android TV, Samsung, LG), its version, and how to make it happen again.
- **Suggest an idea** in [Discussions](https://github.com/chiragd03/nightcap/discussions) first, so others can weigh in. Check the [roadmap](ROADMAP.md) too.
- **Improve the docs**: small fixes can go straight to a pull request.
- **Send code**: for anything bigger than a small fix, open an issue or discussion first, so we agree on the approach before you spend time on it.

## Where the code is
- `nightcap-server/`: the server (Python, FastAPI, PostgreSQL). Tests: `python -m unittest discover -s tests`.
- `nightcap-web/`: the web app and the Samsung/LG TV app (React, TypeScript, Vite). Tests: `npm test`, lint: `npm run lint`.
- `nightcap-setup/`: the setup tool, the `nightcap` command (Go). Tests: `go test ./...`.

Each folder's README says how to run it. The Android TV app is released as a ready-built file only.

## Pull requests
1. Fork the repo and make a branch from `main`.
2. Keep one change per pull request, with a clear title in plain words ("Live TV: keep the channel when the guide reloads").
3. Add or update tests where the part you touch has them, and make sure they pass.
4. Describe what changed and how you checked it. Screenshots help for anything on screen.
5. Don't include secrets, API keys, or media you don't have the right to share.

## Ground rules
- Be kind and patient. Everyone here follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- Nightcap doesn't host any content. Please don't open issues or pull requests that name, link or add sources of pirated material; they'll be closed.
- Security problems go through [SECURITY.md](SECURITY.md), never a public issue.

By contributing, you agree your contribution is shared under this repository's licence.
