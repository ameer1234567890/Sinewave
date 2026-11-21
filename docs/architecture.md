# Sinewave architecture

Sinewave has two parts: a **server** that you host once, and a **player** that runs on every screen.

```
 ┌──────────── sinewave container ─────────────┐
 │                                             │
 │  Node.js process                            │
 │  ├─ dashboard  /                            │
 │  ├─ REST API   /api/...                     │
 │  ├─ WebSocket  /ws/player                   │
 │  ├─ files      /media/<id>/...              │
 │  └─ player     /player/                     │
 │                                             │
 │  /data volume                               │
 │  ├─ sinewave.db   (SQLite)                  │
 │  └─ media/        (uploaded files)          │
 └──────────▲─────────────────────▲────────────┘
            │ HTTP + WebSocket    │ HTTP
   ┌────────┴────────┐   ┌────────┴────────┐
   │ player (screen) │   │ browser (admin) │
   │ service worker  │   │ dashboard       │
   │ + media cache   │   └─────────────────┘
   └─────────────────┘
```

## Server

`server/` is a single Node.js process (Express and `ws`) that stores everything in SQLite through Node's built-in `node:sqlite` module, so there are no native dependencies and no separate database to run. The database runs in WAL mode with foreign keys on. Migrations in `server/migrations/` run at startup, so `docker compose up` is all the setup there is.

SQLite comfortably handles the write load of hundreds of screens (heartbeats, status updates and edits). If a deployment ever outgrows it, the queries are kept to plain SQL behind `db.js` so a Postgres backend can be added.

| Table | What it holds |
| --- | --- |
| `media` | Uploaded images and videos (file on disk plus a sha256), web page URLs, news items (feed URL plus JSON display options), and slides (template, background, text and picture ids, as JSON). |
| `integrations` | Connections to other systems (one row each, e.g. `autotask`): settings as JSON, the API secret in its own write-only column, and the last good copy of the data with when it was fetched and the last error. |
| `news_feeds` | The last good copy of each news feed in use: title, stories (JSON), ETag, and the last error. |
| `playlists`, `playlist_items` | Ordered items, each with an optional duration override. |
| `screens` | Paired players: name, assigned playlist, hashed device token, last seen, now playing. |
| `pairing_requests` | Short-lived codes shown by unpaired players. |
| `settings` | Server-wide values, such as the session signing secret. |

The app version lives in `player/version.js`, loaded by the player, the dashboard and the server, so all three report the same number. Players send theirs in their `status` message, and the dashboard flags a screen running an older version. The manifest carries screen-wide `display` options (today just `showVersion`, from the `settings` table), so changing one reaches every screen like a content change.

Slides are stored as settings, not pictures. `player/slides.js` holds the templates, the backgrounds (gradients and patterns generated in code, so there are no image files or licences to worry about) and the renderer; the player, the dashboard (for the editor preview and thumbnails) and the server (to check input) all load that one file. Slide layouts are sized with container query units, so the same slide fits a full screen, a thumbnail or a portrait display. A slide's picture is an image from Media; the manifest lists it as an asset so players cache it.

News feeds are fetched by the server (no CORS problems, and one request per feed however many screens show it), every `NEWS_REFRESH_MINUTES` (15 by default), with conditional requests. Story photos are downloaded to `DATA_DIR/media/news/` and served from `/media/news/...`, so players cache them like any other file; photos no stored feed uses are deleted after a day. When a feed's stories change, screens showing it get a `content-changed` push. A feed that fails keeps its last good stories.

Ticket stats widgets (media kind `autotask`) read from Autotask PSA's REST API. A super admin enters an API user (username, secret, integration code) under Integrations; the zone is found from the username with Autotask's `zoneInformation` lookup, and the credentials are tested before they're saved. While any widget exists, the server polls every couple of minutes (open tickets, tickets completed and created in the last 7 days, plus hourly lookups of queues, statuses, priorities, resource and company names), keeping at most 5,000 tickets per query, and stores a compact copy in `integrations.snapshot`. Each widget's numbers are worked out on the server for its filters and sent in the manifest, so screens never contact Autotask or see credentials. With **Hide private information** on, company names and ticket titles are removed on the server before they reach the manifest. A failed refresh keeps the last good copy, and screens mark the numbers as old when several refreshes are missed. Without credentials, or with demo data switched on, `demoSnapshot()` makes believable tickets instead. `player/autotask.js` holds the layouts, settings and renderer, shared like `slides.js`.

Uploaded files are stored at `DATA_DIR/media/<media id>/<file name>`. A file never changes once uploaded, so `/media/...` is served with a one-year immutable cache header, and players can cache it by URL.

### Authentication

