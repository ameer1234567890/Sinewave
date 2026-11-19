-- Dashboard accounts. The first super admin is created on boot from ADMIN_PASSWORD (see auth.js).

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT NOT NULL,   -- scrypt$N$r$p$salt$hash
  role           TEXT NOT NULL CHECK (role IN ('super_admin', 'standard')),
  last_login_at  TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
