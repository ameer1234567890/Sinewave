-- Slides made in the dashboard from a template. Their settings live in media.options as JSON.
-- SQLite can't change a CHECK constraint in place, so the media table is rebuilt again
-- (the documented 12-step way; migrate() turns foreign keys off around it).

CREATE TABLE media_new (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('image', 'video', 'web', 'news', 'slide')),
  mime_type    TEXT,
  filename     TEXT,           -- stored file name on disk (null for web pages, news and slides)
  url          TEXT,           -- external URL (web page address, or the news feed URL)
  size_bytes   INTEGER,
  checksum     TEXT,           -- sha256 of file content (or of the settings, for slides)
  options      TEXT,           -- JSON settings (news: layout, theme, timing; slide: template, background, text)
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO media_new (id, name, kind, mime_type, filename, url, size_bytes, checksum, options, created_at)
  SELECT id, name, kind, mime_type, filename, url, size_bytes, checksum, options, created_at FROM media;
DROP TABLE media;
ALTER TABLE media_new RENAME TO media;
