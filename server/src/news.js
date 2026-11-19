/*
 * News widgets: read RSS and Atom feeds on the server, keep the last good copy in SQLite,
 * and download story images into the media folder so screens can cache them offline.
 *
 * Fetching here rather than in the player avoids CORS (most feeds don't send it) and means
 * one request per feed, however many screens show it.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { config } from './config.js';
import { query } from './db.js';
import { HttpError, sha256 } from './util.js';

/** Feeds offered in the "Add news" dialog. Any other RSS or Atom URL works too. */
export const POPULAR_FEEDS = [
  {
    group: 'UK news',
    feeds: [
      { name: 'BBC News: Top stories', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
      { name: 'BBC News: UK', url: 'https://feeds.bbci.co.uk/news/uk/rss.xml' },
      { name: 'Sky News', url: 'https://feeds.skynews.com/feeds/rss/home.xml' },
      { name: 'Sky News: UK', url: 'https://feeds.skynews.com/feeds/rss/uk.xml' },
      { name: 'The Guardian: UK', url: 'https://www.theguardian.com/uk-news/rss' },
      { name: 'The Independent: UK', url: 'https://www.independent.co.uk/news/uk/rss' },
    ],
  },
  {
    group: 'World news',
    feeds: [
      { name: 'BBC News: World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
      { name: 'Sky News: World', url: 'https://feeds.skynews.com/feeds/rss/world.xml' },
      { name: 'The Guardian: World', url: 'https://www.theguardian.com/world/rss' },
      { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
      { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml' },
    ],
  },
  {
    group: 'Business',
    feeds: [
      { name: 'BBC News: Business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
      { name: 'Sky News: Business', url: 'https://feeds.skynews.com/feeds/rss/business.xml' },
      { name: 'The Guardian: Business', url: 'https://www.theguardian.com/uk/business/rss' },
    ],
  },
  {
    group: 'Sport',
    feeds: [
      { name: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/rss.xml' },
      { name: 'BBC Sport: Football', url: 'https://feeds.bbci.co.uk/sport/football/rss.xml' },
      { name: 'Sky Sports News', url: 'https://www.skysports.com/rss/12040' },
      { name: 'The Guardian: Sport', url: 'https://www.theguardian.com/uk/sport/rss' },
    ],
  },
  {
    group: 'Technology and science',
    feeds: [
      { name: 'BBC News: Technology', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml' },
      { name: 'BBC News: Science', url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml' },
      { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
      { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
      { name: 'TechCrunch', url: 'https://techcrunch.com/feed/' },
      { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
      { name: 'NASA', url: 'https://www.nasa.gov/feed/' },
    ],
  },
  {
    group: 'Entertainment',
    feeds: [
      { name: 'BBC News: Entertainment', url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml' },
      { name: 'The Guardian: Culture', url: 'https://www.theguardian.com/uk/culture/rss' },
    ],
  },
];

export const LAYOUTS = ['feature', 'split', 'headlines'];
export const THEMES = ['dark', 'light'];

export const DEFAULT_NEWS_OPTIONS = {
  layout: 'feature', // feature: full-screen photo; split: photo beside text; headlines: a list
  theme: 'dark',
  accent: '#e5484d',
  maxStories: 8,
  secondsPerStory: 10,
  showImages: true,
  showSummary: true,
  showTime: true,
  // Shown in the slide's header. Blank means use the feed's own title.
  label: '',
};

/** Keep only known settings, clamped to sensible ranges. */
export function normalizeNewsOptions(input = {}, base = DEFAULT_NEWS_OPTIONS) {
  const o = { ...base };
  const int = (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  const bool = (v, fallback) => (v === undefined ? fallback : v === true || v === 'true' || v === 'on' || v === 1 || v === '1');
  if (LAYOUTS.includes(input.layout)) o.layout = input.layout;
  if (THEMES.includes(input.theme)) o.theme = input.theme;
  if (typeof input.accent === 'string' && /^#[0-9a-f]{6}$/i.test(input.accent)) o.accent = input.accent.toLowerCase();
  if (input.maxStories !== undefined) o.maxStories = int(input.maxStories, 1, 20, o.maxStories);
  if (input.secondsPerStory !== undefined) o.secondsPerStory = int(input.secondsPerStory, 3, 120, o.secondsPerStory);
  o.showImages = bool(input.showImages, o.showImages);
  o.showSummary = bool(input.showSummary, o.showSummary);
  o.showTime = bool(input.showTime, o.showTime);
  if (input.label !== undefined) o.label = String(input.label ?? '').trim().slice(0, 80);
  return o;
}

export function parseFeedUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new HttpError(400, 'Enter the full feed URL, starting with http:// or https://');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'Only http and https feeds are supported');
  url.hash = '';
  return url.toString();
}

// ---------- parsing ----------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  // Feed text is shown with textContent, never as HTML; entities still need decoding.
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  cdataPropName: false,
  isArray: (name) => ['item', 'entry', 'link', 'media:content', 'media:thumbnail', 'enclosure', 'category'].includes(name),
});

const arr = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** The text of a node that may be a string, a {#text} object, or missing. */
function text(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') return text(v['#text'] ?? '');
  return String(v);
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', pound: '£', euro: '€' };

/** Turn a bit of feed HTML into plain text for the screen. */
export function plainText(html, max = 400) {
  let s = String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return NAMED[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > max) s = `${s.slice(0, max).replace(/\s+\S*$/, '')}…`;
  return s;
}

function absoluteUrl(href, base) {
  if (!href) return null;
  try {
    const u = new URL(String(href).trim(), base);
    return ['http:', 'https:'].includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Ask for a bigger version of thumbnails from sites known to send small ones. */
export function upgradeImageUrl(url) {
  if (!url) return url;
  // BBC: https://ichef.bbci.co.uk/ace/standard/240/cpsprodpb/... (also /news/240/)
  return url.replace(/^(https:\/\/ichef\.bbci\.co\.uk\/(?:ace\/standard|news|ace\/ws))\/\d{2,4}\//, '$1/976/');
}

/** Pick the largest image a feed entry offers. */
function entryImage(entry, base) {
  const candidates = [];
  const add = (url, width, type) => {
    const abs = absoluteUrl(url, base);
    if (!abs) return;
    if (type && !/^image\//i.test(type)) return;
    candidates.push({ url: abs, width: Number(width) || 0 });
  };
  for (const m of arr(entry['media:content'])) {
    if (m['@medium'] && m['@medium'] !== 'image') continue;
    add(m['@url'], m['@width'], m['@medium'] ? null : m['@type'] || (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(m['@url'] || '') ? 'image/' : null));
    for (const t of arr(m['media:thumbnail'])) add(t['@url'], t['@width']);
  }
  for (const g of arr(entry['media:group'])) {
    for (const m of arr(g['media:content'])) add(m['@url'], m['@width'], m['@type'] || 'image/');
    for (const t of arr(g['media:thumbnail'])) add(t['@url'], t['@width']);
  }
  for (const t of arr(entry['media:thumbnail'])) add(t['@url'], t['@width']);
  for (const e of arr(entry.enclosure)) add(e['@url'], 0, e['@type'] || 'image/');
  for (const l of arr(entry.link)) {
    if (typeof l === 'object' && l['@rel'] === 'enclosure') add(l['@href'], 0, l['@type'] || 'image/');
  }
  if (entry.image) add(text(entry.image.url ?? entry.image), 0);
  if (!candidates.length) {
    // Fall back to the first <img> in the story's HTML.
    const html = text(entry['content:encoded']) || text(entry.content) || text(entry.description) || text(entry.summary);
    const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
    if (m) add(m[1].replace(/&amp;/g, '&'), 0);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.width - a.width);
  return upgradeImageUrl(candidates[0].url);
}

function parseDate(v) {
  const s = text(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Parse RSS 2.0, RSS 1.0 (RDF) or Atom into { title, siteUrl, stories }. */
export function parseFeed(xml, feedUrl) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new Error("That address didn't return an RSS or Atom feed");
  }
  let channel;
  let entries;
  let siteUrl = null;
  if (doc.rss?.channel) {
    channel = Array.isArray(doc.rss.channel) ? doc.rss.channel[0] : doc.rss.channel;
    entries = arr(channel.item);
    siteUrl = absoluteUrl(text(arr(channel.link).find((l) => typeof l !== 'object' || !l['@rel'])), feedUrl);
  } else if (doc['rdf:RDF']) {
    channel = doc['rdf:RDF'].channel || {};
    entries = arr(doc['rdf:RDF'].item);
    siteUrl = absoluteUrl(text(channel.link), feedUrl);
  } else if (doc.feed) {
    channel = doc.feed;
    entries = arr(channel.entry);
    const alt = arr(channel.link).find((l) => typeof l === 'object' && (!l['@rel'] || l['@rel'] === 'alternate'));
    siteUrl = absoluteUrl(alt?.['@href'], feedUrl);
  } else {
    throw new Error("That address didn't return an RSS or Atom feed");
  }

  const stories = [];
  for (const e of entries) {
    const title = plainText(text(e.title), 200);
    if (!title) continue;
    let link = null;
    for (const l of arr(e.link)) {
      if (typeof l === 'object') {
        if (!l['@rel'] || l['@rel'] === 'alternate') link = absoluteUrl(l['@href'] || text(l), feedUrl);
      } else link = absoluteUrl(l, feedUrl);
      if (link) break;
    }
    const summary = plainText(text(e.description) || text(e.summary) || text(e['media:description']) || text(e.content), 320);
    const guid = text(e.guid) || text(e.id) || link || title;
    stories.push({
      id: sha256(guid).slice(0, 16),
      title,
      // Some feeds repeat the headline as the summary; don't show it twice.
      summary: summary && summary !== title ? summary : '',
      link,
      publishedAt: parseDate(e.pubDate ?? e.published ?? e.updated ?? e['dc:date']),
      sourceImage: entryImage(e, feedUrl),
    });
  }
  // Newest first when dates are known; feeds are usually in that order already.
  if (stories.every((s) => s.publishedAt)) stories.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return {
    title: plainText(text(channel.title), 120) || new URL(feedUrl).hostname,
    siteUrl,
    stories: stories.slice(0, MAX_STORED_STORIES),
  };
}

// ---------- fetching ----------

const MAX_STORED_STORIES = 20;
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = 'Sinewave/0.1 (digital signage; +https://github.com/elliottmarter/Sinewave)';
export const newsImageDir = () => path.join(config.mediaDir, 'news');

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

function friendlyError(err) {
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'The feed took too long to respond';
  const code = err.cause?.code || err.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return "Couldn't find that site. Check the address";
  if (code === 'ECONNREFUSED') return 'The site refused the connection';
  if (/certificate|SSL|TLS/i.test(err.cause?.message || err.message)) return "The site's security certificate isn't valid";
  return err.message || 'Could not read the feed';
}

const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif' };

/**
 * Download a story image into DATA_DIR/media/news/, named after its source URL, and return
 * its /media URL. Returns null if it can't be fetched; the story then shows without a picture.
 */
async function downloadImage(sourceUrl) {
  const base = sha256(sourceUrl).slice(0, 32);
  const dir = newsImageDir();
  for (const ext of Object.values(IMAGE_EXT)) {
    if (fs.existsSync(path.join(dir, base + ext))) return `/media/news/${base}${ext}`;
  }
  try {
    const res = await fetch(sourceUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/avif,image/webp,image/jpeg,image/png,image/*' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = IMAGE_EXT[type];
    if (!ext) throw new Error(`not an image (${type || 'unknown type'})`);
    const data = await readLimited(res, MAX_IMAGE_BYTES);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${base}.tmp`);
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, path.join(dir, base + ext));
    return `/media/news/${base}${ext}`;
  } catch (err) {
    console.warn(`News image skipped (${sourceUrl}): ${err.message}`);
    return null;
  }
}

/** Run `fn` over `items` with at most `limit` running at once. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const inFlight = new Map();

/**
 * Fetch a feed and store it. Returns the stored row. Throws on failure (after recording the
 * error) so the dashboard can explain why a new feed can't be added; the previous good copy
 * is kept either way.
 */
export function refreshFeed(feedUrl) {
  if (inFlight.has(feedUrl)) return inFlight.get(feedUrl);
  const p = doRefresh(feedUrl).finally(() => inFlight.delete(feedUrl));
  inFlight.set(feedUrl, p);
  return p;
}

async function doRefresh(feedUrl) {
  const prev = getFeedRow(feedUrl);
  const now = new Date().toISOString();
  try {
    const headers = { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5' };
    if (prev?.etag) headers['If-None-Match'] = prev.etag;
    if (prev?.last_modified) headers['If-Modified-Since'] = prev.last_modified;
    let res;
    try {
      res = await fetch(feedUrl, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
    } catch (err) {
      throw new Error(friendlyError(err));
    }
    if (res.status === 304 && prev?.fetched_at) {
      query('UPDATE news_feeds SET fetched_at = $2, checked_at = $2, error = NULL WHERE url = $1', [feedUrl, now]);
      return { row: getFeedRow(feedUrl), changed: false };
    }
    if (!res.ok) throw new Error(`The feed answered with an error (HTTP ${res.status})`);
    let body;
    try {
      body = await readLimited(res, MAX_FEED_BYTES);
    } catch (err) {
      throw new Error(err.message === 'too large' ? 'The feed is too large' : friendlyError(err));
    }
    const feed = parseFeed(body.toString('utf8'), res.url || feedUrl);
    if (!feed.stories.length) throw new Error('The feed has no stories in it');

    // Reuse images we already have for stories seen before.
    const known = new Map(parseStories(prev).map((s) => [s.id, s]));
    const stories = await pool(feed.stories, 4, async (s) => {
      const old = known.get(s.id);
      let image = old && old.sourceImage === s.sourceImage ? old.image : null;
      if (image && !fs.existsSync(path.join(config.mediaDir, image.replace(/^\/media\//, '')))) image = null;
      if (!image && s.sourceImage) image = await downloadImage(s.sourceImage);
      return { ...s, image };
    });
    const json = JSON.stringify(stories);
    const checksum = sha256(json);
    query(
      `INSERT INTO news_feeds (url, title, site_url, stories, checksum, etag, last_modified, fetched_at, checked_at, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, NULL)
       ON CONFLICT (url) DO UPDATE SET title = excluded.title, site_url = excluded.site_url, stories = excluded.stories,
         checksum = excluded.checksum, etag = excluded.etag, last_modified = excluded.last_modified,
         fetched_at = excluded.fetched_at, checked_at = excluded.checked_at, error = NULL`,
      [feedUrl, feed.title, feed.siteUrl, json, checksum, res.headers.get('etag'), res.headers.get('last-modified'), now],
    );
    return { row: getFeedRow(feedUrl), changed: checksum !== prev?.checksum || feed.title !== prev?.title };
  } catch (err) {
    query(
      `INSERT INTO news_feeds (url, checked_at, error) VALUES ($1, $2, $3)
       ON CONFLICT (url) DO UPDATE SET checked_at = excluded.checked_at, error = excluded.error`,
      [feedUrl, now, err.message],
    );
    throw err;
  }
}

export function getFeedRow(feedUrl) {
  return query('SELECT * FROM news_feeds WHERE url = $1', [feedUrl]).rows[0] || null;
}

function parseStories(row) {
  try {
    return row?.stories ? JSON.parse(row.stories) : [];
  } catch {
    return [];
  }
}

export function parseOptions(media) {
  try {
    return normalizeNewsOptions(media.options ? JSON.parse(media.options) : {});
  } catch {
    return { ...DEFAULT_NEWS_OPTIONS };
  }
}

/** What a player needs to draw a news item, from the stored copy of its feed. */
export function newsContent(media) {
  const options = parseOptions(media);
  const row = getFeedRow(media.url);
  const stories = parseStories(row)
    .slice(0, options.maxStories)
    .map((s) => ({
      id: s.id,
      title: s.title,
      summary: options.showSummary ? s.summary : '',
      publishedAt: s.publishedAt,
      image: options.showImages ? s.image : null,
    }));
  return {
    title: options.label || row?.title || new URL(media.url).hostname,
    feedTitle: row?.title || null,
    siteUrl: row?.site_url || null,
    fetchedAt: row?.fetched_at || null,
    error: row?.error || null,
    options,
    stories,
  };
}

/** Default time on screen: every story once. */
export function newsDefaultSeconds(content) {
  return Math.max(1, content.stories.length) * content.options.secondsPerStory;
}

// ---------- background refresh ----------

const refreshMinutes = Math.max(1, Number(process.env.NEWS_REFRESH_MINUTES || 15));

/** Feeds used by at least one news item. */
const feedsInUse = () => query(`SELECT DISTINCT url FROM media WHERE kind = 'news' AND url IS NOT NULL`).rows.map((r) => r.url);

async function refreshDue(onChange) {
  const cutoff = Date.now() - refreshMinutes * 60_000;
  // Back off failing feeds to the same interval, so a dead feed is retried, not hammered.
  for (const url of feedsInUse()) {
    const row = getFeedRow(url);
    if (row?.checked_at && new Date(row.checked_at).getTime() > cutoff) continue;
    try {
      const { changed } = await refreshFeed(url);
      if (changed) await onChange(url);
    } catch (err) {
      console.warn(`News feed ${url} failed: ${err.message}`);
    }
  }
  await cleanupImages();
}

/** Delete downloaded images no stored feed refers to any more (after a day, in case one is mid-use). */
async function cleanupImages() {
  const dir = newsImageDir();
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  const used = new Set();
  for (const row of query('SELECT stories FROM news_feeds').rows) {
    for (const s of parseStories(row)) if (s.image) used.add(path.basename(s.image));
  }
  const dayAgo = Date.now() - 86_400_000;
  for (const name of names) {
    if (used.has(name)) continue;
    const file = path.join(dir, name);
    try {
      if ((await fsp.stat(file)).mtimeMs < dayAgo) await fsp.rm(file, { force: true });
    } catch {
      // gone already
    }
  }
}

/** Keep every feed in use fresh. `onChange(url)` is called when a feed's stories change. */
export function startNewsRefresher(onChange) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await refreshDue(onChange);
    } catch (err) {
      console.error('News refresh failed', err);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 2_000).unref();
  return setInterval(tick, 60_000).unref();
}
