// Unit tests for adding new media to the "Default" playlist. Run with: npm test (from server/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sinewave-test-'));
const { migrate, query } = await import('../src/db.js');
const { addToDefaultPlaylist } = await import('../src/defaultPlaylist.js');
migrate();

const media = (n) => {
  const id = `00000000-0000-4000-8000-00000000000${n}`;
  query(`INSERT INTO media (id, name, kind, filename) VALUES ($1, $2, 'image', 'x.png')`, [id, `M${n}`]);
  return id;
};
const items = (playlistId) =>
  query('SELECT media_id, position, duration_seconds FROM playlist_items WHERE playlist_id = $1 ORDER BY position', [playlistId]).rows.map((r) => ({ ...r }));

test('creates the Default playlist when it is missing and appends media in order', () => {
  const a = media(1);
  const b = media(2);
  const id = addToDefaultPlaylist(a);
  assert.equal(addToDefaultPlaylist(b), id);
  assert.equal(query(`SELECT count(*) AS n FROM playlists WHERE name = 'Default'`).rows[0].n, 1);
  assert.deepEqual(items(id), [
    { media_id: a, position: 0, duration_seconds: null },
    { media_id: b, position: 1, duration_seconds: null },
  ]);
});

test('reuses an existing playlist called Default and keeps its items', () => {
  const { id } = query(`SELECT id FROM playlists WHERE name = 'Default'`).rows[0];
  const c = media(3);
  assert.equal(addToDefaultPlaylist(c), id);
  assert.equal(items(id).length, 3);
  assert.equal(items(id)[2].media_id, c);
});

test('returns null for media that does not exist', () => {
  assert.equal(addToDefaultPlaylist('99999999-9999-4999-8999-999999999999'), null);
});

test('migration 007 removes news and ticket items, their tables, and keeps everything else', async () => {
  // Run the whole migration history up to 006 on a fresh database, add old-style rows, then apply 007.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinewave-mig-'));
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'm.db'));
  const migrations = path.join(import.meta.dirname, '../migrations');
  const files = fs.readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files.filter((f) => f < '007')) db.exec(fs.readFileSync(path.join(migrations, f), 'utf8'));
  db.exec(`INSERT INTO media (id, name, kind, filename) VALUES ('img', 'Pic', 'image', 'p.png');
           INSERT INTO media (id, name, kind, url, options) VALUES ('news', 'News', 'news', 'http://x/feed', '{}');
           INSERT INTO media (id, name, kind, options) VALUES ('tix', 'Tickets', 'autotask', '{}');
           INSERT INTO playlists (id, name) VALUES ('pl', 'P');
           INSERT INTO playlist_items (id, playlist_id, media_id, position) VALUES ('a', 'pl', 'img', 0), ('b', 'pl', 'news', 1), ('c', 'pl', 'tix', 2);`);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(fs.readFileSync(path.join(migrations, files.find((f) => f.startsWith('007'))), 'utf8'));
  assert.deepEqual(db.prepare('SELECT id FROM media').all().map((r) => r.id), ['img']);
  assert.deepEqual(db.prepare('SELECT id FROM playlist_items').all().map((r) => r.id), ['a']);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  assert.ok(!tables.includes('news_feeds') && !tables.includes('integrations'));
  assert.throws(() => db.exec(`INSERT INTO media (id, name, kind) VALUES ('n2', 'N', 'news')`));
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.close();
});
