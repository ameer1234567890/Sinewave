/*
 * Service worker for the Sinewave player.
 *
 * - The player shell (HTML/JS/CSS) is network-first with a cached fallback, so updates
 *   arrive when online and the player still boots when offline.
 * - Media files (/media/...) are served cache-first from the cache the player fills
 *   during sync, including byte-range requests so cached videos can play and seek.
 * - API calls and the WebSocket are never cached.
 */
const SHELL_CACHE = 'sinewave-shell-v5';
const MEDIA_CACHE = 'sinewave-media-v1';
const SHELL_FILES = ['./', './index.html', './version.js', './player.js', './player.css', './slides.js', './slides.css', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, MEDIA_CACHE]);
      for (const key of await caches.keys()) {
        if (key.startsWith('sinewave-') && !keep.has(key)) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/media/')) {
    event.respondWith(mediaResponse(req));
    return;
  }
  const scopePath = new URL(self.registration.scope).pathname;
  if (url.pathname.startsWith(scopePath)) {
    event.respondWith(shellResponse(req));
  }
});

async function shellResponse(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

async function mediaResponse(req) {
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(req.url);
  if (!cached) return fetch(req);
  const range = req.headers.get('range');
  return range ? rangeResponse(cached, range) : cached;
}

/** Answer a "Range: bytes=start-end" request from a full cached response. */
async function rangeResponse(full, rangeHeader) {
  const blob = await full.blob();
  const size = blob.size;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return new Response(blob, { status: 200, headers: full.headers });
  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);
  if (start === null) {
    // Suffix range: the last N bytes.
    start = Math.max(size - (end ?? 0), 0);
    end = size - 1;
  } else {
    end = end === null ? size - 1 : Math.min(end, size - 1);
  }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': full.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}
