-- Autotask ticket stats widgets. The media table is rebuilt once more to allow the new kind
-- (SQLite can't change a CHECK constraint in place; migrate() turns foreign keys off around it).

CREATE TABLE media_new (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('image', 'video', 'web', 'news', 'slide', 'autotask')),
  mime_type    TEXT,
  filename     TEXT,           -- stored file name on disk (null for web pages, news, slides and widgets)
  url          TEXT,           -- external URL (web page address, or the news feed URL)
  size_bytes   INTEGER,
  checksum     TEXT,           -- sha256 of file content (or of the settings, for slides and widgets)
  options      TEXT,           -- JSON settings (news, slide, autotask)
  preview      TEXT,           -- web pages: screenshot file name inside the item's media folder
  preview_at   TEXT,           -- web pages: when the screenshot was captured
  preview_error TEXT,          -- web pages: why the last capture failed
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO media_new (id, name, kind, mime_type, filename, url, size_bytes, checksum, options, preview, preview_at, preview_error, created_at)
  SELECT id, name, kind, mime_type, filename, url, size_bytes, checksum, options, preview, preview_at, preview_error, created_at FROM media;
DROP TABLE media;
ALTER TABLE media_new RENAME TO media;

-- Connections to outside services (one row per service, e.g. 'autotask').
-- The secret is kept apart from the settings so it is never sent back to the dashboard.
CREATE TABLE integrations (
  name        TEXT PRIMARY KEY,
  settings    TEXT NOT NULL DEFAULT '{}',   -- JSON: username, integration code, zone, options
  secret      TEXT,                         -- API secret; write-only from the dashboard
  snapshot    TEXT,                         -- JSON: the last good copy of the data
  fetched_at  TEXT,                         -- last successful fetch
  checked_at  TEXT,                         -- last attempt, successful or not
  error       TEXT,                         -- last error, cleared on success
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
