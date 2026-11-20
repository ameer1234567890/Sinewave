import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { requireSuperAdmin } from '../auth.js';
import { config } from '../config.js';
import { isForeignKeyError, query, withTransaction } from '../db.js';
import { hub } from '../hub.js';
import { mediaUrl } from '../manifest.js';
import { POPULAR_FEEDS, getFeedRow, newsContent, normalizeNewsOptions, parseFeedUrl, parseOptions, refreshFeed } from '../news.js';
import { normalizeSlideOptions, slideContent, slidesUsingImage } from '../slides.js';
import { isPreviewPending, previewUrl, queuePreview } from '../webpreview.js';
import { HttpError, isUuid, normalizeCode, randomToken, sha256, uuid } from '../util.js';

export const admin = express.Router();

const tmpDir = path.join(config.mediaDir, '.tmp');
fs.mkdirSync(tmpDir, { recursive: true });
const upload = multer({ dest: tmpDir, limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 50 } });

function param(req, name = 'id') {
  const v = req.params[name];
  if (!isUuid(v)) throw new HttpError(404, 'Not found');
  return v;
}

function cleanName(v, fallback) {
  const s = typeof v === 'string' ? v.trim().slice(0, 200) : '';
  return s || fallback;
}

function isOnline(row) {
  if (hub.isConnected(row.id)) return true;
  return Boolean(row.last_seen_at && Date.now() - new Date(row.last_seen_at).getTime() < config.onlineWindowSeconds * 1000);
}

function serializeNews(m) {
  const content = newsContent(m);
  return {
    feedUrl: m.url,
    feedTitle: content.feedTitle,
    options: parseOptions(m),
    fetchedAt: content.fetchedAt,
    error: content.error,
    storyCount: content.stories.length,
    // A taste of what's on screen, for the media tile.
    headline: content.stories[0]?.title || null,
    image: content.stories.find((s) => s.image)?.image || null,
  };
}

function serializeMedia(m) {
  return {
    id: m.id,
    name: m.name,
    kind: m.kind,
    mimeType: m.mime_type,
    url: mediaUrl(m),
    sizeBytes: m.size_bytes === null ? null : Number(m.size_bytes),
    createdAt: m.created_at,
    usedIn: m.used_in === undefined ? undefined : Number(m.used_in),
    news: m.kind === 'news' ? serializeNews(m) : undefined,
    slide: m.kind === 'slide' ? slideContent(m) : undefined,
    web: m.kind === 'web' ? serializeWeb(m) : undefined,
  };
}

function serializeWeb(m) {
  return {
    // A small picture of the page for the media card, or null while it's captured (pending) or if it couldn't be.
    previewUrl: previewUrl(m),
    previewPending: isPreviewPending(m.id),
    previewError: m.preview ? null : m.preview_error || null,
  };
}

function serializeScreen(s) {
  return {
    id: s.id,
    name: s.name,
    playlistId: s.playlist_id,
    playlistName: s.playlist_name ?? null,
    online: isOnline(s),
    connected: hub.isConnected(s.id),
    lastSeenAt: s.last_seen_at,
    lastIp: s.last_ip,
    userAgent: s.user_agent,
    nowPlaying: s.now_playing,
    // What the screen is showing right now, for the dashboard preview. null when idle or unknown.
    nowPlayingMedia: s.np_id
      ? {
          id: s.np_id,
          name: s.np_name,
          kind: s.np_kind,
          url: mediaUrl({ id: s.np_id, kind: s.np_kind, filename: s.np_filename, url: s.np_url }),
          news: s.np_kind === 'news' ? serializeNews({ url: s.np_url, options: s.np_options }) : undefined,
          slide: s.np_kind === 'slide' ? slideContent({ options: s.np_options }) : undefined,
        }
      : null,
    playerVersion: s.player_version,
    createdAt: s.created_at,
  };
}

// ---------- Media ----------

