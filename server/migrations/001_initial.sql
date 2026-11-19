-- Timestamps are ISO 8601 UTC strings (e.g. 2026-01-31T09:30:00.000Z), which sort and compare correctly as text.

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE media (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('image', 'video', 'web')),
  mime_type    TEXT,
  filename     TEXT,           -- stored file name on disk (null for web pages)
  url          TEXT,           -- external URL (web pages only)
  size_bytes   INTEGER,
  checksum     TEXT,           -- sha256 of file content
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE playlists (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE playlist_items (
  id                TEXT PRIMARY KEY,
  playlist_id       TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  media_id          TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL,
  duration_seconds  INTEGER       -- null = media default (video: full length)
);
CREATE INDEX playlist_items_playlist_idx ON playlist_items (playlist_id, position);
CREATE INDEX playlist_items_media_idx ON playlist_items (media_id);

CREATE TABLE screens (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  token_hash     TEXT NOT NULL UNIQUE,
  playlist_id    TEXT REFERENCES playlists(id) ON DELETE SET NULL,
  last_seen_at   TEXT,
  last_ip        TEXT,
  user_agent     TEXT,
  now_playing    TEXT,
  player_version TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE pairing_requests (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  screen_id    TEXT REFERENCES screens(id) ON DELETE CASCADE,
  device_token TEXT,          -- handed to the player once, then cleared
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX pairing_requests_code_idx ON pairing_requests (code);
