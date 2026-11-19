# Sinewave

**Everyone, on the same wavelength.**

Open source digital signage software.

Sinewave aims to make it simple to run digital signage on ordinary hardware: build content, schedule it, and push it to screens without vendor lock-in or licence fees.

![Screens dashboard](docs/images/dashboard-screens-online.png)

## Goals

- **Self-hostable**: run the whole stack on your own server or a single machine.
- **Cheap players**: display content on low-cost devices such as a Raspberry Pi, a mini PC, or any modern browser.
- **Content and scheduling**: manage images, video, web pages and playlists, and schedule what plays where and when.
- **Remote management**: see and control every screen from one dashboard.

## What works today

- **Dashboard** to upload images and videos, add web pages, and build playlists (ordering and per-item durations).
- **Screen pairing**: open the player on a display, it shows a 6-character code, and you type that code into the dashboard.
- **Live updates**: each player keeps a WebSocket open, so a saved playlist shows up on screen in well under a second. Polling covers the gaps if the socket drops.
- **Offline playback**: the player caches its files with a service worker and keeps looping them if the network or server goes away, including after a reboot.
- **Fleet status**: see which screens are online, what they are playing, and send a refresh or reload remotely.

| Playlist editor | Player waiting to pair | Player showing content |
| --- | --- | --- |
| ![](docs/images/dashboard-playlist-editor.png) | ![](docs/images/player-pairing-code.png) | ![](docs/images/player-playing-menu.png) |

## Quick start

You need Docker with Compose.

```sh
git clone https://github.com/elliottmarter/Sinewave.git sinewave
cd sinewave
cp .env.example .env        # then set ADMIN_PASSWORD and POSTGRES_PASSWORD
docker compose up -d --build
```

1. Open **http://localhost:8080** and sign in with your `ADMIN_PASSWORD` (it defaults to `admin` if you skip `.env`).
2. Upload some media under **Media**, then create a playlist under **Playlists** and add items to it.
3. On the screen you want to use, open **http://&lt;server&gt;:8080/player/**. It shows a pairing code.
4. In the dashboard, go to **Screens → Pair screen**, type the code, name the screen and pick the playlist.

The screen starts playing straight away.

### Running the player in kiosk mode

Any Chromium-based browser works. On a Raspberry Pi or mini PC:

```sh
chromium --kiosk --noerrdialogs --disable-infobars --autoplay-policy=no-user-gesture-required \
  https://signage.example.com/player/
```

Add `?debug` to the player URL to show a small status overlay (connection, cache, what's playing).

### HTTPS and offline caching

Browsers only allow service workers, and so offline caching, on **HTTPS** or **localhost**. Over plain `http://` on a LAN the player still works, but it streams everything live and goes blank if the server is unreachable. For real deployments put the server behind a reverse proxy with TLS (Caddy, Traefik, nginx) and set `SECURE_COOKIES=true` and `TRUST_PROXY=true`. For a quick LAN trial you can instead launch Chromium with `--unsafely-treat-insecure-origin-as-secure=http://<server>:8080`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD` | `admin` | Dashboard password. Change it. |
| `POSTGRES_PASSWORD` | `signage` | Database password. |
| `PORT` | `8080` | Port published on the host. |
| `MAX_UPLOAD_MB` | `1024` | Largest file you can upload. |
| `SECURE_COOKIES` | `false` | Mark the session cookie `Secure` (set when using HTTPS). |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*` headers from a reverse proxy. |

Media files live in the `media` Docker volume and the database in `pgdata`.

## Project layout

```
server/     Node.js CMS: REST API, WebSocket hub, Postgres migrations, dashboard (server/public)
player/     The web player: plain HTML/JS plus a service worker, served at /player/
e2e/        End-to-end test that drives the dashboard and a headless player with Playwright
docs/       Architecture notes and screenshots
```

See [docs/architecture.md](docs/architecture.md) for how the pieces fit together.

## Development

```sh
docker compose up -d db                       # just Postgres
cd server && npm install
DATABASE_URL=postgres://signage:signage@localhost:5432/signage npm run dev
```

The compose file doesn't publish the database port, so for local development either add `ports: ["5432:5432"]` to the `db` service or run your own Postgres.

### End-to-end test

With the stack running:

```sh
cd e2e
npm install
npx playwright install chromium
npm test        # BASE_URL and ADMIN_PASSWORD can be overridden
```

It uploads media, builds a playlist, pairs a headless player, checks that a playlist change reaches the screen live, then cuts the player's network and checks it keeps playing from its cache. Screenshots are written to `e2e/screenshots/`. If `ffmpeg` is installed the test also covers video.

## Status

Early development. The MVP above works end to end, but there is no scheduling, multi-user support or native player wrapper yet. See the roadmap in [docs/architecture.md](docs/architecture.md).

## Contributing

Issues and pull requests are welcome. Please open an issue to discuss larger changes before starting work.

## License

Released under the [MIT License](LICENSE).
