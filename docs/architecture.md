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
| `media` | Uploaded images and videos (file on disk plus a sha256) and web page URLs. |
| `playlists`, `playlist_items` | Ordered items, each with an optional duration override. |
| `screens` | Paired players: name, assigned playlist, hashed device token, last seen, now playing. |
| `pairing_requests` | Short-lived codes shown by unpaired players. |
| `settings` | Server-wide values, such as the session signing secret. |

Uploaded files are stored at `DATA_DIR/media/<media id>/<file name>`. A file never changes once uploaded, so `/media/...` is served with a one-year immutable cache header, and players can cache it by URL.

### Authentication

- **Admins** sign in with `ADMIN_PASSWORD` and get an HMAC-signed, HTTP-only session cookie. Changing the password signs everyone out. This is deliberately simple for the MVP; multi-user accounts and roles come later.
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

- **Playback**: two stacked layers. The next item loads into the hidden layer and only fades in once it can render, so there's no flash of black between items. Images and web pages show for their duration (10s and 30s by default). Videos play to the end unless a duration is set. Videos are muted so browsers allow autoplay.
- **Updates mid-loop**: if a new manifest still contains the item on screen, that item finishes and the loop carries on in the new order. If the item was removed or the playlist swapped, the player switches right away.
- **Caching**: on each new manifest the player downloads every file into Cache Storage (`sinewave-media-v1`) before switching, then deletes files no longer used. The service worker (`sw.js`) answers `/media/...` requests from that cache, including byte-range requests, which video elements use for seeking. The player shell is network-first with a cached fallback, and the last manifest is kept in `localStorage`. Together these let a screen that reboots with no network go straight back to playing.
- **Limits**: service workers only run on HTTPS or localhost. Browser storage quotas apply, usually a share of free disk. Web page items are always loaded live.

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
