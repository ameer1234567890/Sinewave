CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE media (
  id           UUID PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('image', 'video', 'web')),
  mime_type    TEXT,
  filename     TEXT,           -- stored file name on disk (null for web pages)
  url          TEXT,           -- external URL (web pages only)
  size_bytes   BIGINT,
  checksum     TEXT,           -- sha256 of file content
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE playlists (
  id          UUID PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE playlist_items (
  id                UUID PRIMARY KEY,
  playlist_id       UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  media_id          UUID NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL,
  duration_seconds  INTEGER       -- null = media default (video: full length)
);
CREATE INDEX playlist_items_playlist_idx ON playlist_items (playlist_id, position);

CREATE TABLE screens (
  id            UUID PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  playlist_id   UUID REFERENCES playlists(id) ON DELETE SET NULL,
  last_seen_at  TIMESTAMPTZ,
  last_ip       TEXT,
  user_agent    TEXT,
  now_playing   TEXT,
  player_version TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pairing_requests (
  id           UUID PRIMARY KEY,
  code         TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  screen_id    UUID REFERENCES screens(id) ON DELETE CASCADE,
  device_token TEXT,          -- handed to the player once, then cleared
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pairing_requests_code_idx ON pairing_requests (code);
