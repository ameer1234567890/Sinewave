import { query, withTransaction } from './db.js';
import { uuid } from './util.js';

export const DEFAULT_PLAYLIST_NAME = 'Default';
const MAX_ITEMS = 500; // same cap the playlist editor enforces

/**
 * Append a newly added media item to the playlist called "Default", creating that playlist
 * if it doesn't exist (e.g. on a fresh install, or after someone deleted it).
 * Returns the playlist id, or null if the item wasn't added (playlist full, media gone).
 * Never throws for those cases: adding media must not fail because of the playlist.
 */
export function addToDefaultPlaylist(mediaId) {
  return withTransaction((client) => {
    if (!client.query('SELECT 1 FROM media WHERE id = $1', [mediaId]).rowCount) return null;
    let playlist = client.query('SELECT id FROM playlists WHERE name = $1 ORDER BY created_at, id LIMIT 1', [DEFAULT_PLAYLIST_NAME]).rows[0];
    if (!playlist) {
      playlist = { id: uuid() };
      client.query('INSERT INTO playlists (id, name) VALUES ($1, $2)', [playlist.id, DEFAULT_PLAYLIST_NAME]);
    }
    const { count, last } = client.query(
      'SELECT count(*) AS count, max(position) AS last FROM playlist_items WHERE playlist_id = $1',
      [playlist.id],
    ).rows[0];
    if (Number(count) >= MAX_ITEMS) return null;
    client.query(
      'INSERT INTO playlist_items (id, playlist_id, media_id, position, duration_seconds) VALUES ($1, $2, $3, $4, NULL)',
      [uuid(), playlist.id, mediaId, last === null || last === undefined ? 0 : Number(last) + 1],
    );
    client.query('UPDATE playlists SET updated_at = now() WHERE id = $1', [playlist.id]);
    return playlist.id;
  });
}

/** Same as addToDefaultPlaylist, but logs instead of throwing. */
export function tryAddToDefaultPlaylist(mediaId) {
  try {
    return addToDefaultPlaylist(mediaId);
  } catch (err) {
    console.error('Could not add media to the "Default" playlist:', err);
    return null;
  }
}
