/*
 * End-to-end test for Sinewave.
 *
 * Needs a running server (docker compose up -d) and Playwright's Chromium.
 *   cd e2e && npm install && npx playwright install chromium && npm test
 *
 * Env: BASE_URL (default http://localhost:8080), ADMIN_PASSWORD (default admin).
 * ffmpeg on PATH adds a video to the test; without it the video steps are skipped.
 *
 * It drives the dashboard like a person would, pairs a separate headless "screen",
 * pushes a playlist, checks live updates, then cuts the network and checks the
 * screen keeps playing from its offline cache. Screenshots land in e2e/screenshots/.
 */
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const BASE = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const OUT = path.join(__dirname, 'screenshots');
const FIX = path.join(__dirname, 'test-results', 'fixtures');
const RUN = Date.now().toString(36).slice(-4).toUpperCase();

let step = 0;
const log = (msg) => console.log(`${String(++step).padStart(2, '0')}. ${msg}`);
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

async function makeFixtures(browser) {
  fs.mkdirSync(FIX, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const slides = [
    ['welcome', 'Welcome', 'Sinewave test slide', '#3b6cf6', '#1b2f7a'],
    ['menu', "Today's menu", 'Soup · Salad · Coffee', '#e0624a', '#7a2414'],
    ['notice', 'Notice', 'Fire drill at 3 PM', '#1f9d55', '#0d4a28'],
  ];
  const files = [];
  for (const [name, title, sub, a, b] of slides) {
    await page.setContent(`<body style="margin:0;width:1920px;height:1080px;display:flex;flex-direction:column;
      align-items:center;justify-content:center;background:linear-gradient(135deg,${a},${b});color:#fff;
      font-family:system-ui,sans-serif"><div style="font-size:160px;font-weight:800">${title}</div>
      <div style="font-size:64px;opacity:.85;margin-top:24px">${sub}</div></body>`);
    const file = path.join(FIX, `${name}.png`);
    await page.screenshot({ path: file });
    files.push(file);
  }
  await page.close();
  let video = null;
  try {
    video = path.join(FIX, 'countdown.webm');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=4',
      '-c:v', 'libvpx', '-b:v', '1M', video]);
  } catch {
    video = null;
  }
  return { images: files, video };
}

