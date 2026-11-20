import path from 'node:path';
import { createRequire } from 'node:module';
import { config } from './config.js';
import { query } from './db.js';
import { isUuid } from './util.js';

// Templates, backgrounds and the renderer live in the player's slides.js, shared with the
// dashboard, so there is one list of what a slide can be.
export const Slides = createRequire(import.meta.url)(path.join(config.playerDir, 'slides.js'));

export const DEFAULT_SLIDE_SECONDS = 10;

function parseOptions(row) {
  try {
    return JSON.parse(row.options || '{}') || {};
  } catch {
    return {};
  }
}

function imageExists(id) {
  return isUuid(id) && query(`SELECT 1 FROM media WHERE id = $1 AND kind = 'image'`, [id]).rowCount > 0;
}

/** Clean up slide settings from the dashboard. Pictures must be images already in Media. */
export function normalizeSlideOptions(input) {
  const s = Slides.normalize(input && typeof input === 'object' ? input : {});
  if (s.imageId && !imageExists(s.imageId)) s.imageId = null;
  if (s.backgroundImageId && !imageExists(s.backgroundImageId)) s.backgroundImageId = null;
  return s;
}

/** Everything a player or the dashboard needs to draw a slide, with picture ids turned into URLs. */
export function slideContent(row) {
  const s = Slides.normalize(parseOptions(row));
  const urls = {};
  const ids = [s.imageId, s.backgroundImageId].filter(isUuid);
  if (ids.length) {
    const { rows } = query(
      `SELECT id, filename FROM media WHERE kind = 'image' AND id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})`,
      ids,
    );
    for (const r of rows) urls[r.id] = `/media/${r.id}/${encodeURIComponent(r.filename)}`;
  }
  return { ...s, imageUrl: urls[s.imageId] || null, backgroundUrl: urls[s.backgroundImageId] || null };
}

/** Slides that show a given picture, so screens showing them can be told when it goes away. */
export function slidesUsingImage(imageId) {
  const { rows } = query(`SELECT id, options FROM media WHERE kind = 'slide' AND options LIKE $1`, [`%${imageId}%`]);
  return rows
    .filter((r) => {
      const o = parseOptions(r);
      return o.imageId === imageId || o.backgroundImageId === imageId;
    })
    .map((r) => r.id);
}
