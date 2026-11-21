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

  const PLAYER_VERSION = '0.3.1';
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
    onScreen: null, // { key, el, news } for the item currently showing
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
    const wanted = new Set();
    for (const item of manifest.playlist?.items || []) {
      if (item.cacheable) wanted.add(absolute(item.url));
      // Extra files an item needs, such as the photos of a news item's stories.
      for (const asset of item.assets || []) wanted.add(absolute(asset));
    }
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
    // A news item whose look changed counts as changed; new headlines just wait for the next loop.
    // An edited slide is shown again straight away.
    const sameLook = (a, b) =>
      JSON.stringify(a.news?.options) === JSON.stringify(b.news?.options) && JSON.stringify(a.slide) === JSON.stringify(b.slide);
    const currentStillThere = current && items.some((i) => i.id === current.id && i.url === current.url && sameLook(i, current));
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
    clearOnScreen();
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
    clearOnScreen();
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

  /**
   * What makes an item look different on screen. When the next item has the same key as the one
   * already showing (a playlist with a single item), it stays up instead of being drawn again.
   */
  const itemKey = (item) => JSON.stringify([item.id, item.url, item.checksum, item.news?.options ?? null]);

  /** Forget the item on screen, stopping any timers it runs. */
  function clearOnScreen() {
    state.onScreen?.news?.stop();
    state.onScreen = null;
  }

  /** Wait for the item's time on screen: its duration, the end of a video, or 10s by default. */
  function waitOnScreen(item, ended) {
    const waits = [];
    if (item.durationSeconds) waits.push(sleep(item.durationSeconds * 1000));
    if (ended) waits.push(ended);
    if (!waits.length) waits.push(sleep(10_000));
    return Promise.race(waits);
  }

  /**
   * Keep the item already on screen for another turn without reloading it, so a playlist with one
   * item never blinks. Images, slides and web pages simply stay; a video plays again from the
   * start; a news item keeps cycling its stories. Returns false if it can't be kept.
   */
  async function holdItem(item) {
    const current = state.onScreen;
    const layer = layers[state.activeLayer];
    if (!current || current.key !== itemKey(item) || !layer.classList.contains('visible') || !layer.contains(current.el)) {
      return false;
    }
    let ended;
    if (item.kind === 'video') {
      const video = current.el;
      ended = new Promise((resolve) => {
        video.onended = resolve;
        video.onerror = resolve;
      });
      video.currentTime = 0;
      await video.play();
    }
    await waitOnScreen(item, ended);
    return true;
  }

  /** Put an element on the hidden layer, wait until it can render, then cross-fade to it. */
  async function playItem(item, token) {
    if (await holdItem(item)) return;
    const next = layers[1 - state.activeLayer];
    const prev = layers[state.activeLayer];
    next.replaceChildren();
    const src = item.kind === 'web' ? item.url : item.url ? absolute(item.url) : null;
    let el;
    let ended;
    let news;

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
    } else if (item.kind === 'news') {
      news = newsSlide(item);
      el = news.el;
      next.append(el);
      await news.ready;
    } else if (item.kind === 'slide') {
      el = slideElement(item);
      next.append(el);
      // Wait for any pictures (from the offline cache when there is one), but never for long.
      await Promise.all([...el.querySelectorAll('img')].map((img) => loadImage(img.src, 4000)));
    } else {
      throw new Error(`unknown kind ${item.kind}`);
    }

    if (token !== state.playToken) return news?.stop();
    clearOnScreen();
    state.onScreen = { key: itemKey(item), el, news };
    next.classList.add('visible');
    prev.classList.remove('visible');
    state.activeLayer = 1 - state.activeLayer;
    // Clear the old layer once the fade is done so a finished video stops decoding.
    setTimeout(() => {
      if (!prev.classList.contains('visible')) prev.replaceChildren();
    }, 700);

    news?.start();
    // News keeps running after this: it stops when something else replaces it (see clearOnScreen).
    await waitOnScreen(item, ended);
  }

  // ---------- slides ----------

  /** Draw a slide made in the dashboard. slides.js builds it from the template and text. */
  function slideElement(item) {
    const slide = { ...item.slide };
    if (slide.imageUrl) slide.imageUrl = absolute(slide.imageUrl);
    if (slide.backgroundUrl) slide.backgroundUrl = absolute(slide.backgroundUrl);
    const wrap = document.createElement('div');
    wrap.innerHTML = window.SinewaveSlides.toHTML(slide); // all text is escaped by toHTML
    return wrap.firstElementChild;
  }

  // ---------- news ----------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text; // feed text is never treated as HTML
    return node;
  }

  function ago(iso) {
    if (!iso) return '';
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  const clockText = () => new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  /** Load an image, resolving either way within `ms` so a slow or missing picture never stalls the loop. */
  function loadImage(src, ms = 4000) {
    return new Promise((resolve) => {
      if (!src) return resolve(null);
      const img = new Image();
      img.decoding = 'async';
      const done = (ok) => resolve(ok ? img : null);
      img.onload = () => img.decode().then(() => done(true), () => done(true));
      img.onerror = () => done(false);
      setTimeout(() => done(img.complete && img.naturalWidth > 0), ms);
      img.src = src;
    });
  }

  /**
   * Build a news slide that cycles through the item's stories.
   * Layouts: "feature" (full-screen photo), "split" (photo beside the text), "headlines" (a list).
   */
  function newsSlide(item) {
    const news = item.news || { stories: [], options: {} };
    const o = news.options || {};
    const stories = news.stories || [];
    const layout = ['feature', 'split', 'headlines'].includes(o.layout) ? o.layout : 'feature';
    const root = el('div', `news layout-${layout} theme-${o.theme === 'light' ? 'light' : 'dark'}`);
    if (o.accent) root.style.setProperty('--accent', o.accent);
    const perStoryMs = Math.max(3, o.secondsPerStory || 10) * 1000;

    const media = el('div', 'news-media');
    const head = el('header', 'news-head');
    const badge = el('span', 'news-badge', 'News');
    const source = el('span', 'news-source', news.title || item.name);
    const clock = el('span', 'news-clock', clockText());
    head.append(badge, source, clock);
    const progress = el('div', 'news-progress');
    const bars = stories.map(() => progress.appendChild(el('span', 'news-bar')).appendChild(el('i')).parentNode);
    const body = el('div', 'news-body');
    const list = layout === 'headlines' ? el('ol', 'news-list') : null;
    root.append(media, head, body);
    if (stories.length > 1) root.append(progress);
    if (list) body.append(list);

    let index = 0;
    let timer = null;
    let clockTimer = null;
    let stopped = false;

    function setMedia(img) {
      // Cross-fade photos: the new one fades in over the old, which is then removed.
      if (!img) {
        media.classList.add('no-image');
        for (const old of media.querySelectorAll('img')) old.classList.add('leaving');
        setTimeout(() => media.querySelectorAll('img.leaving').forEach((n) => n.remove()), 900);
        return;
      }
      media.classList.remove('no-image');
      img.className = 'entering';
      for (const old of media.querySelectorAll('img')) old.classList.add('leaving');
      media.append(img);
      requestAnimationFrame(() => requestAnimationFrame(() => img.classList.remove('entering')));
      setTimeout(() => media.querySelectorAll('img.leaving').forEach((n) => n.remove()), 900);
    }

    function storyBlock(story, i) {
      const block = el('article', 'news-story');
      const meta = el('div', 'news-meta');
      if (o.showTime !== false && story.publishedAt) meta.append(el('span', 'news-time', ago(story.publishedAt)));
      if (stories.length > 1) meta.append(el('span', 'news-count', `${i + 1} / ${stories.length}`));
      block.append(meta, el('h1', 'news-title', story.title));
      if (story.summary) block.append(el('p', 'news-summary', story.summary));
      return block;
    }

    function renderList(i) {
      // Show a window of headlines around the current one; the current story is expanded.
      const visible = Math.min(stories.length, 6);
      const start = Math.min(Math.max(0, i - 1), stories.length - visible);
      list.replaceChildren(
        ...stories.slice(start, start + visible).map((story, k) => {
          const n = start + k;
          const li = el('li', n === i ? 'current' : '');
          li.append(el('span', 'news-num', String(n + 1)));
          const text = el('div', 'news-li-text');
          text.append(el('div', 'news-li-title', story.title));
          if (n === i) {
            const extra = [];
            if (o.showTime !== false && story.publishedAt) extra.push(ago(story.publishedAt));
            if (story.summary) text.append(el('div', 'news-li-summary', story.summary));
            if (extra.length) text.append(el('div', 'news-li-time', extra.join(' · ')));
          }
          li.append(text);
          return li;
        }),
      );
    }

    async function show(i, first = false) {
      const story = stories[i];
      const img = await loadImage(story.image ? absolute(story.image) : null);
      if (stopped && !first) return;
      setMedia(img);
      if (list) renderList(i);
      else {
        const block = storyBlock(story, i);
        block.classList.add('entering');
        for (const old of body.querySelectorAll('.news-story')) {
          old.classList.add('leaving');
          setTimeout(() => old.remove(), 700);
        }
        body.append(block);
        requestAnimationFrame(() => requestAnimationFrame(() => block.classList.remove('entering')));
      }
      bars.forEach((b, k) => {
        b.classList.toggle('done', k < i);
        b.classList.toggle('active', k === i);
      });
    }

    if (!stories.length) {
      root.classList.add('news-empty');
      body.append(el('div', 'news-waiting', 'Headlines will appear here once the feed has loaded.'));
    }

    const ready = stories.length ? show(0, true) : Promise.resolve();

    return {
      el: root,
      ready,
      start() {
        // Restart the first bar's animation now that the slide is actually visible.
        bars[0]?.classList.remove('active');
        void root.offsetWidth;
        bars[0]?.classList.add('active');
        root.style.setProperty('--story-ms', `${perStoryMs}ms`);
        clockTimer = setInterval(() => (clock.textContent = clockText()), 10_000);
        if (stories.length < 2) return;
        timer = setInterval(() => {
          if (stopped || !root.isConnected) return this.stop();
          index = (index + 1) % stories.length;
          show(index);
        }, perStoryMs);
      },
      stop() {
        stopped = true;
        clearInterval(timer);
        clearInterval(clockTimer);
      },
    };
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