- **People** sign in with a username and password (stored as salted scrypt hashes in the `users` table) and get an HMAC-signed, HTTP-only session cookie holding their user id. Each request reloads the account, so a role change or deletion applies at once, and changing a password signs that account out elsewhere. Roles are `super_admin` (everything) and `standard` (edit screens, media and playlists, but not pair or remove screens or manage users). The server checks roles on every request; the dashboard only hides what you can't use. The first super admin is created from `ADMIN_PASSWORD` on first boot.
- **Players** each hold a random device token. The server stores only its sha256. The token goes in an `Authorization: Bearer` header for HTTP and a query parameter for the WebSocket. Removing a screen in the dashboard revokes its token and sends the player back to pairing.

## Pairing

1. An unpaired player calls `POST /api/player/pairing` and gets a 6-character code (no look-alike characters such as 0/O or 1/I), plus a private pairing secret.
2. It shows the code and polls `GET /api/player/pairing/:id` with the secret every 3 seconds.
3. An admin types the code into **Pair screen**. The server creates the screen and its token, and attaches the token to the pairing request.
4. The player's next poll receives the token, exactly once, and stores it.

Codes expire after 15 minutes, and the player asks for a fresh one automatically.

## Content sync

The player asks for a **manifest** with `GET /api/player/manifest`: the screen's name and its playlist, with each item's URL, type, duration and checksum. The manifest has a `version` hash, and the endpoint supports `If-None-Match`, so an unchanged check is a cheap 304.

Change notifications go over a WebSocket at `/ws/player`. When an admin saves a playlist, reassigns a screen, or edits or deletes media in use, the server sends a tiny `{"type":"content-changed"}` to the affected screens. The player then re-fetches the manifest. Messages carry no content themselves, so a missed message never leaves a screen in a wrong state: the next fetch fixes it.

As a fallback, the player polls the manifest every 30 seconds while the socket is down and every 5 minutes while it's up. Reconnects back off exponentially, with jitter, up to a minute, so a server restart doesn't get hit by every screen at once.

The server pings each socket every 30 seconds and drops dead ones. A screen counts as **online** if it has a live socket or fetched its manifest in the last 90 seconds (`ONLINE_WINDOW_SECONDS`).

The socket also carries:

- `reload` (server to player): restart the player page.
- `unpaired` (server to player): the screen was removed.
- `status` (player to server): what's playing now and the player version, shown in the dashboard.

## Player and offline playback

`player/` is plain HTML, CSS and JS with no build step, so it can be served by the server or bundled into a native shell unchanged.

- **Playback**: two stacked layers. The next item loads into the hidden layer and only fades in once it can render, so there's no flash of black between items. Images and web pages show for their duration (10s and 30s by default). Videos play to the end unless a duration is set. Videos are muted so browsers allow autoplay. News items arrive with their stories inside the manifest, and the player draws them itself (text is always set as text, never HTML), cycling through stories; by default the item shows each story once. Slides also arrive as settings in the manifest and are drawn by the player from `slides.js` (10s by default).
- **Updates mid-loop**: if a new manifest still contains the item on screen, that item finishes and the loop carries on in the new order. If the item was removed or the playlist swapped, the player switches right away.
- **Caching**: on each new manifest the player downloads every file into Cache Storage (`sinewave-media-v1`) before switching, then deletes files no longer used. The service worker (`sw.js`) answers `/media/...` requests from that cache, including byte-range requests, which video elements use for seeking. The player shell is network-first with a cached fallback, and the last manifest is kept in `localStorage`. Together these let a screen that reboots with no network go straight back to playing.
- **Limits**: service workers only run on HTTPS or localhost. Browser storage quotas apply, usually a share of free disk. Web page items are always loaded live. News items play from the manifest and cached photos, so they work offline with the stories they last received.

### Wrapping the player later

The player reads an optional `window.SINEWAVE_CONFIG` before it starts:

```js
window.SINEWAVE_CONFIG = {
  serverUrl: 'https://signage.example.com', // default: the origin it was loaded from
  storage: someLocalStorageCompatibleObject, // default: localStorage
  disableServiceWorker: false,
};
```

A native shell (Electron on PCs and Raspberry Pi, a WebView on Android) can load the same files from disk, set `serverUrl`, and add what a browser tab can't do: auto-start, a watchdog, screenshots, reboots and display power schedules. `window.sinewavePlayer` exposes the player's state and `sync()` for the shell to use. Loading the player from a different origin than the server will need CORS on `/api/player` and `/media`, which the server doesn't send yet.

## Roadmap

Roughly in order:

1. **Scheduling**: dayparting and date ranges per playlist, with a default fallback.
2. **Layouts with zones**: split the screen into regions (main content, ticker, clock, logo).
3. **Screen groups and tags**: assign content to many screens at once.
4. **Widgets**: clock, weather, RSS, and rich text or HTML slides made in the dashboard.
5. **Native player shells**: Electron and Raspberry Pi image, then Android, adding screenshots, remote reboot and screen on/off schedules.
6. **Multi-user accounts and roles**, an audit log, and a public API with tokens.
7. **Object storage** (S3-compatible) as an alternative to the local media volume, plus thumbnails and video transcoding.