async function waitFor(fn, { timeout = 15000, interval = 250, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${what} (last: ${last})`);
}

/** Name of the item currently visible on the player. */
const playing = (player) => player.evaluate(() => window.sinewavePlayer?.state.nowPlaying);
const visibleKind = (player) =>
  player.evaluate(() => {
    const el = document.querySelector('.layer.visible > *');
    return el ? el.tagName.toLowerCase() : null;
  });

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const fixtures = await makeFixtures(browser);
  const failures = [];

  const dash = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const playerCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const player = await playerCtx.newPage();
  player.on('console', (m) => m.text().startsWith('[player]') && process.env.VERBOSE && console.log('   ', m.text()));
  dash.on('pageerror', (e) => failures.push(`dashboard error: ${e.message}`));
  player.on('pageerror', (e) => failures.push(`player error: ${e.message}`));

  try {
    // --- Dashboard: sign in
    log('Sign in to the dashboard');
    await dash.goto(BASE);
    await dash.fill('input[name=password]', PASSWORD);
    await dash.click('button[type=submit]');
    await dash.waitForSelector('h1:has-text("Screens")');

    // --- Upload media
    log(`Upload ${fixtures.images.length} images${fixtures.video ? ' and a video' : ''}`);
    await dash.click('a[data-nav=media]');
    const uploads = [...fixtures.images, ...(fixtures.video ? [fixtures.video] : [])];
    await dash.setInputFiles('#file', uploads);
    await dash.waitForFunction((n) => document.querySelectorAll('.tile').length >= n, uploads.length);
    await shot(dash, '01-dashboard-media');

    // --- Build a playlist
    const plName = `Lobby loop ${RUN}`;
    log(`Create playlist "${plName}"`);
    await dash.click('a[data-nav=playlists]');
    await dash.click('#new');
    await dash.fill('dialog input[name=name]', plName);
    await dash.click('dialog button.primary');
    await dash.waitForSelector('#items');
    const add = async (name) => dash.click(`.lib-item:has(.name[title="${name}"]) button`);
    await add('welcome');
    await add('menu');
    if (fixtures.video) await add('countdown');
    // Short durations keep the test fast.
    const durs = dash.locator('[data-dur]');
    for (let i = 0; i < (await durs.count()); i++) await durs.nth(i).fill('3');
    if (fixtures.video) await durs.nth(2).fill(''); // video: play to the end
    await dash.click('#save');
    await dash.waitForSelector('#save:has-text("Saved")');
    await shot(dash, '02-dashboard-playlist-editor');

    // --- Player: show a pairing code
    log('Open the player and read its pairing code');
    await player.goto(`${BASE}/player/?debug`);
    const code = await waitFor(
      async () => {
        const t = (await player.textContent('#pair-code')).trim();
        return /^[A-Z0-9]{6}$/.test(t) && t;
      },
      { what: 'pairing code' },
    );
    console.log(`    code: ${code}`);
    await shot(player, '03-player-pairing-code');

    // --- Pair it from the dashboard and assign the playlist
    log('Pair the screen from the dashboard with the playlist assigned');
    await dash.click('a[data-nav=screens]');
    await dash.click('#pair');
    await dash.fill('dialog input[name=code]', code.toLowerCase()); // case shouldn't matter
    await dash.fill('dialog input[name=name]', `Reception ${RUN}`);
    await dash.selectOption('dialog select[name=playlistId]', { label: plName });
    await dash.click('dialog button.primary');
    await dash.waitForSelector(`td:has-text("Reception ${RUN}")`);

    log('Player picks up its token and starts playing');
    await waitFor(async () => (await playing(player)) === 'welcome', { what: 'welcome slide', timeout: 20000 });
    await player.waitForTimeout(800); // let the fade finish
    await shot(player, '04-player-playing-welcome');
    await waitFor(async () => (await playing(player)) === 'menu', { what: 'menu slide' });
    await player.waitForTimeout(800);
    await shot(player, '05-player-playing-menu');

    if (fixtures.video) {
      log('Video plays to the end, then the loop wraps');
      await waitFor(async () => (await playing(player)) === 'countdown', { what: 'video' });
      await waitFor(
        () => player.evaluate(() => {
          const v = document.querySelector('.layer.visible video');
          return v && v.currentTime > 1 && !v.paused;
        }),
        { what: 'video progressing' },
      );
      await shot(player, '06-player-playing-video');
      await waitFor(async () => (await playing(player)) === 'welcome', { what: 'loop back to start', timeout: 15000 });
    }

    log('Dashboard shows the screen online with a live connection and what it is playing');
    await dash.reload();
    const row = dash.locator(`tr:has-text("Reception ${RUN}")`);
    await waitFor(async () => (await row.textContent()).includes('Live connection'), { what: 'online status' });
    await shot(dash, '07-dashboard-screens-online');

    // --- Live push: change the playlist and see it on screen without a reload
    log('Edit the playlist and check the screen updates over the WebSocket');
    const versionBefore = await player.evaluate(() => window.sinewavePlayer.state.manifest.version);
    const navCount = await player.evaluate(() => performance.getEntriesByType('navigation').length);
    await dash.click('a[data-nav=playlists]');
    await dash.click(`a:has-text("${plName}")`);
    await dash.waitForSelector('#items .item');
    // Replace the whole loop with just the "notice" slide.
    while ((await dash.locator('#items [data-remove]').count()) > 0) await dash.locator('#items [data-remove]').first().click();
    await add('notice');
    const pushedAt = Date.now();
    await dash.click('#save');
    await waitFor(async () => (await playing(player)) === 'notice', { what: 'pushed update', timeout: 5000 });
    const pushMs = Date.now() - pushedAt;
    console.log(`    screen switched ${pushMs} ms after save`);
    assert.notEqual(await player.evaluate(() => window.sinewavePlayer.state.manifest.version), versionBefore);
    assert.equal(await player.evaluate(() => performance.getEntriesByType('navigation').length), navCount);
    await player.waitForTimeout(800);
    await shot(player, '08-player-after-live-push');

    // Put the longer loop back for the offline test.
    while ((await dash.locator('#items [data-remove]').count()) > 0) await dash.locator('#items [data-remove]').first().click();
    await add('welcome');
    await add('menu');
    if (fixtures.video) await add('countdown');
    for (let i = 0; i < 2; i++) await dash.locator('[data-dur]').nth(i).fill('3');
    await dash.click('#save');
    await waitFor(async () => ['welcome', 'menu'].includes(await playing(player)), { what: 'restored loop' });

    // --- Offline: everything cached, then cut the network and restart the player
    log('Media is in the offline cache and the service worker controls the page');
    const cached = await waitFor(
      () => player.evaluate(async () => {
        const keys = await (await caches.open('sinewave-media-v1')).keys();
        return keys.length >= (window.sinewavePlayer.state.manifest.playlist.items.length) && keys.length;
      }),
      { what: 'media cached' },
    );
    console.log(`    ${cached} files cached`);
    if (!(await player.evaluate(() => Boolean(navigator.serviceWorker.controller)))) {
      await player.reload(); // first visit isn't controlled until the worker claims it
    }
    await waitFor(() => player.evaluate(() => Boolean(navigator.serviceWorker.controller)), { what: 'service worker' });

    log('Go offline and reload the player: it should boot and keep playing from cache');
    await playerCtx.setOffline(true);
    await player.reload();
    await waitFor(async () => ['welcome', 'menu', 'countdown'].includes(await playing(player)), { what: 'offline playback' });
    await waitFor(async () => (await visibleKind(player)) !== null, { what: 'visible media' });
    const seen = new Set();
    const end = Date.now() + (fixtures.video ? 14000 : 8000);
    while (Date.now() < end) {
      const n = await playing(player);
      if (n && !seen.has(n)) {
        seen.add(n);
        await player.waitForTimeout(800);
        if (n === 'menu') await shot(player, '09-player-offline-playing');
        if (n === 'countdown') {
          const ok = await player.evaluate(() => {
            const v = document.querySelector('.layer.visible video');
            return Boolean(v && !v.error);
          });
          assert.ok(ok, 'video plays offline');
        }
      }
      await player.waitForTimeout(200);
    }
    console.log(`    played offline: ${[...seen].join(', ')}`);
    assert.ok(seen.has('welcome') && seen.has('menu'), 'both slides played while offline');
    if (fixtures.video) assert.ok(seen.has('countdown'), 'video played while offline');

    log('Dashboard notices the screen went offline');
    await dash.click('a[data-nav=screens]');
    await waitFor(async () => !(await row.textContent()).includes('Live connection'), { what: 'socket drop', timeout: 10000 });

    log('Back online: the player reconnects by itself');
    await playerCtx.setOffline(false);
    await waitFor(() => player.evaluate(() => window.sinewavePlayer.state.wsConnected), { what: 'reconnect', timeout: 70000 });
    await waitFor(async () => (await row.textContent()).includes('Live connection'), { what: 'online again', timeout: 10000 });

    log('Remote reload command restarts the player page');
    const t0 = await player.evaluate(() => performance.timeOrigin);
    await row.locator('[data-act=reload]').click();
    await waitFor(async () => (await player.evaluate(() => performance.timeOrigin).catch(() => t0)) !== t0, { what: 'reload' });
    await waitFor(async () => (await playing(player)) !== null, { what: 'playing after reload' });

    log('Removing the screen sends the player back to pairing');
    await row.locator('[data-act=delete]').click();
    await dash.click('dialog button.primary');
    await waitFor(async () => /^[A-Z0-9]{6}$/.test((await player.textContent('#pair-code')).trim()) && (await player.isVisible('#pairing')), {
      what: 'back to pairing',
    });
    assert.equal(await player.evaluate(() => localStorage.getItem('sinewave.token')), null);

    log('API rejects requests without a session or device token');
    const anon = await fetch(`${BASE}/api/screens`);
    assert.equal(anon.status, 401);
    const badToken = await fetch(`${BASE}/api/player/manifest`, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(badToken.status, 401);
  } catch (err) {
    failures.push(err.stack || String(err));
    await shot(player, 'zz-failure-player').catch(() => {});
    await shot(dash, 'zz-failure-dashboard').catch(() => {});
  }

  await browser.close();
  if (failures.length) {
    console.error('\nFAILED\n' + failures.join('\n'));
    process.exit(1);
  }
  console.log(`\nAll steps passed. Screenshots in ${OUT}`);
})();
