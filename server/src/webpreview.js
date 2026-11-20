/*
 * Thumbnails for web page media, shown on the dashboard's media cards.
 *
 * Many sites refuse to load inside an iframe, so the dashboard can't just show the page live.
 * Instead the server captures a small picture of it once, when it's added:
 *   1. A real screenshot, taken with headless Chromium when it's installed (it is in the Docker image).
 *   2. Otherwise, the picture the page itself offers for link previews (og:image / twitter:image),
 *      or failing that its app icon.
 * The picture is saved as DATA_DIR/media/<id>/preview.<ext> and served from /media like uploads.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from './config.js';
import { query } from './db.js';

const FETCH_TIMEOUT_MS = 15_000;
const SCREENSHOT_TIMEOUT_MS = 45_000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const USER_AGENT = 'Sinewave/0.1 (digital signage; +https://github.com/elliottmarter/Sinewave)';
const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif' };

const CHROMIUM_CANDIDATES = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];

/** The Chromium binary to take screenshots with, or null. CHROMIUM_PATH overrides; WEB_PREVIEW_SCREENSHOTS=false turns it off. */
export function findChromium() {
  if (process.env.WEB_PREVIEW_SCREENSHOTS === 'false') return null;
  const candidates = process.env.CHROMIUM_PATH ? [process.env.CHROMIUM_PATH] : CHROMIUM_CANDIDATES;
  return candidates.find((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) || null;
}

// ---------- screenshot ----------

/**
 * Load the page at 1280x720 (a typical screen, scaled by half so the file stays small) and save
 * a JPEG. Chromium's virtual time budget lets the page settle before the picture is taken.
 */
async function screenshot(chromium, url, outFile) {
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'sinewave-chromium-'));
  try {
    await new Promise((resolve, reject) => {
      execFile(
        chromium,
        [
          '--headless',
          '--no-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--disable-extensions',
          '--no-first-run',
          '--no-default-browser-check',
          '--hide-scrollbars',
          '--mute-audio',
          '--autoplay-policy=user-gesture-required',
          `--user-data-dir=${profile}`,
          '--window-size=1280,720',
          '--force-device-scale-factor=0.5',
          '--virtual-time-budget=8000',
          `--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36 ${USER_AGENT}`,
          `--screenshot=${outFile}`,
          url,
        ],
        { timeout: SCREENSHOT_TIMEOUT_MS, killSignal: 'SIGKILL', env: { ...process.env, HOME: profile } },
        (err, _stdout, stderr) => {
          if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) return resolve();
          const reason = err?.killed ? 'the page took too long to load' : err?.message || String(stderr).trim().split('\n').at(-1);
          reject(new Error(reason || 'no screenshot was produced'));
        },
      );
    });
  } finally {
    await fsp.rm(profile, { recursive: true, force: true });
  }
}

// ---------- share image fallback ----------

async function readLimited(res, limit) {
  const len = Number(res.headers.get('content-length'));
  if (len > limit) throw new Error('too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > limit) throw new Error('too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4]).trim() : null;
}

const decodeEntities = (s) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/**
 * The best picture a page offers for previews, as an absolute URL, or null. Prefers the share
 * image (og:image, twitter:image), then the largest app icon.
 */
