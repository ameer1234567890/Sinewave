# Contributing to Sinewave

Thanks for helping out! Bug reports, ideas, docs fixes and code are all welcome.

## Before you start

- **Small fixes** (typos, obvious bugs, docs): just open a pull request.
- **Bigger changes** (new features, new dependencies, changes to the database or the player): please [open an issue](https://github.com/elliottmarter/Sinewave/issues/new/choose) first so we can agree on the approach before you spend time on it.
- **Security problems**: please don't open a public issue. Use [private vulnerability reporting](https://github.com/elliottmarter/Sinewave/security/advisories/new) instead.

## Running Sinewave locally

You need **Node.js 22.13 or newer** (it has SQLite built in, so there is no database to install).

```sh
git clone https://github.com/elliottmarter/Sinewave.git sinewave
cd sinewave/server
npm install
npm run dev        # restarts on file changes; data goes in server/data/
```

Open http://localhost:8080 and sign in as `admin` / `admin` (set `ADMIN_USERNAME` and `ADMIN_PASSWORD` to change them). Open http://localhost:8080/player/ in another window to get a player you can pair.

To try the full Docker image instead:

```sh
cp .env.example .env
docker compose up -d --build
```

Where things live:

| Folder | What's in it |
| --- | --- |
| `server/src/` | The Node.js server: REST API, WebSocket hub, auth, news feeds, web previews |
| `server/migrations/` | SQLite schema changes, applied in filename order on start |
| `server/public/` | The dashboard (plain HTML, CSS and JavaScript, no build step) |
| `player/` | The web player and its service worker |
| `e2e/` | End-to-end test with Playwright |
| `docs/` | [Architecture notes](docs/architecture.md) and screenshots |

## Tests

Unit tests use Node's built-in test runner and run in a second:

```sh
cd server && npm test
```

The end-to-end test drives a real dashboard and a headless player against a running server. It is slower, so run it when you change pairing, playlists, the player or offline behaviour:

```sh
cd e2e
npm install
npx playwright install chromium
npm test           # expects a server on http://localhost:8080
```

Every pull request automatically runs the unit tests and builds the Docker image. Both must pass before a pull request can be merged.

## Code style

There is no linter yet, so please match the code around you:

- Modern JavaScript with ES modules (`import`/`export`), no TypeScript and no build step.
- Two-space indentation, single quotes, semicolons.
- Keep dependencies to a minimum. Prefer what Node.js and the browser already provide.
- Database changes go in a **new** numbered file in `server/migrations/`. Never edit a migration that has already been released.
- Add or update tests for behaviour you change, especially in `server/test/`.
- Write user-facing text (dashboard labels, docs) in plain, friendly English.

## Version numbers

Sinewave has **one** version number for the server, the dashboard and the player. It lives in [`player/version.js`](player/version.js), and `server/package.json` repeats it (a unit test checks they match). The dashboard shows it in the sidebar, and screens show it small in a corner.

**Every pull request bumps the version**, so anyone can tell which build they are running:

- Bug fixes and small tweaks bump the last number: `0.4.0` → `0.4.1`.
- New features bump the middle number and reset the last: `0.4.1` → `0.5.0`.
- The first number stays `0` until Sinewave is ready for general use.

Change it in both `player/version.js` and `server/package.json`. A **Version bumped** check on each pull request reminds you if you forget. If two pull requests pick the same number, the one merged second takes the next number up.

## Opening a pull request

1. Fork the repository and create a branch from `main` (for example `fix-video-looping`).
2. Make your change, bump the version (see above), and run `cd server && npm test`.
3. Open a pull request against `main`. The template will ask what changed and how you tested it. Screenshots help a lot for anything visual.
4. Checks run automatically. If one fails, click **Details** next to it to see why, push a fix to the same branch, and the pull request updates itself.

Nobody pushes straight to `main`, maintainers included: every change goes through a pull request with passing checks.

## License

By contributing, you agree that your contributions are released under the [MIT License](LICENSE).