admin.get('/media', async (_req, res) => {
  const { rows } = await query(
    `SELECT m.*, (SELECT count(*) FROM playlist_items pi WHERE pi.media_id = m.id) AS used_in
       FROM media m ORDER BY m.created_at DESC`,
  );
  res.json(rows.map(serializeMedia));
});

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function safeFilename(original) {
  const ext = path.extname(original).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
  const base = path
    .basename(original, path.extname(original))
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${base || 'file'}${ext}`;
}

admin.post('/media', upload.array('files'), async (req, res) => {
  const files = req.files || [];
  if (!files.length) throw new HttpError(400, 'No files uploaded');
  const created = [];
  try {
    for (const f of files) {
      const kind = f.mimetype.startsWith('image/') ? 'image' : f.mimetype.startsWith('video/') ? 'video' : null;
      if (!kind) throw new HttpError(400, `${f.originalname}: only images and videos are supported`);
      const id = uuid();
      const filename = safeFilename(f.originalname);
      const dir = path.join(config.mediaDir, id);
      await fsp.mkdir(dir, { recursive: true });
      const checksum = await hashFile(f.path);
      await fsp.rename(f.path, path.join(dir, filename));
      const { rows } = await query(
        `INSERT INTO media (id, name, kind, mime_type, filename, size_bytes, checksum)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [id, cleanName(path.basename(f.originalname, path.extname(f.originalname)), filename), kind, f.mimetype, filename, f.size, checksum],
      );
      created.push(serializeMedia({ ...rows[0], used_in: 0 }));
    }
  } finally {
    await Promise.all(files.map((f) => fsp.rm(f.path, { force: true })));
  }
  res.status(201).json(created);
});

admin.post('/media/web', async (req, res) => {
  let url;
  try {
    url = new URL(String(req.body?.url || ''));
  } catch {
    throw new HttpError(400, 'Enter a full URL, starting with http:// or https://');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'Only http and https URLs are supported');
  const { rows } = await query(
    `INSERT INTO media (id, name, kind, url, checksum) VALUES ($1, $2, 'web', $3, $4) RETURNING *`,
    [uuid(), cleanName(req.body?.name, url.hostname), url.toString(), sha256(url.toString())],
  );
  queuePreview(rows[0].id);
  res.status(201).json(serializeMedia({ ...rows[0], used_in: 0 }));
});

/** Take a fresh picture of a web page, e.g. after the page has changed. */
admin.post('/media/:id/preview', async (req, res) => {
  const id = param(req);
  const { rows } = await query(`SELECT * FROM media WHERE id = $1 AND kind = 'web'`, [id]);
  if (!rows.length) throw new HttpError(404, 'Web page not found');
  queuePreview(id);
  res.status(202).json(serializeMedia(rows[0]));
});

// ---------- News ----------

admin.get('/news/feeds', (_req, res) => {
  res.json(POPULAR_FEEDS);
});

/** Fetch a feed now (or reuse a copy from the last few minutes) so a bad URL is caught before it's saved. */
async function checkFeed(feedUrl) {
  const row = getFeedRow(feedUrl);
  if (row?.fetched_at && Date.now() - new Date(row.fetched_at).getTime() < 5 * 60_000) return row;
  try {
    return (await refreshFeed(feedUrl)).row;
  } catch (err) {
    throw new HttpError(400, `Couldn't read that feed: ${err.message}`);
  }
}

admin.post('/media/news', async (req, res) => {
  const feedUrl = parseFeedUrl(req.body?.feedUrl);
  const options = normalizeNewsOptions(req.body?.options || {});
  const row = await checkFeed(feedUrl);
  const { rows } = await query(
    `INSERT INTO media (id, name, kind, url, options, checksum) VALUES ($1, $2, 'news', $3, $4, $5) RETURNING *`,
    [uuid(), cleanName(req.body?.name, row.title || new URL(feedUrl).hostname), feedUrl, JSON.stringify(options), sha256(feedUrl)],
  );
  res.status(201).json(serializeMedia({ ...rows[0], used_in: 0 }));
});