export function findShareImage(html, pageUrl) {
  const head = html.slice(0, 512 * 1024);
  const metas = head.match(/<meta\b[^>]*>/gi) || [];
  const links = head.match(/<link\b[^>]*>/gi) || [];
  const meta = (keys) => {
    for (const key of keys) {
      for (const tag of metas) {
        const k = (attr(tag, 'property') || attr(tag, 'name') || '').toLowerCase();
        const v = attr(tag, 'content');
        if (k === key && v) return v;
      }
    }
    return null;
  };
  let found = meta(['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']);
  if (!found) {
    const icons = links
      .map((tag) => ({ rel: (attr(tag, 'rel') || '').toLowerCase(), href: attr(tag, 'href'), sizes: attr(tag, 'sizes') || '' }))
      .filter((l) => l.href && (l.rel === 'image_src' || l.rel.includes('apple-touch-icon') || (l.rel.includes('icon') && /\d/.test(l.sizes))))
      .map((l) => ({ ...l, size: l.rel === 'image_src' ? 1e6 : Number(/(\d+)x\d+/.exec(l.sizes)?.[1] || (l.rel.includes('apple') ? 180 : 0)) }))
      .sort((a, b) => b.size - a.size);
    // A 32px favicon blown up to card size looks worse than the plain placeholder.
    if (icons[0]?.size >= 96) found = icons[0].href;
  }
  if (!found) return null;
  try {
    const base = /<base\b[^>]*>/i.exec(head);
    const baseHref = base && attr(base[0], 'href');
    const u = new URL(decodeEntities(found), baseHref ? new URL(baseHref, pageUrl) : pageUrl);
    return ['http:', 'https:'].includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

function friendlyError(err) {
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'the page took too long to respond';
  const code = err.cause?.code || err.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return "couldn't find that site";
  if (code === 'ECONNREFUSED') return 'the site refused the connection';
  if (/certificate|SSL|TLS/i.test(err.cause?.message || err.message)) return "the site's security certificate isn't valid";
  return err.cause?.message || err.message || 'the page could not be loaded';
}

/**
 * Load the page's HTML. This also checks the site is reachable before Chromium is started,
 * since Chromium would happily screenshot its own "This site can't be reached" page.
 */
async function fetchPage(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
  } catch (err) {
    throw new Error(friendlyError(err));
  }
  let html = '';
  try {
    if ((res.headers.get('content-type') || '').includes('html')) html = (await readLimited(res, MAX_HTML_BYTES)).toString('utf8');
    else await res.body?.cancel();
  } catch {
    // A huge or broken body still means the site is up; just no share image from it.
  }
  return { status: res.status, url: res.url || url, html };
}

async function shareImage(page, dir) {
  if (page.status >= 400) throw new Error(`the site answered HTTP ${page.status}`);
  const imageUrl = findShareImage(page.html, page.url);
  if (!imageUrl) throw new Error("the page doesn't offer a preview image");
  const res = await fetch(imageUrl, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'image/avif,image/webp,image/jpeg,image/png,image/*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`its preview image answered HTTP ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = IMAGE_EXT[type];
  if (!ext) throw new Error(`its preview image isn't a picture (${type || 'unknown type'})`);
  const data = await readLimited(res, MAX_IMAGE_BYTES);
  const file = `preview${ext}`;
  await fsp.writeFile(path.join(dir, `.tmp-${file}`), data);
  return file;
}

// ---------- queue ----------

const pending = new Set();
const queue = [];
let running = false;

/** True while a web item's preview is waiting to be captured, so the dashboard can say so. */
export const isPreviewPending = (id) => pending.has(id);

/** Capture (or re-capture) a web item's preview in the background. One at a time, so a big import can't swamp the server. */
export function queuePreview(id) {
  if (pending.has(id)) return;
  pending.add(id);
  queue.push(id);
  if (!running) drain();
}

async function drain() {
  running = true;
  while (queue.length) {
    const id = queue.shift();
    try {
      await capture(id);
    } catch (err) {
      console.error(`Web preview for ${id} failed unexpectedly:`, err);
    } finally {
      pending.delete(id);
    }
  }
  running = false;
}

async function capture(id) {
  const { rows } = await query(`SELECT id, url, preview FROM media WHERE id = $1 AND kind = 'web'`, [id]);
  if (!rows.length) return;
  const { url } = rows[0];
  const dir = path.join(config.mediaDir, id);
  await fsp.mkdir(dir, { recursive: true });

  let file = null;
  const errors = [];
  let page = null;
  try {
    page = await fetchPage(url);
  } catch (err) {
    errors.push(err.message);
  }
  const chromium = page && findChromium();
  if (chromium) {
    try {
      await screenshot(chromium, url, path.join(dir, '.tmp-preview.jpg'));
      file = 'preview.jpg';
    } catch (err) {
      errors.push(`screenshot: ${err.message}`);
    }
  }
  if (page && !file) {
    try {
      file = await shareImage(page, dir);
    } catch (err) {
      errors.push(err.message);
    }
  }

  // The item may have been deleted while we worked.
  const { rows: still } = await query(`SELECT preview FROM media WHERE id = $1`, [id]);
  if (!still.length) {
    await fsp.rm(dir, { recursive: true, force: true });
    return;
  }
  if (!file) {
    console.warn(`No preview for ${url}: ${errors.join('; ')}`);
    await query('UPDATE media SET preview_error = $2 WHERE id = $1', [id, errors.at(-1) || 'unknown error']);
    return;
  }
  await fsp.rename(path.join(dir, `.tmp-${file}`), path.join(dir, file));
  // Remove an older preview saved under a different extension.
  const old = still[0].preview;
  if (old && old !== file) await fsp.rm(path.join(dir, old), { force: true });
  await query('UPDATE media SET preview = $2, preview_at = now(), preview_error = NULL WHERE id = $1', [id, file]);
}

/**
 * On start, capture previews for web items without one: ones added before this feature, and ones
 * that failed last time (the network may not have been up yet, e.g. right after a power cut).
 */
export async function backfillPreviews() {
  const { rows } = await query(`SELECT id FROM media WHERE kind = 'web' AND preview IS NULL ORDER BY created_at`);
  for (const r of rows) queuePreview(r.id);
}

/** The /media URL of a web item's preview, with its capture time so a refreshed picture isn't served from cache. */
export function previewUrl(media) {
  if (!media.preview) return null;
  return `/media/${media.id}/${encodeURIComponent(media.preview)}?v=${encodeURIComponent(media.preview_at || '')}`;
}
