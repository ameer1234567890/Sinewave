import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { withTransaction } from './db.js';
import { sha256, uuid } from './util.js';

// Slides bundled with the app (rendered by e2e/render-demo-slides.cjs).
const demoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../demo');

// What the "Demo" playlist plays, in order. Web pages must allow being shown in a frame.
export const DEMO_ITEMS = [
  { kind: 'image', name: 'Demo: Welcome to Sinewave', file: 'welcome.jpg', seconds: 10 },
  { kind: 'image', name: 'Demo: Add your content', file: 'add-content.jpg', seconds: 12 },
  { kind: 'image', name: 'Demo: Pair a screen', file: 'pair-screen.jpg', seconds: 12 },
  {
    kind: 'web',
    name: 'Demo: Live wind map',
    url: 'https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=default&metricTemp=default&metricWind=default&zoom=3&overlay=wind&product=ecmwf&level=surface&lat=30&lon=0',
    seconds: 30,
  },
  { kind: 'image', name: 'Demo: Make it yours', file: 'make-it-yours.jpg', seconds: 12 },
  {
    kind: 'web',
    name: 'Demo: World map',
    url: 'https://www.openstreetmap.org/export/embed.html?bbox=-160%2C-50%2C180%2C72&layer=mapnik',
    seconds: 20,
  },
];

/**
 * Create the "Demo" playlist and its media. Called once, on a fresh install only, so a
 * user who deletes it never sees it come back. A failure here is logged, never fatal.
 */
export function seedDemo() {
  const copied = [];
  try {
    const media = DEMO_ITEMS.map((item) => {
      const id = uuid();
      if (item.kind === 'web') return { ...item, id, checksum: sha256(item.url) };
      const data = fs.readFileSync(path.join(demoDir, item.file));
      const dir = path.join(config.mediaDir, id);
      fs.mkdirSync(dir, { recursive: true });
      copied.push(dir);
      fs.writeFileSync(path.join(dir, item.file), data);
      return { ...item, id, mimeType: 'image/jpeg', size: data.length, checksum: sha256(data) };
    });
    withTransaction(({ query }) => {
      const playlistId = uuid();
      query('INSERT INTO playlists (id, name) VALUES ($1, $2)', [playlistId, 'Demo']);
      media.forEach((m, position) => {
        query(
          `INSERT INTO media (id, name, kind, mime_type, filename, url, size_bytes, checksum)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [m.id, m.name, m.kind, m.mimeType, m.file, m.url, m.size, m.checksum],
        );
        query(
          'INSERT INTO playlist_items (id, playlist_id, media_id, position, duration_seconds) VALUES ($1, $2, $3, $4, $5)',
          [uuid(), playlistId, m.id, position, m.seconds],
        );
      });
    });
    console.log('Fresh install: created the "Demo" playlist');
  } catch (err) {
    for (const dir of copied) fs.rmSync(dir, { recursive: true, force: true });
    console.error('Could not create the "Demo" playlist:', err);
  }
}