/** Change a news item's feed or settings. */
admin.put('/media/:id/news', async (req, res) => {
  const id = param(req);
  const { rows: found } = await query(`SELECT * FROM media WHERE id = $1 AND kind = 'news'`, [id]);
  if (!found.length) throw new HttpError(404, 'News item not found');
  const feedUrl = req.body?.feedUrl === undefined ? found[0].url : parseFeedUrl(req.body.feedUrl);
  if (feedUrl !== found[0].url) await checkFeed(feedUrl);
  const options = normalizeNewsOptions(req.body?.options || {}, parseOptions(found[0]));
  const { rows } = await query('UPDATE media SET name = $2, url = $3, options = $4, checksum = $5 WHERE id = $1 RETURNING *', [
    id,
    cleanName(req.body?.name, found[0].name),
    feedUrl,
    JSON.stringify(options),
    sha256(feedUrl),
  ]);
  await hub.notifyMedia(id);
  res.json(serializeMedia(rows[0]));
});

/** Fetch a news item's feed right now instead of waiting for the next scheduled refresh. */
admin.post('/media/:id/news/refresh', async (req, res) => {
  const id = param(req);
  const { rows } = await query(`SELECT * FROM media WHERE id = $1 AND kind = 'news'`, [id]);
  if (!rows.length) throw new HttpError(404, 'News item not found');
  try {
    await refreshFeed(rows[0].url);
  } catch (err) {
    throw new HttpError(502, `Couldn't refresh the feed: ${err.message}`);
  }
  await hub.notifyMedia(id);
  res.json(serializeMedia(rows[0]));
});

// ---------- Slides ----------

function slideName(req, options, fallback) {
  const f = options.fields;
  return cleanName(req.body?.name, fallback || f.title || f.message?.split('\n')[0] || 'New slide');
}

admin.post('/media/slide', async (req, res) => {
  const options = normalizeSlideOptions(req.body?.options);
  const json = JSON.stringify(options);
  const { rows } = await query(
    `INSERT INTO media (id, name, kind, options, checksum) VALUES ($1, $2, 'slide', $3, $4) RETURNING *`,
    [uuid(), slideName(req, options), json, sha256(json)],
  );
  res.status(201).json(serializeMedia({ ...rows[0], used_in: 0 }));
});

/** Change a slide's template, background, text or pictures. Screens showing it update straight away. */
admin.put('/media/:id/slide', async (req, res) => {
  const id = param(req);
  const { rows: found } = await query(`SELECT * FROM media WHERE id = $1 AND kind = 'slide'`, [id]);
  if (!found.length) throw new HttpError(404, 'Slide not found');
  const options = normalizeSlideOptions(req.body?.options);
  const json = JSON.stringify(options);
  const { rows } = await query('UPDATE media SET name = $2, options = $3, checksum = $4 WHERE id = $1 RETURNING *', [
    id,
    slideName(req, options, found[0].name),
    json,
    sha256(json),
  ]);
  await hub.notifyMedia(id);
  res.json(serializeMedia(rows[0]));
});

admin.patch('/media/:id', async (req, res) => {
  const id = param(req);
  const { rows } = await query('UPDATE media SET name = $2 WHERE id = $1 RETURNING *', [id, cleanName(req.body?.name, 'Untitled')]);
  if (!rows.length) throw new HttpError(404, 'Media not found');
  await hub.notifyMedia(id);
  res.json(serializeMedia(rows[0]));
});

admin.delete('/media/:id', async (req, res) => {
  const id = param(req);
  // Work out who is affected before the cascade removes the playlist items.
  const { rows: affected } = await query(
    `SELECT DISTINCT s.id FROM screens s JOIN playlist_items pi ON pi.playlist_id = s.playlist_id WHERE pi.media_id = $1`,
    [id],
  );
  const { rows } = await query('DELETE FROM media WHERE id = $1 RETURNING *', [id]);
  if (!rows.length) throw new HttpError(404, 'Media not found');
  await query(
    'UPDATE playlists SET updated_at = now() WHERE id IN (SELECT DISTINCT playlist_id FROM playlist_items WHERE media_id = $1)',
    [id],
  );
  // Uploads and web page previews both live in the item's own folder.
  await fsp.rm(path.join(config.mediaDir, id), { recursive: true, force: true });
  await hub.notifyScreens(affected.map((r) => r.id));
  // Slides that showed this picture carry on without it.
  if (rows[0].kind === 'image') for (const slideId of slidesUsingImage(id)) await hub.notifyMedia(slideId);
  res.status(204).end();
});

