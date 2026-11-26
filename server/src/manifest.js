import { query } from './db.js';
import { sha256 } from './util.js';
import { DEFAULT_SLIDE_SECONDS, slideContent } from './slides.js';
import { showVersionOnScreens } from './version.js';

export const DEFAULT_IMAGE_SECONDS = 10;
export const DEFAULT_WEB_SECONDS = 30;

export function mediaUrl(media) {
  // Web pages point at their external page.
  if (media.kind === 'web') return media.url;
  // Slides are drawn by the player from their settings; there is no file.
  if (media.kind === 'slide') return null;
  return `/media/${media.id}/${encodeURIComponent(media.filename)}`;
}

/**
 * Build the content manifest a player needs: everything it should play, in order,
 * with URLs and checksums so it can cache files and detect changes.
 * `version` changes whenever anything that affects playback changes.
 */
export async function buildManifest(screen) {
  let playlist = null;
  if (screen.playlist_id) {
    const { rows: pl } = await query('SELECT id, name, updated_at FROM playlists WHERE id = $1', [screen.playlist_id]);
    if (pl.length) {
      const { rows: items } = await query(
        `SELECT pi.id, pi.duration_seconds, m.id AS media_id, m.name, m.kind, m.mime_type,
                m.filename, m.url, m.size_bytes, m.checksum, m.options
           FROM playlist_items pi JOIN media m ON m.id = pi.media_id
          WHERE pi.playlist_id = $1 ORDER BY pi.position`,
        [screen.playlist_id],
      );
      playlist = {
        id: pl[0].id,
        name: pl[0].name,
        items: items.map((r) => {
          const item = {
            id: r.id,
            mediaId: r.media_id,
            name: r.name,
            kind: r.kind,
            mimeType: r.mime_type,
            url: mediaUrl({ id: r.media_id, kind: r.kind, filename: r.filename, url: r.url }),
            // Only files can be cached for offline playback; web pages are always live.
            cacheable: r.kind === 'image' || r.kind === 'video',
            sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
            checksum: r.checksum,
            // null for video means "play to the end".
            durationSeconds:
              r.duration_seconds ?? (r.kind === 'image' ? DEFAULT_IMAGE_SECONDS : r.kind === 'web' ? DEFAULT_WEB_SECONDS : null),
          };
          if (r.kind === 'slide') {
            // The settings travel in the manifest; the player draws the slide itself, so it works offline.
            // Pictures are listed as assets so the player caches them.
            const slide = slideContent(r);
            item.slide = slide;
            item.checksum = sha256(JSON.stringify(slide));
            item.assets = [slide.imageUrl, slide.backgroundUrl].filter(Boolean);
            item.durationSeconds = r.duration_seconds ?? DEFAULT_SLIDE_SECONDS;
          }
          return item;
        }),
      };
    }
  }
  // Screen-wide display options. Part of the body, so changing one updates every screen.
  const display = { showVersion: showVersionOnScreens() };
  const body = { screen: { id: screen.id, name: screen.name }, display, playlist };
  return { version: sha256(JSON.stringify(body)).slice(0, 16), generatedAt: new Date().toISOString(), ...body };
}
