import path from 'node:path';
import { createRequire } from 'node:module';
import { config } from './config.js';
import { query } from './db.js';

// One version number for the whole app, kept in the player's version.js so the player,
// the dashboard and the server always report the same thing.
export const VERSION = createRequire(import.meta.url)(path.join(config.playerDir, 'version.js'));

/** Whether screens show the version number small in a corner. On unless someone turns it off. */
export function showVersionOnScreens() {
  const { rows } = query("SELECT value FROM settings WHERE key = 'show_version_on_screens'");
  return rows[0]?.value !== 'false';
}

export function setShowVersionOnScreens(on) {
  query(
    `INSERT INTO settings (key, value) VALUES ('show_version_on_screens', $1)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [on ? 'true' : 'false'],
  );
}