// ---------- Playlists ----------

admin.get('/playlists', async (_req, res) => {
  const { rows } = await query(
    `SELECT p.*,
            (SELECT count(*) FROM playlist_items pi WHERE pi.playlist_id = p.id) AS item_count,
            (SELECT count(*) FROM screens s WHERE s.playlist_id = p.id) AS screen_count
       FROM playlists p ORDER BY p.name`,
  );
  res.json(
    rows.map((p) => ({
      id: p.id,
      name: p.name,
      itemCount: Number(p.item_count),
      screenCount: Number(p.screen_count),
      updatedAt: p.updated_at,
    })),
  );
});

async function loadPlaylist(id) {
  const { rows } = await query('SELECT * FROM playlists WHERE id = $1', [id]);
  if (!rows.length) throw new HttpError(404, 'Playlist not found');
  const { rows: items } = await query(
    `SELECT pi.id AS item_id, pi.duration_seconds, m.*
       FROM playlist_items pi JOIN media m ON m.id = pi.media_id
      WHERE pi.playlist_id = $1 ORDER BY pi.position`,
    [id],
  );
  return {
    id: rows[0].id,
    name: rows[0].name,
    updatedAt: rows[0].updated_at,
    items: items.map((i) => ({
      id: i.item_id,
      durationSeconds: i.duration_seconds,
      media: serializeMedia(i),
    })),
  };
}

admin.post('/playlists', async (req, res) => {
  const id = uuid();
  await query('INSERT INTO playlists (id, name) VALUES ($1, $2)', [id, cleanName(req.body?.name, 'New playlist')]);
  res.status(201).json(await loadPlaylist(id));
});

admin.get('/playlists/:id', async (req, res) => {
  res.json(await loadPlaylist(param(req)));
});

/** Replace a playlist's name and full item list in one go (the editor saves the whole thing). */
admin.put('/playlists/:id', async (req, res) => {
  const id = param(req);
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items) throw new HttpError(400, 'items must be an array');
  if (items.length > 500) throw new HttpError(400, 'A playlist can hold at most 500 items');
  for (const item of items) {
    if (!isUuid(item.mediaId)) throw new HttpError(400, 'Each item needs a mediaId');
    const d = item.durationSeconds;
    if (d !== null && d !== undefined && !(Number.isInteger(d) && d >= 1 && d <= 86400)) {
      throw new HttpError(400, 'durationSeconds must be a whole number of seconds between 1 and 86400');
    }
  }
  try {
    withTransaction((client) => {
      const { rowCount } = client.query('UPDATE playlists SET name = $2, updated_at = now() WHERE id = $1', [
        id,
        cleanName(req.body?.name, 'Untitled playlist'),
      ]);
      if (!rowCount) throw new HttpError(404, 'Playlist not found');
      client.query('DELETE FROM playlist_items WHERE playlist_id = $1', [id]);
      for (const [position, item] of items.entries()) {
        client.query(
          'INSERT INTO playlist_items (id, playlist_id, media_id, position, duration_seconds) VALUES ($1, $2, $3, $4, $5)',
          [uuid(), id, item.mediaId, position, item.durationSeconds ?? null],
        );
      }
    });
  } catch (err) {
    if (isForeignKeyError(err)) throw new HttpError(400, 'One of the media items no longer exists');
    throw err;
  }
  await hub.notifyPlaylist(id);
  res.json(await loadPlaylist(id));
});

admin.delete('/playlists/:id', async (req, res) => {
  const id = param(req);
  const { rows: affected } = await query('SELECT id FROM screens WHERE playlist_id = $1', [id]);
  const { rowCount } = await query('DELETE FROM playlists WHERE id = $1', [id]);
  if (!rowCount) throw new HttpError(404, 'Playlist not found');
  await hub.notifyScreens(affected.map((r) => r.id));
  res.status(204).end();
});

