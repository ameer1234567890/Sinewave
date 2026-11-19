/*
 * Sinewave web player.
 *
 * Runs in any modern browser (a Chrome kiosk tab today, an Electron or Android WebView shell later).
 * Flow: get a pairing code -> wait for an admin to claim it -> receive a device token ->
 * fetch the content manifest -> cache its files -> loop through the playlist.
 * A WebSocket delivers instant "content changed" pushes; polling covers the gaps.
 *
 * A wrapper can set window.SINEWAVE_CONFIG = { serverUrl, storage } before this script loads
 * to point the player at a server and swap in native storage.
 */
(() => {
  'use strict';

  const PLAYER_VERSION = '0.2.0';
  const MEDIA_CACHE = 'sinewave-media-v1';
  const POLL_CONNECTED_MS = 5 * 60_000; // safety net while the socket is up
  const POLL_DISCONNECTED_MS = 30_000; // fallback while the socket is down
  const PAIR_POLL_MS = 3_000;

  const cfg = window.SINEWAVE_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const serverUrl = (cfg.serverUrl || new URL('..', location.href).href).replace(/\/+$/, '');
  const storage = cfg.storage || window.localStorage;
  const debugEnabled = params.has('debug');
  const canCache = 'caches' in window && window.isSecureContext;

  const $ = (id) => document.getElementById(id);
  const layers = [$('layer-a'), $('layer-b')];

  const state = {
    token: storage.getItem('sinewave.token'),
    manifest: null,
    ws: null,
    wsConnected: false,
    reconnectDelay: 1000,
    pollTimer: null,
    playToken: 0, // bumps to cancel the current playback loop
    index: -1,
    activeLayer: 0,
    nowPlaying: null,
    nowPlayingMediaId: null,
    lastSync: null,
    lastError: null,
    online: navigator.onLine,
  };

  // ---------- helpers ----------

  const api = (path) => `${serverUrl}${path}`;
  const absolute = (url) => new URL(url, serverUrl + '/').href;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function log(...args) {
    console.log('[player]', ...args);
  }

  function renderDebug() {
    if (!debugEnabled) return;
    const el = $('debug');
    el.hidden = false;
    el.textContent = [
      `player ${PLAYER_VERSION}  server ${serverUrl}`,
      `socket ${state.wsConnected ? 'connected' : 'down'}  network ${state.online ? 'online' : 'offline'}  cache ${canCache ? 'on' : 'off'}`,
      `manifest ${state.manifest?.version || '-'}  synced ${state.lastSync ? state.lastSync.toLocaleTimeString() : '-'}`,
      `playing ${state.nowPlaying || '-'}`,
      state.lastError ? `error ${state.lastError}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  function show(panel) {
    $('pairing').hidden = panel !== 'pairing';
    $('idle').hidden = panel !== 'idle';
  }

  // ---------- pairing ----------

  async function pair() {
    stopPlayback();
    show('pairing');
    $('pair-server').textContent = serverUrl;
    for (;;) {
      let request;
      try {
        const res = await fetch(api('/api/player/pairing'), { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        request = await res.json();
        $('pair-code').textContent = request.code;
        $('pair-error').hidden = true;
      } catch (err) {
        $('pair-error').textContent = `Can't reach the server (${err.message}). Retrying…`;
        $('pair-error').hidden = false;
        await sleep(5000);
        continue;
      }

      for (;;) {
        await sleep(PAIR_POLL_MS);
        let status;
        try {
          const res = await fetch(api(`/api/player/pairing/${request.pairingId}`), {
            headers: { 'X-Pairing-Secret': request.secret },
          });
          if (res.status === 404) break; // request vanished; get a fresh code
          status = await res.json();
          $('pair-error').hidden = true;
        } catch (err) {
          $('pair-error').textContent = `Lost connection to the server. Retrying…`;
          $('pair-error').hidden = false;
          continue;
        }
        if (status.status === 'paired') {
          state.token = status.token;
          storage.setItem('sinewave.token', status.token);
          log('paired as screen', status.screenId);
          return;
        }
        if (status.status !== 'pending') break; // expired or claimed elsewhere
      }
    }
  }

  function unpair() {
    log('device token rejected, returning to pairing');
    storage.removeItem('sinewave.token');
    storage.removeItem('sinewave.manifest');
    state.token = null;
    state.manifest = null;
    if (state.ws) {
      state.ws.onclose = null;
      state.ws.close();
    }
    clearTimeout(state.pollTimer);
    if (canCache) caches.delete(MEDIA_CACHE).catch(() => {});
    pair().then(run);
  }

  // ---------- sync ----------

  async function sync() {
    clearTimeout(state.pollTimer);
    try {
      const headers = { Authorization: `Bearer ${state.token}` };
      if (state.manifest) headers['If-None-Match'] = `"${state.manifest.version}"`;
      const res = await fetch(api('/api/player/manifest'), { headers, cache: 'no-store' });
      if (res.status === 401) return unpair();
      state.lastSync = new Date();
      state.lastError = null;
      if (res.status === 304) return;
      if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
      const manifest = await res.json();
      if (manifest.version !== state.manifest?.version) {
        log('new manifest', manifest.version);
        await cacheMedia(manifest);
        applyManifest(manifest);
      }
    } catch (err) {
      state.lastError = err.message;
      log('sync failed', err.message);
    } finally {
      renderDebug();
      if (state.token) {
        state.pollTimer = setTimeout(sync, state.wsConnected ? POLL_CONNECTED_MS : POLL_DISCONNECTED_MS);
      }
    }
  }

  /** Download every file in the manifest into Cache Storage, then drop files no longer used. */
  async function cacheMedia(manifest) {
    if (!canCache) return;
    const cache = await caches.open(MEDIA_CACHE);
    const wanted = new Set(
      (manifest.playlist?.items || []).filter((i) => i.cacheable).map((i) => absolute(i.url)),
    );
    for (const url of wanted) {
      if (await cache.match(url)) continue;
      try {
        // Fetch directly so a partial download never lands in the cache.
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await cache.put(url, res);
        log('cached', url);
      } catch (err) {
        log('could not cache', url, err.message); // it will stream from the network instead
      }
    }
    for (const req of await cache.keys()) {
      if (!wanted.has(req.url)) await cache.delete(req);
    }
  }

  function applyManifest(manifest) {
    const previous = state.manifest;
    state.manifest = manifest;
    storage.setItem('sinewave.manifest', JSON.stringify(manifest));
    const items = manifest.playlist?.items || [];
    const prevItems = previous?.playlist?.items || [];
    const current = prevItems[state.index];
    const currentStillThere = current && items.some((i) => i.id === current.id && i.url === current.url);
    if (!currentStillThere || previous?.playlist?.id !== manifest.playlist?.id) {
      // What's on screen was removed or the playlist was swapped: switch right away.
      startPlayback();
    } else {
      // Otherwise let the current item finish and continue in the new order.
      state.index = items.findIndex((i) => i.id === current.id);
    }
    reportStatus();
  }

  // ---------- socket ----------

  function connect() {
    const wsUrl = api(`/ws/player?token=${encodeURIComponent(state.token)}`).replace(/^http/, 'ws');
    const ws = new WebSocket(wsUrl);
    state.ws = ws;
    ws.onopen = () => {
      state.wsConnected = true;
      state.reconnectDelay = 1000;
      log('socket connected');
      reportStatus();
      sync(); // catch anything missed while disconnected
    };
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'content-changed') sync();
      else if (msg.type === 'reload') location.reload();
      else if (msg.type === 'unpaired') unpair();
    };
    ws.onclose = (event) => {
      state.wsConnected = false;
      renderDebug();
      if (event.code === 4001) return unpair();
      // Back off up to a minute so a server restart doesn't get hammered by every screen.
      const delay = Math.min(state.reconnectDelay, 60_000) * (0.75 + Math.random() * 0.5);
      state.reconnectDelay *= 2;
      log(`socket closed (${event.code}), retrying in ${Math.round(delay / 1000)}s`);
      clearTimeout(state.pollTimer);
      state.pollTimer = setTimeout(sync, POLL_DISCONNECTED_MS);
      setTimeout(() => state.token && connect(), delay);
    };
  }

  function reportStatus() {
    renderDebug();
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'status', nowPlaying: state.nowPlaying, nowPlayingMediaId: state.nowPlayingMediaId, playerVersion: PLAYER_VERSION }));
    }
  }

  // ---------- playback ----------

  function stopPlayback() {
    state.playToken++;
    for (const layer of layers) {
      layer.classList.remove('visible');
      layer.replaceChildren();
    }
  }

  function startPlayback() {
    const token = ++state.playToken;
    state.index = -1;
    playLoop(token);
  }

  async function playLoop(token) {
    while (token === state.playToken) {
      const items = state.manifest?.playlist?.items || [];
      if (!items.length) {
        showIdle();
        return;
      }
      show(null);
      state.index = (state.index + 1) % items.length;
      const item = items[state.index];
      state.nowPlaying = item.name;
      state.nowPlayingMediaId = item.mediaId;
      reportStatus();
      try {
        await playItem(item, token);
      } catch (err) {
        log('could not play', item.name, err.message);
        state.lastError = `${item.name}: ${err.message}`;
        renderDebug();
        await sleep(items.length === 1 ? 5000 : 500); // don't spin on a broken item
      }
    }
  }

  function showIdle() {
    for (const layer of layers) layer.classList.remove('visible');
    state.nowPlaying = null;
    state.nowPlayingMediaId = null;
    $('idle-name').textContent = state.manifest?.screen?.name || '';
    $('idle-message').textContent = state.manifest?.playlist
      ? 'The assigned playlist is empty.'
      : 'No content has been assigned to this screen yet.';
    show('idle');
    reportStatus();
  }

  /** Put an element on the hidden layer, wait until it can render, then cross-fade to it. */
  async function playItem(item, token) {
    const next = layers[1 - state.activeLayer];
    const prev = layers[state.activeLayer];
    next.replaceChildren();
    const src = item.kind === 'web' ? item.url : absolute(item.url);
    let el;
    let ended;

    if (item.kind === 'image') {
      el = new Image();
      el.decoding = 'async';
      el.src = src;
      next.append(el);
      await el.decode();
    } else if (item.kind === 'video') {
      el = document.createElement('video');
      Object.assign(el, { muted: true, playsInline: true, autoplay: false, preload: 'auto', src });
      el.setAttribute('muted', '');
      next.append(el);
      await new Promise((resolve, reject) => {
        el.oncanplay = resolve;
        el.onerror = () => reject(new Error(el.error?.message || 'video failed to load'));
      });
      ended = new Promise((resolve) => {
        el.onended = resolve;
        el.onerror = resolve;
      });
      await el.play();
    } else if (item.kind === 'web') {
      el = document.createElement('iframe');
      el.src = src;
      el.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
      // Send our origin (never the full URL): many embeds (maps, video players) refuse to load without a referrer.
      el.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      next.append(el);
      await Promise.race([new Promise((r) => (el.onload = r)), sleep(8000)]);
    } else {
      throw new Error(`unknown kind ${item.kind}`);
    }

    if (token !== state.playToken) return;
    next.classList.add('visible');
    prev.classList.remove('visible');
    state.activeLayer = 1 - state.activeLayer;
    // Clear the old layer once the fade is done so a finished video stops decoding.
    setTimeout(() => {
      if (!prev.classList.contains('visible')) prev.replaceChildren();
    }, 700);

    const waits = [];
    if (item.durationSeconds) waits.push(sleep(item.durationSeconds * 1000));
    if (ended) waits.push(ended);
    if (!waits.length) waits.push(sleep(10_000));
    await Promise.race(waits);
  }

  // ---------- boot ----------

  async function run() {
    // Start straight away from the last manifest we saw, so a reboot with no network still shows content.
    const saved = storage.getItem('sinewave.manifest');
    if (saved && !state.manifest) {
      try {
        state.manifest = JSON.parse(saved);
        startPlayback();
      } catch {
        storage.removeItem('sinewave.manifest');
      }
    }
    connect();
    sync();
  }

  async function boot() {
    if ('serviceWorker' in navigator && window.isSecureContext && !cfg.disableServiceWorker) {
      navigator.serviceWorker.register('sw.js').catch((err) => log('service worker failed', err.message));
    } else {
      log('offline caching unavailable: needs HTTPS or localhost');
    }
    window.addEventListener('online', () => {
      state.online = true;
      sync();
    });
    window.addEventListener('offline', () => {
      state.online = false;
      renderDebug();
    });
    renderDebug();
    if (!state.token) await pair();
    run();
  }

  // Exposed for debugging and for wrappers.
  window.sinewavePlayer = { state, sync, unpair, version: PLAYER_VERSION };
  boot();
})();
