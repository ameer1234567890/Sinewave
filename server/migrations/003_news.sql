-- News (RSS/Atom) widgets. SQLite can't change a CHECK constraint in place, so the media
-- table is rebuilt (the documented 12-step way; migrate() turns foreign keys off around it).

CREATE TABLE media_new (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('image', 'video', 'web', 'news')),
  mime_type    TEXT,
  filename     TEXT,           -- stored file name on disk (null for web pages and news)
  url          TEXT,           -- external URL (web page address, or the news feed URL)
  size_bytes   INTEGER,
  checksum     TEXT,           -- sha256 of file content
  options      TEXT,           -- JSON settings (news: layout, theme, stories, timing)
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO media_new (id, name, kind, mime_type, filename, url, size_bytes, checksum, created_at)
  SELECT id, name, kind, mime_type, filename, url, size_bytes, checksum, created_at FROM media;
DROP TABLE media;
ALTER TABLE media_new RENAME TO media;

-- The last good copy of each feed, so screens keep showing headlines when a feed is down.
CREATE TABLE news_feeds (
  url            TEXT PRIMARY KEY,
  title          TEXT,
  site_url       TEXT,
  stories        TEXT NOT NULL DEFAULT '[]',  -- JSON array, newest first
  checksum       TEXT,                        -- sha256 of stories, to spot real changes
  etag           TEXT,
  last_modified  TEXT,
  fetched_at     TEXT,                        -- last successful fetch
  checked_at     TEXT,                        -- last attempt, successful or not
  error          TEXT                         -- last error, cleared on success
);