// ---------- Screens ----------

const SCREEN_SELECT = `SELECT s.*, p.name AS playlist_name,
       np.id AS np_id, np.name AS np_name, np.kind AS np_kind, np.filename AS np_filename, np.url AS np_url, np.options AS np_options
  FROM screens s
  LEFT JOIN playlists p ON p.id = s.playlist_id
  LEFT JOIN media np ON np.id = s.now_playing_media_id`;

admin.get('/screens', async (_req, res) => {
  const { rows } = await query(`${SCREEN_SELECT} ORDER BY s.name`);
  res.json(rows.map(serializeScreen));
});

async function validPlaylistId(v) {
  if (v === null || v === undefined || v === '') return null;
  if (!isUuid(v)) throw new HttpError(400, 'Unknown playlist');
  const { rowCount } = await query('SELECT 1 FROM playlists WHERE id = $1', [v]);
  if (!rowCount) throw new HttpError(400, 'Unknown playlist');
  return v;
}

/** Claim the pairing code a player is showing and create a screen for it. */
admin.post('/screens/pair', requireSuperAdmin, async (req, res) => {
  const code = normalizeCode(req.body?.code);
  if (code.length !== 6) throw new HttpError(400, 'Pairing codes are 6 characters');
  const playlistId = await validPlaylistId(req.body?.playlistId);
  const screenId = withTransaction((client) => {
    const { rows } = client.query(
      `SELECT id FROM pairing_requests
        WHERE code = $1 AND screen_id IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`,
      [code],
    );
    if (!rows.length) throw new HttpError(404, 'No screen is showing that code. Check it, or reload the player to get a new one.');
    const id = uuid();
    const token = randomToken();
    client.query('INSERT INTO screens (id, name, token_hash, playlist_id) VALUES ($1, $2, $3, $4)', [
      id,
      cleanName(req.body?.name, `Screen ${code}`),
      sha256(token),
      playlistId,
    ]);
    client.query('UPDATE pairing_requests SET screen_id = $2, device_token = $3 WHERE id = $1', [rows[0].id, id, token]);
    return id;
  });
  const { rows } = await query(`${SCREEN_SELECT} WHERE s.id = $1`, [screenId]);
  res.status(201).json(serializeScreen(rows[0]));
});

admin.patch('/screens/:id', async (req, res) => {
  const id = param(req);
  const sets = [];
  const values = [id];
  if (req.body?.name !== undefined) {
    values.push(cleanName(req.body.name, 'Screen'));
    sets.push(`name = $${values.length}`);
  }
  if (req.body?.playlistId !== undefined) {
    values.push(await validPlaylistId(req.body.playlistId));
    sets.push(`playlist_id = $${values.length}`);
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to update');
  const { rowCount } = await query(`UPDATE screens SET ${sets.join(', ')} WHERE id = $1`, values);
  if (!rowCount) throw new HttpError(404, 'Screen not found');
  await hub.notifyScreens([id]);
  const { rows } = await query(`${SCREEN_SELECT} WHERE s.id = $1`, [id]);
  res.json(serializeScreen(rows[0]));
});

admin.delete('/screens/:id', requireSuperAdmin, async (req, res) => {
  const id = param(req);
  const { rowCount } = await query('DELETE FROM screens WHERE id = $1', [id]);
  if (!rowCount) throw new HttpError(404, 'Screen not found');
  hub.send(id, { type: 'unpaired' });
  hub.kick(id);
  res.status(204).end();
});

/** Remote commands: "refresh" re-syncs content, "reload" restarts the player page. */
admin.post('/screens/:id/commands', async (req, res) => {
  const id = param(req);
  const command = req.body?.command;
  if (!['refresh', 'reload'].includes(command)) throw new HttpError(400, 'Unknown command');
  const delivered = hub.send(id, { type: command === 'refresh' ? 'content-changed' : 'reload' });
  if (!delivered) throw new HttpError(409, 'That screen is not connected right now');
  res.json({ delivered });
});
