-- News feeds and Autotask ticket stats were removed. Delete anything that used them, drop their
-- tables, and rebuild the media table once more without those kinds (SQLite can't change a CHECK
-- constraint in place; migrate() turns foreign keys off around this, so playlist items are
-- removed explicitly instead of by cascade).

UPDATE playlists SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id IN (SELECT playlist_id FROM playlist_items WHERE media_id IN (SELECT id FROM media WHERE kind IN ('news', 'autotask')));
DELETE FROM playlist_items WHERE media_id IN (SELECT id FROM media WHERE kind IN ('news', 'autotask'));
DELETE FROM media WHERE kind IN ('news', 'autotask');

DROP TABLE IF EXISTS news_feeds;
DROP TABLE IF EXISTS integrations;

CREATE TABLE media_new (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('image', 'video', 'web', 'slide')),
  mime_type    TEXT,
  filename     TEXT,           -- stored file name on disk (null for web pages and slides)
  url          TEXT,           -- external URL (web pages only)
  size_bytes   INTEGER,
  checksum     TEXT,           -- sha256 of file content (or of the settings, for slides)
  options      TEXT,           -- JSON settings (slides: template, background, text)
  preview      TEXT,           -- web pages: screenshot file name inside the item's media folder
  preview_at   TEXT,           -- web pages: when the screenshot was captured
  preview_error TEXT,          -- web pages: why the last capture failed
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO media_new (id, name, kind, mime_type, filename, url, size_bytes, checksum, options, preview, preview_at, preview_error, created_at)
  SELECT id, name, kind, mime_type, filename, url, size_bytes, checksum, options, preview, preview_at, preview_error, created_at FROM media;
DROP TABLE media;
ALTER TABLE media_new RENAME TO media;
